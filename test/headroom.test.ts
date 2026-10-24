import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { codexShimEnv, detectHeadroom, detectHeadroomPython, headroomArgs, headroomEnv, headroomRoute, parseHeadroomVersion, shimPath, type DetectDeps } from '../src/headroom.js';
import { root, type Config } from '../src/config.js';

const profile = (executable?: string): Pick<Config, 'headroom'> => ({ headroom: { enabled: true, port: 18880, version: '0.41.0', codex: false, executable } });
const pyProfile = (python?: string): Pick<Config, 'headroom'> => ({ headroom: { enabled: true, port: 18880, version: '0.41.0', codex: true, python } });
const PY_VERSION = "import importlib.metadata as m; print(m.version('headroom-ai'))";
const banner = (version: string) => `headroom, version ${version}\n`;

test('parseHeadroomVersion reads only the documented version banner', async () => {
  assert.equal(parseHeadroomVersion('headroom, version 0.41.0\n'), '0.41.0');
  assert.equal(parseHeadroomVersion('headroom, version 0.41.0\r\n'), '0.41.0');
  assert.equal(parseHeadroomVersion('headroom, version 0.40.0'), '0.40.0');
  for (const garbage of ['', 'garbage', 'headroom 0.41.0', 'headroom, version 0.41', 'Usage: headroom [OPTIONS]'])
    assert.equal(parseHeadroomVersion(garbage), undefined, garbage);
});

test('headroomArgs builds the exact proxy command for cache mode', async () => {
  assert.deepEqual(headroomArgs(18880, 18877, 'C:/logs/headroom.log'), ['proxy', '--host', '127.0.0.1', '--port', '18880',
    '--mode', 'cache', '--no-ccr', '--no-cache', '--no-rate-limit', '--anthropic-api-url', 'http://127.0.0.1:18877',
    '--log-file', 'C:/logs/headroom.log']);
});

test('headroomArgs adds the Codex gateway only when a Codex port is given', async () => {
  const base = headroomArgs(18880, 18877, 'C:/logs/headroom.log');
  assert.deepEqual(headroomArgs(18880, 18877, 'C:/logs/headroom.log', undefined), base);
  assert.deepEqual(headroomArgs(18880, 18877, 'C:/logs/headroom.log', 18878), [...base, '--openai-api-url', 'http://127.0.0.1:18878/v1']);
});

test('headroomEnv pins Headroom settings, strips inherited ones and never mutates its input', async () => {
  const base = { PATH: '/bin', KEEP: 'x', HEADROOM_LOG_MESSAGES: '1', headroom_mode: 'token', HEADROOM_OFFLINE: '0',
    DO_NOT_TRACK: '0', HF_HUB_OFFLINE: '0' };
  const snapshot = structuredClone(base);
  const env = headroomEnv(base, '/ws');
  assert.deepEqual(base, snapshot);
  assert.notEqual(env, base);
  assert.equal(env.PATH, '/bin'); assert.equal(env.KEEP, 'x');
  assert.equal(env.HEADROOM_LOG_MESSAGES, undefined); assert.equal(env.headroom_mode, undefined);
  assert.equal(env.HEADROOM_OFFLINE, '1'); assert.equal(env.HEADROOM_BEACON, 'off'); assert.equal(env.HEADROOM_TELEMETRY, 'off');
  assert.equal(env.HEADROOM_UPDATE_CHECK, 'off'); assert.equal(env.HEADROOM_LOSSLESS_ONLY, '1');
  assert.equal(env.DO_NOT_TRACK, '1'); assert.equal(env.HF_HUB_OFFLINE, '1');
  assert.equal(env.LITELLM_LOCAL_MODEL_COST_MAP, 'True');
  assert.equal(env.HEADROOM_UPSTREAM_ALLOWED_HOSTS, '127.0.0.1');
  assert.equal(env.HEADROOM_WORKSPACE_DIR, '/ws'); assert.equal(env.HEADROOM_CONFIG_DIR, join('/ws', 'config'));
  assert.equal(env.PYTHONIOENCODING, 'utf-8'); assert.equal(env.PYTHONUTF8, '1');
  assert.deepEqual(Object.keys(env).filter(key => /^HEADROOM_/i.test(key)).sort(),
    ['HEADROOM_BEACON', 'HEADROOM_CONFIG_DIR', 'HEADROOM_LOSSLESS_ONLY', 'HEADROOM_OFFLINE', 'HEADROOM_TELEMETRY', 'HEADROOM_UPDATE_CHECK',
      'HEADROOM_UPSTREAM_ALLOWED_HOSTS', 'HEADROOM_WORKSPACE_DIR']);
});

test('detectHeadroom uses a configured executable without any PATH lookup', async () => {
  const exe = resolve('/opt/headroom');
  const calls: string[][] = [];
  const deps: DetectDeps = { exec: async (file, args) => { calls.push([file, ...args]); return banner('0.41.0'); }, exists: async path => path === exe, env: {}, platform: 'linux' };
  assert.deepEqual(await detectHeadroom(profile(exe), deps), { ok: true, executable: exe, version: '0.41.0' });
  assert.deepEqual(calls, [[exe, '--version']]);
});

test('a configured executable that is missing never falls back to PATH or the uv bin', async () => {
  const exe = resolve('/opt/headroom');
  const calls: string[][] = [];
  // The uv bin and PATH candidates exist, so only the explicit-path rule can explain the failure.
  const exists = async (path: string) => path !== exe;
  const deps: DetectDeps = { exec: async (file, args) => { calls.push([file, ...args]); return banner('0.41.0'); }, exists, env: { HOME: '/home/u' }, platform: 'linux' };
  assert.deepEqual(await detectHeadroom(profile(exe), deps),
    { ok: false, reason: 'Headroom executable not found; install it with uv or set headroom.executable' });
  assert.deepEqual(calls, []);
});

test('detectHeadroom takes the first PATH hit from where.exe on Windows', async () => {
  const first = join('C:\\Tools', 'headroom.exe');
  const calls: string[][] = [];
  const exec: DetectDeps['exec'] = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'where.exe') return `${first}\r\nC:\\other\\headroom.exe\r\n`;
    return banner('0.41.0');
  };
  assert.deepEqual(await detectHeadroom(profile(), { exec, exists: async path => path === first, env: {}, platform: 'win32' }),
    { ok: true, executable: first, version: '0.41.0' });
  assert.deepEqual(calls, [['where.exe', 'headroom.exe'], [first, '--version']]);
});

test('detectHeadroom takes the PATH hit from which on other platforms', async () => {
  const hit = '/usr/local/bin/headroom';
  const calls: string[][] = [];
  const exec: DetectDeps['exec'] = async (file, args) => { calls.push([file, ...args]); return file === 'which' ? `${hit}\n` : banner('0.41.0'); };
  assert.deepEqual(await detectHeadroom(profile(), { exec, exists: async path => path === hit, env: {}, platform: 'linux' }),
    { ok: true, executable: hit, version: '0.41.0' });
  assert.deepEqual(calls, [['which', 'headroom'], [hit, '--version']]);
});

test('detectHeadroom falls back to the uv tool bin when PATH has no hit', async () => {
  const uvWin = join('C:\\Users\\u', '.local', 'bin', 'headroom.exe');
  const uvLinux = join('/home/u', '.local', 'bin', 'headroom');
  const failing: DetectDeps['exec'] = async (file) => { if (file === 'where.exe' || file === 'which') throw new Error('not found'); return banner('0.41.0'); };
  assert.deepEqual(await detectHeadroom(profile(), { exec: failing, exists: async path => path === uvWin, env: { USERPROFILE: 'C:\\Users\\u' }, platform: 'win32' }),
    { ok: true, executable: uvWin, version: '0.41.0' });
  assert.deepEqual(await detectHeadroom(profile(), { exec: failing, exists: async path => path === uvLinux, env: { HOME: '/home/u' }, platform: 'linux' }),
    { ok: true, executable: uvLinux, version: '0.41.0' });
});

test('detectHeadroom reports a missing executable without naming any path', async () => {
  const deps: DetectDeps = { exec: async () => { throw new Error('not found'); }, exists: async () => false, env: { HOME: '/home/u' }, platform: 'linux' };
  assert.deepEqual(await detectHeadroom(profile(), deps),
    { ok: false, reason: 'Headroom executable not found; install it with uv or set headroom.executable' });
});

test('detectHeadroom refuses any version other than the pinned one', async () => {
  const exe = resolve('/opt/headroom');
  const deps: DetectDeps = { exec: async () => banner('0.42.0'), exists: async () => true, env: {}, platform: 'linux' };
  assert.deepEqual(await detectHeadroom(profile(exe), deps),
    { ok: false, reason: 'Headroom 0.42.0 found; this profile requires 0.41.0' });
});

test('detectHeadroom reports an unreadable version without echoing the output', async () => {
  const exe = resolve('/opt/headroom');
  const garbage: DetectDeps = { exec: async () => 'secret-output-value', exists: async () => true, env: {}, platform: 'linux' };
  const failing: DetectDeps = { exec: async () => { throw new Error('boom'); }, exists: async () => true, env: {}, platform: 'linux' };
  for (const deps of [garbage, failing]) {
    const result = await detectHeadroom(profile(exe), deps);
    assert.deepEqual(result, { ok: false, reason: 'Headroom version could not be read' });
    assert.equal(JSON.stringify(result).includes('secret-output-value'), false);
  }
});

test('headroomRoute checks each condition in order and routes only when all hold', async () => {
  const ready = { enabled: true, optOut: false, serviceState: 'ready', upstreamPort: 18877, jevPort: 18877, live: true, port: 18880 };
  assert.deepEqual(headroomRoute(ready), { use: true, baseUrl: 'http://127.0.0.1:18880' });
  assert.deepEqual(headroomRoute({ ...ready, enabled: false }), { use: false, reason: 'Headroom is disabled for this profile' });
  assert.deepEqual(headroomRoute({ ...ready, enabled: false, optOut: true }), { use: false, reason: 'Headroom is disabled for this profile' });
  assert.deepEqual(headroomRoute({ ...ready, optOut: true }), { use: false, reason: 'Headroom bypassed by JMS_HEADROOM=off' });
  assert.deepEqual(headroomRoute({ ...ready, serviceState: 'starting' }), { use: false, reason: 'Headroom service is starting' });
  assert.deepEqual(headroomRoute({ ...ready, serviceState: undefined }), { use: false, reason: 'Headroom service is not running' });
  assert.deepEqual(headroomRoute({ ...ready, upstreamPort: 18878 }), { use: false, reason: 'Headroom forwards to another Jev port; restart the profile' });
  assert.deepEqual(headroomRoute({ ...ready, upstreamPort: undefined }), { use: false, reason: 'Headroom forwards to another Jev port; restart the profile' });
  assert.deepEqual(headroomRoute({ ...ready, live: false }), { use: false, reason: 'Headroom did not answer its health check' });
});

// Fake interpreter world: `existing` paths exist, the uv call answers `uvDir` (or fails), and python reports `version`.
function pythonDeps(existing: string[], options: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; uvDir?: string; version?: string; shim?: boolean } = {}):
  { deps: DetectDeps; calls: string[][] } {
  const calls: string[][] = [];
  const exec: DetectDeps['exec'] = async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'uv') { if (options.uvDir === undefined) throw new Error('uv not found'); return `${options.uvDir}\n`; }
    return `${options.version ?? '0.41.0'}\n`;
  };
  const exists = async (path: string) => existing.includes(path) || (path === shimPath('0.41.0') && options.shim !== false);
  return { deps: { exec, exists, env: options.env ?? {}, platform: options.platform ?? 'win32' }, calls };
}

test('headroomArgs adds nothing for the Codex gateway when it is not configured', async () => {
  assert.equal(headroomArgs(18880, 18877, 'C:/logs/headroom.log').includes('--openai-api-url'), false);
});

test('shimPath points at the versioned shim inside the repository', async () => {
  assert.equal(shimPath('0.41.0'), resolve(root, 'patches/headroom/0.41.0/jms_headroom_shim.py'));
  assert.equal(existsSync(shimPath('0.41.0')), true);
});

test('detectHeadroomPython uses a configured interpreter without any candidate lookup', async () => {
  const configured = resolve('/opt/headroom-python');
  const { deps, calls } = pythonDeps([configured]);
  assert.deepEqual(await detectHeadroomPython(pyProfile(configured), deps), { ok: true, python: configured, version: '0.41.0' });
  assert.deepEqual(calls, [[configured, '-I', '-c', PY_VERSION]]);
});

test('a configured interpreter that is missing never falls back to a uv tool environment', async () => {
  const configured = resolve('/opt/headroom-python');
  const fallback = join('/home/u/.local/share/uv/tools', 'headroom-ai', 'bin', 'python');
  const { deps, calls } = pythonDeps([fallback], { env: { HOME: '/home/u' }, platform: 'linux', uvDir: '/home/u/.local/share/uv/tools' });
  assert.deepEqual(await detectHeadroomPython(pyProfile(configured), deps),
    { ok: false, reason: 'Headroom python not found; install headroom-ai with uv or set headroom.python' });
  assert.deepEqual(calls, []);
});

test('detectHeadroomPython takes UV_TOOL_DIR first, then uv tool dir, then the default tool dir', async () => {
  const fromEnv = join('D:\\envtools', 'headroom-ai', 'Scripts', 'python.exe');
  const fromUv = join('E:\\uvtools', 'headroom-ai', 'Scripts', 'python.exe');
  const fromDefault = join('C:\\Users\\u\\AppData\\Roaming', 'uv', 'tools', 'headroom-ai', 'Scripts', 'python.exe');
  const env = { UV_TOOL_DIR: 'D:\\envtools', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' };
  const all = pythonDeps([fromEnv, fromUv, fromDefault], { env, uvDir: 'E:\\uvtools' });
  assert.deepEqual(await detectHeadroomPython(pyProfile(), all.deps), { ok: true, python: fromEnv, version: '0.41.0' });
  const noEnv = pythonDeps([fromUv, fromDefault], { env, uvDir: 'E:\\uvtools' });
  assert.deepEqual(await detectHeadroomPython(pyProfile(), noEnv.deps), { ok: true, python: fromUv, version: '0.41.0' });
  const onlyDefault = pythonDeps([fromDefault], { env, uvDir: 'E:\\uvtools' });
  assert.deepEqual(await detectHeadroomPython(pyProfile(), onlyDefault.deps), { ok: true, python: fromDefault, version: '0.41.0' });
});

test('detectHeadroomPython finds the default uv tool dir on Linux and honours XDG_DATA_HOME', async () => {
  const xdg = join('/xdg', 'uv', 'tools', 'headroom-ai', 'bin', 'python');
  const home = join('/home/u', '.local', 'share', 'uv', 'tools', 'headroom-ai', 'bin', 'python');
  const withXdg = pythonDeps([xdg], { platform: 'linux', env: { XDG_DATA_HOME: '/xdg', HOME: '/home/u' } });
  assert.deepEqual(await detectHeadroomPython(pyProfile(), withXdg.deps), { ok: true, python: xdg, version: '0.41.0' });
  const withHome = pythonDeps([home], { platform: 'linux', env: { HOME: '/home/u' } });
  assert.deepEqual(await detectHeadroomPython(pyProfile(), withHome.deps), { ok: true, python: home, version: '0.41.0' });
});

test('detectHeadroomPython reports a missing interpreter without naming any path', async () => {
  const { deps } = pythonDeps([], { env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } });
  assert.deepEqual(await detectHeadroomPython(pyProfile(), deps),
    { ok: false, reason: 'Headroom python not found; install headroom-ai with uv or set headroom.python' });
});

test('detectHeadroomPython refuses another Headroom version and an unreadable answer', async () => {
  const py = join('C:\\uv', 'headroom-ai', 'Scripts', 'python.exe');
  const mismatch = pythonDeps([py], { env: { UV_TOOL_DIR: 'C:\\uv' }, version: '0.40.0' });
  assert.deepEqual(await detectHeadroomPython(pyProfile(), mismatch.deps),
    { ok: false, reason: 'Headroom 0.40.0 found; this profile requires 0.41.0' });
  const garbage: DetectDeps = { exec: async (file) => file === 'uv' ? 'C:\\uv\n' : 'secret-output-value', exists: async path => path === py, env: {}, platform: 'win32' };
  const result = await detectHeadroomPython(pyProfile(), garbage);
  assert.deepEqual(result, { ok: false, reason: 'Headroom version could not be read from its python' });
  assert.equal(JSON.stringify(result).includes('secret-output-value'), false);
});

test('detectHeadroomPython refuses a pinned version that has no Codex shim', async () => {
  const configured = resolve('/opt/headroom-python');
  const { deps } = pythonDeps([configured], { version: '0.42.0' });
  const profile042: Pick<Config, 'headroom'> = { headroom: { enabled: true, port: 18880, version: '0.42.0', codex: true, python: configured } };
  assert.deepEqual(await detectHeadroomPython(profile042, deps), { ok: false, reason: 'No Codex patch for Headroom 0.42.0' });
});

test('codexShimEnv points only the Codex base URL at the gateway and copies everything else', async () => {
  const base = { PATH: '/bin', HEADROOM_CHATGPT_CODEX_BASE_URL: 'https://chatgpt.com/backend-api/codex' };
  const snapshot = structuredClone(base);
  assert.deepEqual(codexShimEnv(base, 18878), { PATH: '/bin', HEADROOM_CHATGPT_CODEX_BASE_URL: 'http://127.0.0.1:18878/v1' });
  assert.deepEqual(base, snapshot);
});
