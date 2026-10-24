// Runs the suite's tests with a temporary home, then checks that the real user's Jev and client state did not change.
// Usage: node scripts/test-isolated.mjs [options] [test files...]
//   no files        runs test/*.test.ts (the default for `npm test`)
//   test files      runs only those files, e.g. test/e2e.ts (resolved from the current directory)
//   --concurrency=N, --test-concurrency=N and other --test-* options go to `node --test`
//   --preflight-only  checks the isolation and the sentinels, then exits without running tests
//   --real-uv-tools   lets Headroom tests see the real uv tool environments (read-only, see below)
// On Windows os.homedir() reads USERPROFILE, not HOME, so every variable that can move the home is overridden.
// LOCALAPPDATA and PATH stay real, because some tests look for executables there.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const realHome = resolve(homedir());
const fingerprint = (path) => createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');

// Files and trees a test must never change. Paths are relative to the real home.
const SENTINEL_TREES = ['.jev-gateway', join('.gemini', 'config')];
const SENTINEL_FILES = [join('.gemini', 'antigravity-cli', 'settings.json'), join('.codex', 'config.toml'), join('.claude', 'settings.json')];
// Live gateways append to these logs while the suite runs; growth is expected, anything else is not.
const GROWING_LOGS = /^\.jev-gateway\/(claude|agy)\.log$/;
const LISTENER_PORTS = [...Array.from({ length: 13 }, (_, i) => 8787 + i), 8999];
// The real uv tool environments are watched too, so a Headroom test cannot modify an installed tool.
// Python writes its bytecode cache inside them when a tool first runs; that cache is the only change allowed there.
const UV_TREE_PREFIX = '[uv-tools]/';
const CACHE_FILES = /(^|\/)__pycache__\//;

// Arguments: wrapper options are consumed here; everything else is a test file or a node --test option.
const argv = process.argv.slice(2);
const nodeArgs = [];
const requested = [];
let preflightOnly = false;
let realUvTools = false;
for (const arg of argv) {
  if (arg === '--preflight-only') preflightOnly = true;
  else if (arg === '--real-uv-tools') realUvTools = true;
  else if (arg.startsWith('--concurrency=')) nodeArgs.push(`--test-${arg.slice(2)}`);
  else if (arg.startsWith('-')) nodeArgs.push(arg);
  else requested.push(resolve(process.cwd(), arg));
}

async function walk(dir, keyOf, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, keyOf, out);
    else if (entry.isFile()) {
      const info = await stat(full);
      out.set(keyOf(full), { size: info.size, mtimeMs: info.mtimeMs });
    }
  }
}

const keyIn = (base) => (full) => relative(base, full).split(sep).join('/');

async function snapshot(uvToolsDir) {
  const out = new Map();
  for (const tree of SENTINEL_TREES) await walk(join(realHome, tree), keyIn(realHome), out);
  for (const file of SENTINEL_FILES) {
    try {
      const info = await stat(join(realHome, file));
      out.set(file.split(sep).join('/'), { size: info.size, mtimeMs: info.mtimeMs });
    } catch { /* absent before and after counts as unchanged */ }
  }
  if (uvToolsDir) await walk(uvToolsDir, (full) => UV_TREE_PREFIX + keyIn(uvToolsDir)(full), out);
  return out;
}

function diff(before, after) {
  const problems = [];
  for (const [key, b] of before) {
    const a = after.get(key);
    if (!a) problems.push(`removed ${key}`);
    else if (a.size !== b.size || a.mtimeMs !== b.mtimeMs) {
      if (GROWING_LOGS.test(key) && a.size >= b.size) continue;
      problems.push(`changed ${key} (${b.size} -> ${a.size} bytes)`);
    }
  }
  for (const key of after.keys()) if (!before.has(key)) problems.push(`created ${key}`);
  return problems.filter((problem) => !(problem.includes(UV_TREE_PREFIX) && CACHE_FILES.test(problem)));
}

function listeners() {
  if (process.platform !== 'win32') return null;
  const result = spawnSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return null;
  const found = new Set();
  for (const line of result.stdout.split(/\r?\n/)) {
    const match = /^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/.exec(line);
    if (match && LISTENER_PORTS.includes(Number(match[1]))) found.add(`${match[1]}/${match[2]}`);
  }
  return [...found].sort();
}

// The real uv tool directory is named by UV_TOOL_DIR, not by the real APPDATA, so only the tools become visible.
// A caller that already set UV_TOOL_DIR keeps its value; without APPDATA there is nothing to point at.
const realAppData = process.env.APPDATA;
if (realUvTools && !process.env.UV_TOOL_DIR && !realAppData) {
  console.error('--real-uv-tools needs APPDATA (or UV_TOOL_DIR) in the caller environment; the tests were not run.');
  process.exit(1);
}
const uvToolsDir = realUvTools ? (process.env.UV_TOOL_DIR || join(realAppData, 'uv', 'tools')) : undefined;

const home = await mkdtemp(join(tmpdir(), 'jev-suite-home-'));
const appData = join(home, 'AppData', 'Roaming');
await mkdir(appData, { recursive: true });
const drive = parse(home).root;

const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: appData,
  ...(process.platform === 'win32' ? { HOMEDRIVE: drive.replace(/[\\/]+$/, ''), HOMEPATH: home.slice(drive.length - 1) } : {}),
  ...(uvToolsDir ? { UV_TOOL_DIR: uvToolsDir } : {}),
};
// A client home set in the caller's environment would point at the real one; send it to the temporary home.
if (process.env.CODEX_HOME) env.CODEX_HOME = join(home, '.codex');
if (process.env.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = join(home, '.claude');

let exitCode = 1;
try {
  // Preflight: a child process must see the temporary home, and it must not be the real one.
  const probe = spawnSync(process.execPath, ['-e', 'process.stdout.write(require("os").homedir())'], { env, encoding: 'utf8', windowsHide: true });
  const seen = probe.stdout ?? '';
  if (probe.status !== 0 || resolve(seen) !== resolve(home) || fingerprint(seen) === fingerprint(realHome)) {
    console.error('test isolation check failed: child processes do not see the temporary home; the tests were not run.');
    throw new Error('preflight');
  }

  const before = await snapshot(uvToolsDir);
  const portsBefore = listeners();

  if (preflightOnly) {
    console.log(`isolation preflight ok: child processes see ${home}; ${before.size} real-home sentinel entries tracked${uvToolsDir ? ` and the uv tools at ${uvToolsDir}` : ''}. No tests were run.`);
    process.exitCode = 0;
  } else {
    const files = requested.length > 0
      ? requested
      : (await readdir(join(root, 'test')))
        .filter((name) => name.endsWith('.test.ts'))
        .sort()
        .map((name) => join(root, 'test', name));
    const cli = join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
    const child = spawn(process.execPath, [cli, '--test', ...nodeArgs, ...files], { cwd: root, env, stdio: 'inherit', windowsHide: true });
    exitCode = await new Promise((done) => child.once('exit', (code, signal) => done(signal ? 1 : (code ?? 1))));

    const after = await snapshot(uvToolsDir);
    const problems = diff(before, after);
    const portsAfter = listeners();
    if (portsBefore && portsAfter && portsBefore.join() !== portsAfter.join()) {
      console.warn(`note: listeners on 8787-8799/8999 changed during the run: before [${portsBefore.join(', ')}], after [${portsAfter.join(', ')}]`);
    }
    if (problems.length > 0) {
      console.error('test isolation check failed: the real user state changed during the test run:');
      for (const problem of problems) console.error(`  ${problem}`);
      console.error('Only growth of claude.log and agy.log is expected from live gateways. Find the test that wrote the file and fix it.');
      process.exitCode = 1;
    } else {
      console.log(`isolation: ${after.size} real-home sentinel entries unchanged (claude.log/agy.log growth allowed).`);
      process.exitCode = exitCode;
    }
  }
} catch (error) {
  if (error.message !== 'preflight') throw error;
} finally {
  try {
    await rm(home, { recursive: true, force: true, maxRetries: 5 });
  } catch (error) {
    console.warn(`note: could not remove the temporary test home (${error.code ?? error.message}); it is outside the repository.`);
  }
}
