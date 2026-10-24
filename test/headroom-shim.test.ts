import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkCodexShim, codexShimEnv, detectHeadroomPython, shimPath } from '../src/headroom.js';
import type { Config } from '../src/config.js';

// These run the real shim under Headroom's own interpreter. They skip when that interpreter or version is absent, and never touch the network.
const execFileAsync = promisify(execFile);
const profile: Pick<Config, 'headroom'> = { headroom: { enabled: true, port: 18880, version: '0.41.0', codex: true } };
const found = await detectHeadroomPython(profile);
const skip = found.ok ? false : `Headroom 0.41.0 interpreter not available: ${found.reason}`;
const python = found.ok ? found.python : '';
const SHIM = shimPath('0.41.0');
const GATEWAY_ENV = codexShimEnv(process.env, 18999);

// Runs the shim directly so the exit code itself is observed.
async function runShim(script: string, env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string }> {
  return execFileAsync(python, ['-I', script, '--check'], { env, shell: false, windowsHide: true, timeout: 60_000, encoding: 'utf8' })
    .then(out => ({ code: 0, stdout: out.stdout }), (err: { code?: unknown; stdout?: string }) =>
      ({ code: typeof err.code === 'number' ? err.code : -1, stdout: err.stdout ?? '' }));
}

test('the real shim routes every Codex URL to the loopback gateway and blocks external egress', { skip }, async () => {
  const result = await checkCodexShim(python, '0.41.0', GATEWAY_ENV);
  assert.equal(result.ok, true, result.reason);
  const report = result.report as { headroomVersion: string; urls: Record<string, string>; allowedStringHits: string[]; guard: Record<string, boolean>; redactedHeaders: string[] };
  assert.equal(report.headroomVersion, '0.41.0');
  // Headroom's own wire-debug redaction is extended with the account id, so its request log cannot carry it in clear text.
  assert.deepEqual(report.redactedHeaders, ['chatgpt-account-id']);
  assert.deepEqual(report.urls, {
    responses: 'http://127.0.0.1:18999/v1/responses',
    responsesCompact: 'http://127.0.0.1:18999/v1/responses/compact',
    responsesWs: 'ws://127.0.0.1:18999/v1/responses',
    models: 'http://127.0.0.1:18999/v1/models?client_version=x',
    passthrough: 'http://127.0.0.1:18999',
  });
  for (const url of Object.values(report.urls)) assert.doesNotMatch(url, /chatgpt\.com/);
  assert.deepEqual(report.guard, { externalBlocked: true, loopbackAllowed: true });
  for (const hit of report.allowedStringHits) assert.match(hit, /^headroom\.subscription\.codex_rate_limits:/);
});

test('the shim refuses every base that is not the exact loopback /v1 gateway', { skip }, async () => {
  const bad = ['https://127.0.0.1:1/v1', 'http://example.com:80/v1', 'http://127.0.0.1:80/v2', 'http://127.0.0.1:18999/v1?x=1',
    'http://user@127.0.0.1:18999/v1', 'http://127.0.0.1:18999/v1/', 'http://127.0.0.1:18999'];
  for (const base of bad) {
    const result = await runShim(SHIM, { ...process.env, HEADROOM_CHATGPT_CODEX_BASE_URL: base });
    assert.notEqual(result.code, 0, base);
    assert.equal(result.code, 2, base);
  }
  const missing = { ...process.env };
  delete missing.HEADROOM_CHATGPT_CODEX_BASE_URL;
  assert.equal((await runShim(SHIM, missing)).code, 2);
});

test('the shim exits 3 when the installed Headroom is not the version it was written for', { skip }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'jms-shim-'));
  try {
    const source = await readFile(SHIM, 'utf8');
    const copy = source.replace('SUPPORTED_VERSION = "0.41.0"', 'SUPPORTED_VERSION = "0.0.1"');
    assert.notEqual(copy, source);
    const file = join(dir, 'jms_headroom_shim.py');
    await writeFile(file, copy);
    assert.equal((await runShim(file, GATEWAY_ENV)).code, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
