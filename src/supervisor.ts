import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { prepare, profileDir, readConfig, root } from './config.js';
import { baseEnv, token, sleep } from './local.js';
import { memoryBinary, gatewayDir, initMemory } from './install.js';
import { ensureLocalModel } from './models.js';
import { createServer as netServer } from 'node:net';
import { startDashboard } from './dashboard.js';
import { upstreamGateways } from './gateways.js';
import { checkCodexShim, codexShimEnv, detectHeadroom, detectHeadroomPython, headroomArgs, headroomEnv, shimPath } from './headroom.js';

export async function freePort(port: number): Promise<void> {
  await new Promise<void>((ok, fail) => {
    const s = netServer(); s.once('error', fail); s.listen(port, '127.0.0.1', () => s.close(e => e ? fail(e) : ok()));
  });
}
// Pure: the per-line redaction every child's log goes through. Known secrets first, then bearer and key forms (unchanged),
// then ChatGPT account ids in JSON or header form. The account id is not a bearer token, so Headroom's own request log
// carries it in clear text; this is defense in depth beside the proxy-side redaction.
export function redactLogLine(line: string, secrets: readonly string[]): string {
  let out = line;
  for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
  return out.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]')
    .replace(/(chatgpt-account-id["']?\s*[:=]\s*["']?)[^"'\s,;}\]]+/gi, '$1[REDACTED]');
}
// Restarts are bounded: at most one per backoff step within the window, each waiting longer than the last.
export const RESTART_WINDOW_MS = 60_000;
export const RESTART_BACKOFF_MS = [1000, 2000, 4000];
/** Delay before restarting after an unexpected exit, or undefined when the budget is spent. `history` holds earlier restart times in ms. */
export function restartDelay(history: number[], now: number): number | undefined {
  const recent = history.filter(at => now - at < RESTART_WINDOW_MS).length;
  return recent < RESTART_BACKOFF_MS.length ? RESTART_BACKOFF_MS[recent] : undefined;
}
// What the supervisor needs to start a child again after it exits unexpectedly.
// An optional service (Headroom) that fails changes only its own state; memory and the supervisor keep running.
interface Service { name: string; command: string; args: string[]; env: NodeJS.ProcessEnv; port: number; path: string; optional?: boolean; cwd?: string }

// Lifecycle lines go to the supervisor's stderr, which the launcher appends to supervisor.log. They carry no secrets.
const note = (msg: string) => console.error(`${new Date().toISOString()} ${msg}`);

async function main(name: string) {
  const c = await readConfig(name), dir = profileDir(name), key = await token(dir), routerKey = await token(dir, 'router-token');
  const children = new Map<string, ChildProcess>();
  const restartTimes = new Map<string, number[]>();
  const optionalServices = new Set<string>();
  const secrets = [key, routerKey, process.env[c.gateway.jevKeyEnv], process.env[c.gateway.upstreamKeyEnv]].filter((s): s is string => !!s);
  const state: {
    phase: string; services: Record<string, string>; restarts: Record<string, number>; pid: number;
    headroom?: { port: number; upstreamPort: number; version: string; codex: boolean; codexUpstreamPort?: number }; headroomReason?: string; headroomCodexReason?: string;
  } = { phase: 'starting', services: {}, restarts: {}, pid: process.pid };
  let stopping = false;
  let dashboard: Server | undefined;
  const server = createServer((req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? ''), want = Buffer.from(`Bearer ${key}`);
    if (req.headers.host !== `127.0.0.1:${c.controlPort}` || auth.length !== want.length || !timingSafeEqual(auth, want)) {
      res.writeHead(401).end(); return;
    }
    if (req.url === '/status' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state));
    } else if (req.url === '/stop' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"stopping":true}');
      void shutdown('control /stop');
    } else res.writeHead(404).end();
  });
  async function shutdown(reason: string) {
    if (stopping) return; stopping = true; state.phase = 'stopping';
    note(`supervisor stopping: ${reason}`);
    dashboard?.closeAllConnections(); dashboard?.close();
    await Promise.all([...children.values()].map(child => new Promise<void>(done => {
      // A child ended by a signal has no exit code, so its signal code counts as exited too.
      if (child.exitCode !== null || child.signalCode !== null) return done();
      child.once('exit', () => done()); child.kill('SIGTERM');
      const timeout = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); done(); }, 6000);
      timeout.unref();
    })));
    server.close(() => { note('supervisor stopped'); process.exit(0); }); server.closeAllConnections();
  }
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(c.controlPort, '127.0.0.1', ok); });
  note(`supervisor ${name} started pid=${process.pid} ppid=${process.ppid}`);
  // SIGHUP and SIGBREAK are the Windows console close and Ctrl-Break events; they take the same graceful path.
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) process.on(signal, () => void shutdown(signal));
  function launch(service: Service) {
    const { name: serviceName, command, args, env } = service;
    if (service.optional) optionalServices.add(serviceName);
    const log = createWriteStream(resolve(dir, `logs/${serviceName}.log`), { flags: 'a', mode: 0o600 });
    let bytes = 0;
    const child = spawn(command, args, { cwd: service.cwd ?? root, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    children.set(serviceName, child); state.services[serviceName] = 'starting';
    // Bounded logs, with known secrets and common bearer/key forms removed.
    let pending = '';
    const emit = (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      while (pending.includes('\n') || pending.length > 16384) {
        const end = pending.includes('\n') ? pending.indexOf('\n') + 1 : pending.length;
        let line = pending.slice(0, end); pending = pending.slice(end);
        line = redactLogLine(line, secrets);
        bytes += Buffer.byteLength(line); if (bytes < 5_000_000) log.write(line);
      }
    };
    child.stdout?.on('data', emit); child.stderr?.on('data', emit);
    child.once('error', () => {
      // A child replaced by a later launch of the same service no longer owns its state.
      if (children.get(serviceName) !== child) return;
      state.services[serviceName] = 'failed';
      if (!service.optional) state.phase = 'failed';
    });
    child.once('exit', (code, signal) => {
      log.end();
      if (children.get(serviceName) !== child) return;
      // Only a child that was ready can be restarted; one that dies while starting fails the supervisor as before.
      const wasReady = state.services[serviceName] === 'ready';
      state.services[serviceName] = 'stopped';
      if (stopping) return;
      note(`service ${serviceName} exited code=${code} signal=${signal}`);
      if (wasReady) void restart(service);
      else if (service.optional) state.services[serviceName] = 'failed';
      else state.phase = 'failed';
    });
  }
  async function health(service: string, port: number, path: string) {
    for (let i = 0; i < 140; i++) {
      // A child whose own state is failed or stopped can never become ready, so polling stops at once.
      if (stopping || state.phase === 'failed' || ['failed', 'stopped'].includes(state.services[service] ?? '')) throw new Error('Child failed during startup');
      try { const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(500), redirect: 'error' });
        if (r.ok) { state.services[service] = 'ready'; return; }
      } catch { /* Bound startup polling. */ }
      await sleep(250);
    }
    throw new Error('Child health timeout');
  }
  // Ends the supervisor's failure path: visible briefly, then owned children are stopped.
  function failService(service: string) {
    if (stopping) return;
    if (optionalServices.has(service)) {
      // The optional child is stopped too, so a process that never answered health does not keep its port.
      state.services[service] = 'failed'; children.get(service)?.kill();
      console.error(`Optional service ${service} failed; memory keeps running. Inspect profile logs and run doctor.`);
      return;
    }
    state.services[service] = 'failed'; state.phase = 'failed';
    console.error('Service restart failed. Inspect profile logs and run doctor.');
    setTimeout(() => void shutdown(`service failure: ${service}`), 2500);
  }
  // Relaunches a ready child after its unexpected exit. The port is re-checked, so a foreign listener fails the restart instead of looping.
  async function restart(service: Service) {
    const { name: serviceName, port } = service, now = Date.now(), history = restartTimes.get(serviceName) ?? [];
    const delay = restartDelay(history, now);
    if (delay === undefined) return failService(serviceName);
    restartTimes.set(serviceName, [...history, now]);
    state.restarts[serviceName] = (state.restarts[serviceName] ?? 0) + 1; state.services[serviceName] = 'restarting';
    await sleep(delay);
    if (stopping) return;
    try {
      await freePort(port);
      if (stopping) return;
      launch(service);
      await health(serviceName, port, service.path);
    } catch { failService(serviceName); }
  }
  // Dashboard failure is reported as a service state; it must not take memory or the supervisor down.
  async function startSuiteDashboard() {
    try {
      await freePort(c.dashboard.port);
      const server = await startDashboard(name);
      if (stopping) { server.close(); return; }
      dashboard = server; state.services.dashboard = 'ready';
    } catch {
      state.services.dashboard = 'failed';
    }
  }
  // Codex routing is a mode of the same optional service; the caller falls back to Claude-only mode on any prerequisite failure.
  async function codexHeadroom(jevPort: number, workspace: string, logFile: string):
    Promise<{ ok: true; command: string; args: string[]; env: NodeJS.ProcessEnv; codexUpstreamPort: number } | { ok: false; reason: string }> {
    try {
      const codexUpstreamPort = (await upstreamGateways()).find(gateway => gateway.client === 'codex')?.port;
      if (codexUpstreamPort === undefined) return { ok: false, reason: 'Jev codex gateway port is unknown' };
      const python = await detectHeadroomPython(c);
      if (!python.ok) return { ok: false, reason: python.reason };
      const env = codexShimEnv(headroomEnv(baseEnv(), workspace), codexUpstreamPort);
      const check = await checkCodexShim(python.python, c.headroom.version, env);
      if (!check.ok) return { ok: false, reason: check.reason ?? 'Codex shim check failed' };
      return {
        ok: true, command: python.python, env, codexUpstreamPort,
        args: ['-I', shimPath(c.headroom.version), ...headroomArgs(c.headroom.port, jevPort, logFile, codexUpstreamPort)]
      };
    } catch { return { ok: false, reason: 'Codex shim check failed' }; }
  }
  // Stops one optional child and waits for its exit, so its port can be reused; a child that ignores SIGTERM is killed.
  async function stopService(serviceName: string) {
    const child = children.get(serviceName);
    if (child === undefined || child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>(done => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 3000);
      child.once('exit', () => { clearTimeout(timer); done(); });
      child.kill('SIGTERM');
    });
  }
  // A stopped child can keep its port for a moment, so the port is retried briefly before Claude-only mode relaunches on it.
  async function portFree(port: number): Promise<boolean> {
    for (let i = 0; i < 10; i++) {
      try { await freePort(port); return true; }
      catch { await sleep(300); }
    }
    return false;
  }
  // Headroom is optional: every failure becomes a service state and a reason, never a supervisor failure.
  async function startHeadroom() {
    try {
      const detection = await detectHeadroom(c);
      if (!detection.ok) { state.services.headroom = 'unavailable'; state.headroomReason = detection.reason; return; }
      // The proxy forwards to the Jev claude gateway, whose port the launcher reports through the supervisor env.
      const jevPort = (await upstreamGateways()).find(gateway => gateway.client === 'claude')?.port;
      if (jevPort === undefined) { state.services.headroom = 'unavailable'; state.headroomReason = 'Jev claude gateway port is unknown'; return; }
      try { await freePort(c.headroom.port); }
      catch { state.services.headroom = 'failed'; state.headroomReason = 'Headroom port is in use'; return; }
      if (stopping) return;
      const workspace = resolve(dir, 'headroom');
      await prepare(workspace);
      const logFile = resolve(dir, 'logs/headroom-requests.jsonl');
      const codex = c.headroom.codex ? await codexHeadroom(jevPort, workspace, logFile) : undefined;
      if (codex !== undefined && stopping) return;
      if (codex?.ok) {
        launch({ name: 'headroom', command: codex.command, args: codex.args, env: codex.env, port: c.headroom.port, path: '/livez', optional: true, cwd: workspace });
        try {
          await health('headroom', c.headroom.port, '/livez');
          state.headroom = { port: c.headroom.port, upstreamPort: jevPort, version: detection.version, codex: true, codexUpstreamPort: codex.codexUpstreamPort };
          return;
        } catch {
          // Codex mode never became healthy: its child is stopped and its port freed, then Claude-only mode starts as it does without Codex.
          await stopService('headroom');
          if (stopping) return;
          if (!await portFree(c.headroom.port)) { state.services.headroom = 'failed'; state.headroomReason = 'Headroom port is in use'; return; }
          if (stopping) return;
          state.headroomCodexReason = 'Headroom Codex mode did not become healthy';
        }
      } else if (codex !== undefined) state.headroomCodexReason = codex.reason;
      launch({
        name: 'headroom', command: detection.executable, args: headroomArgs(c.headroom.port, jevPort, logFile),
        env: headroomEnv(baseEnv(), workspace), port: c.headroom.port, path: '/livez', optional: true, cwd: workspace
      });
      await health('headroom', c.headroom.port, '/livez');
      state.headroom = { port: c.headroom.port, upstreamPort: jevPort, version: detection.version, codex: false };
    } catch {
      state.services.headroom = 'failed'; state.headroomReason = 'Headroom did not become healthy';
      children.get('headroom')?.kill();
    }
  }
  try {
    if (c.memory.enabled) {
      await freePort(c.memory.port); await initMemory(dir, c.memory.semanticSearch);
      // Local embeddings need the model in the profile before serve; a verification failure propagates to the startup catch.
      if (c.memory.semanticSearch) await ensureLocalModel(resolve(dir, 'memory'));
      launch({ name: 'memory', command: memoryBinary(), args: ['--data-dir', resolve(dir, 'memory'), 'serve', '--transport', 'http', '--bind', `127.0.0.1:${c.memory.port}`, '--workspace', c.workspace, '--project', c.project], env: baseEnv(), port: c.memory.port, path: '/healthz' });
      await health('memory', c.memory.port, '/healthz');
      await startSuiteDashboard();
    }
    if (c.gateway.enabled) {
      await freePort(c.gateway.port);
      const env = baseEnv();
      Object.assign(env, {
        HOST: '127.0.0.1', PORT: String(c.gateway.port), UPSTREAM_BASE_URL: c.gateway.upstreamUrl,
        UPSTREAM_API_KEY: process.env[c.gateway.upstreamKeyEnv], ROUTER_API_KEY: routerKey,
        JEV_PROVIDER: 'typesafe', TYPESAFE_API_KEY: process.env[c.gateway.jevKeyEnv],
        JEV_URL: c.gateway.jevUrl, JEV_ROUTING: 'true', JEV_SHADOW: 'false', JEV_CLIENT: 'jev-memory-suite'
      });
      launch({ name: 'gateway', command: process.execPath, args: [resolve(gatewayDir(), 'dist/index.js')], env, port: c.gateway.port, path: '/health' });
      await health('gateway', c.gateway.port, '/health');
    }
    if (!stopping) state.phase = 'ready';
    // Headroom starts after the mandatory services are ready, so its startup can never delay or fail memory.
    if (c.headroom.enabled && !stopping) { state.services.headroom = 'starting'; void startHeadroom(); }
  } catch {
    state.phase = 'failed'; console.error('Service startup failed. Inspect profile logs and run doctor.');
    // Failure is observable briefly, then owned children are cleaned up.
    setTimeout(() => void shutdown('service startup failed'), 2500);
  }
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/supervisor.js')) {
  main(process.argv[2] ?? '').catch(() => { console.error('Supervisor initialization failed'); process.exitCode = 1; });
}
