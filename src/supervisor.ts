import { createServer } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { profileDir, readConfig, root } from './config.js';
import { baseEnv, token, sleep } from './local.js';
import { memoryBinary, gatewayDir, initMemory } from './install.js';
import { createServer as netServer } from 'node:net';

export async function freePort(port: number): Promise<void> {
  await new Promise<void>((ok, fail) => {
    const s = netServer(); s.once('error', fail); s.listen(port, '127.0.0.1', () => s.close(e => e ? fail(e) : ok()));
  });
}
async function main(name: string) {
  const c = await readConfig(name), dir = profileDir(name), key = await token(dir), routerKey = await token(dir, 'router-token');
  const children = new Map<string, ChildProcess>();
  const secrets = [key, routerKey, process.env[c.gateway.jevKeyEnv], process.env[c.gateway.upstreamKeyEnv]].filter((s): s is string => !!s);
  const state: { phase: string; services: Record<string, string>; pid: number } = { phase: 'starting', services: {}, pid: process.pid };
  let stopping = false;
  const server = createServer((req, res) => {
    const auth = Buffer.from(req.headers.authorization ?? ''), want = Buffer.from(`Bearer ${key}`);
    if (req.headers.host !== `127.0.0.1:${c.controlPort}` || auth.length !== want.length || !timingSafeEqual(auth, want)) {
      res.writeHead(401).end(); return;
    }
    if (req.url === '/status' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(state));
    } else if (req.url === '/stop' && req.method === 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"stopping":true}');
      void shutdown();
    } else res.writeHead(404).end();
  });
  async function shutdown() {
    if (stopping) return; stopping = true; state.phase = 'stopping';
    await Promise.all([...children.values()].map(child => new Promise<void>(done => {
      if (child.exitCode !== null) return done();
      child.once('exit', () => done()); child.kill('SIGTERM');
      const timeout = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); done(); }, 6000);
      timeout.unref();
    })));
    server.close(() => process.exit(0)); server.closeAllConnections();
  }
  await new Promise<void>((ok, fail) => { server.once('error', fail); server.listen(c.controlPort, '127.0.0.1', ok); });
  process.on('SIGINT', () => void shutdown()); process.on('SIGTERM', () => void shutdown());
  function launch(service: string, command: string, args: string[], env: NodeJS.ProcessEnv) {
    const log = createWriteStream(resolve(dir, `logs/${service}.log`), { flags: 'a', mode: 0o600 });
    let bytes = 0;
    const child = spawn(command, args, { cwd: root, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    children.set(service, child); state.services[service] = 'starting';
    // Bounded logs, with known secrets and common bearer/key forms removed.
    let pending = '';
    const emit = (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      while (pending.includes('\n') || pending.length > 16384) {
        const end = pending.includes('\n') ? pending.indexOf('\n') + 1 : pending.length;
        let line = pending.slice(0, end); pending = pending.slice(end);
        for (const secret of secrets) line = line.split(secret).join('[REDACTED]');
        line = line.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').replace(/\bsk-[a-zA-Z0-9_-]+/g, '[REDACTED]');
        bytes += Buffer.byteLength(line); if (bytes < 5_000_000) log.write(line);
      }
    };
    child.stdout?.on('data', emit); child.stderr?.on('data', emit);
    child.once('error', () => { state.phase = 'failed'; state.services[service] = 'failed'; });
    child.once('exit', () => { state.services[service] = 'stopped'; if (!stopping) state.phase = 'failed'; log.end(); });
  }
  async function health(service: string, port: number, path: string) {
    for (let i = 0; i < 140; i++) {
      if (stopping || state.phase === 'failed') throw new Error('Child failed during startup');
      try { const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(500), redirect: 'error' });
        if (r.ok) { state.services[service] = 'ready'; return; }
      } catch { /* Bound startup polling. */ }
      await sleep(250);
    }
    throw new Error('Child health timeout');
  }
  try {
    if (c.memory.enabled) {
      await freePort(c.memory.port); await initMemory(dir);
      launch('memory', memoryBinary(), ['--data-dir', resolve(dir, 'memory'), 'serve', '--transport', 'http', '--bind', `127.0.0.1:${c.memory.port}`, '--workspace', c.workspace, '--project', c.project], baseEnv());
      await health('memory', c.memory.port, '/healthz');
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
      launch('gateway', process.execPath, [resolve(gatewayDir(), 'dist/index.js')], env);
      await health('gateway', c.gateway.port, '/health');
    }
    if (!stopping) state.phase = 'ready';
  } catch {
    state.phase = 'failed'; console.error('Service startup failed. Inspect profile logs and run doctor.');
    // Failure is observable briefly, then owned children are cleaned up.
    setTimeout(() => void shutdown(), 2500);
  }
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/supervisor.js')) {
  main(process.argv[2] ?? '').catch(() => { console.error('Supervisor initialization failed'); process.exitCode = 1; });
}
