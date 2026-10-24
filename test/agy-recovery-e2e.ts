import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { profileDir, readConfig, root } from '../src/config.js';
import { recordLaunchSession } from '../src/hook.js';
import { init } from '../src/lifecycle.js';
import { recoverAgyLaunches, runAgyLaunch } from '../src/launch.js';

// Windows only, not part of npm test: run with `npx tsx --test test/agy-recovery-e2e.ts`.
// This file also serves as the child roles: `harness` runs the real launcher code inside a new console window,
// and `fake-agy` stands in for agy by recording one conversation and sleeping. Nothing touches the real profile or any service.
const self = resolve(root, 'test', 'agy-recovery-e2e.ts');
const execFileAsync = promisify(execFile);
const role = process.argv[2];

if (role === 'fake-agy') {
  const [profilePath, markerDir] = process.argv.slice(3);
  if (!profilePath || !markerDir) throw new Error('fake-agy needs a profile dir and a marker dir');
  await recordLaunchSession(profilePath, process.env.JEV_MEMORY_AGY_LAUNCH ?? '', 'e2e-session-1');
  await writeFile(join(markerDir, 'agy.pid'), String(process.pid));
  setInterval(() => undefined, 1 << 30); // Sleeps until the console closes or it is killed.
} else if (role === 'harness') {
  const [name, markerDir] = process.argv.slice(3);
  if (!name || !markerDir) throw new Error('harness needs a profile name and a marker dir');
  await runAgyLaunch(name, await readConfig(name), markerDir, process.execPath, ['--import', 'tsx', self, 'fake-agy', profileDir(name), markerDir], {
    route: async () => ({ reason: 'e2e harness: gateway not used' }),
    finalize: async (_name, scoped, id, cwd) => {
      await writeFile(join(markerDir, `finalized-${id}.json`), JSON.stringify({ pid: process.pid, workspace: scoped.workspace, project: scoped.project, cwd }));
      return 'ok';
    },
  });
} else {
  const windows = process.platform === 'win32';
  const skip = windows ? false : 'Windows console only';
  const processAlive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
  async function waitFor<T>(read: () => Promise<T | undefined>, what: string, ms = 30_000): Promise<T> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = await read();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise(ok => setTimeout(ok, 200));
    }
  }
  const waitGone = (pid: number): Promise<void> => waitFor(async () => processAlive(pid) ? undefined : true, `pid ${pid} to exit`).then(() => undefined);
  const readPid = (file: string) => readFile(file, 'utf8').then(text => Number(text.trim()), () => undefined);
  async function makeProfile(t: TestContext): Promise<{ name: string; dir: string }> {
    const name = `agy-e2e-${randomBytes(3).toString('hex')}`;
    await init(name);
    t.after(() => rm(profileDir(name), { recursive: true, force: true }));
    const base = resolve(root, '.local', 'tmp');
    await mkdir(base, { recursive: true });
    const dir = await realpath(await mkdtemp(join(base, 'agy-e2e-')));
    t.after(() => rm(dir, { recursive: true, force: true }));
    return { name, dir };
  }
  // Starts the harness in a new console window and returns its pid, which owns that console.
  async function startConsoleHarness(name: string, dir: string): Promise<number> {
    const script = `$p = Start-Process -FilePath '${process.execPath}' -ArgumentList @('--import','tsx','${self}','harness','${name}','${dir}') -WorkingDirectory '${root}' -PassThru; $p.Id`;
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    return Number(stdout.trim());
  }
  const launchDirOf = (name: string): string => join(profileDir(name), 'launch', 'agy');
  const listLaunch = async (name: string): Promise<string[]> => (await readdir(launchDirOf(name)).catch(() => [])).sort();

  test('closing the console finalizes the launch on the SIGHUP path before the wrapper exits', { skip, timeout: 120_000 }, async t => {
    const { name, dir } = await makeProfile(t);
    const harness = await startConsoleHarness(name, dir);
    const agy = await waitFor(() => readPid(join(dir, 'agy.pid')), 'the fake agy to start');
    t.after(async () => { for (const pid of [harness, agy]) await execFileAsync('taskkill', ['/PID', String(pid), '/F']).catch(() => undefined); });
    assert.ok(processAlive(harness));
    // Without /F, taskkill closes the console window; Node reports that as SIGHUP.
    await execFileAsync('taskkill', ['/PID', String(harness)]);
    await waitGone(harness);
    await waitGone(agy);
    const marker = JSON.parse(await readFile(join(dir, 'finalized-e2e-session-1.json'), 'utf8')) as { pid: number; cwd: string; workspace: string };
    assert.equal(marker.pid, harness);
    assert.equal(marker.cwd, dir);
    assert.equal(marker.workspace, (await readConfig(name)).workspace);
    assert.deepEqual(await listLaunch(name), []);
  });

  test('a hard kill leaves records that the next launch recovers', { skip, timeout: 120_000 }, async t => {
    const { name, dir } = await makeProfile(t);
    const harness = await startConsoleHarness(name, dir);
    const agy = await waitFor(() => readPid(join(dir, 'agy.pid')), 'the fake agy to start');
    t.after(async () => { for (const pid of [harness, agy]) await execFileAsync('taskkill', ['/PID', String(pid), '/F']).catch(() => undefined); });
    await execFileAsync('taskkill', ['/PID', String(harness), '/F']);
    // The fake agy may already be gone with its console; only a survivor needs the hard kill.
    if (processAlive(agy)) await execFileAsync('taskkill', ['/PID', String(agy), '/F']);
    await waitGone(harness);
    await waitGone(agy);
    const left = await listLaunch(name);
    assert.equal(left.length, 2, `expected owner and sessions, found ${left.join(', ')}`);
    assert.deepEqual(await readdir(dir).then(files => files.filter(file => file.startsWith('finalized-'))), []);

    const finalized: string[] = [];
    const report = await recoverAgyLaunches(name, {
      config: await readConfig(name), cwd: dir,
      finalize: async (_name, scoped, id, cwd) => { finalized.push(`${id}|${scoped.workspace}|${cwd}`); return 'ok'; },
      warn: () => undefined,
    });
    assert.deepEqual(report.recovered, ['e2e-session-1']);
    assert.deepEqual(report.skipped, []);
    assert.deepEqual(finalized, [`e2e-session-1|${(await readConfig(name)).workspace}|${dir}`]);
    assert.deepEqual(await listLaunch(name), []);
  });
}
