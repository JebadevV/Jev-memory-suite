import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, symlink } from 'node:fs/promises';
import { root, workspaceDir } from '../src/config.js';
import { nativeHook, parseHookPayload, recordActiveSession, hookErrorLine, ACTIVE_SESSION_FILE } from '../src/hook.js';
const sessionStart = { session_id: 'sess-1', cwd: root };
const localDir = resolve(root, '.local');
async function scratchDir(): Promise<string> {
  await mkdir(localDir, { recursive: true });
  return mkdtemp(resolve(localDir, 'hook-test-'));
}
test('workspaceDir accepts the workspace root itself and a fresh descendant', async () => {
  const dir = await scratchDir();
  try {
    assert.equal(await workspaceDir(root), await realpath(root));
    assert.equal(await workspaceDir(dir), await realpath(dir));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('workspaceDir rejects a parent-directory escape', async () => {
  await assert.rejects(workspaceDir(resolve(root, '..')), /Path escapes its workspace boundary/);
});
test('workspaceDir rejects a non-existent path', async () => {
  await assert.rejects(workspaceDir(resolve(localDir, `missing-${Date.now()}`)), /ENOENT/);
});
test('workspaceDir rejects a junction inside .local that points at docs', async () => {
  const dir = await scratchDir();
  const link = resolve(dir, 'link');
  try {
    await symlink(resolve(root, 'docs'), link, 'junction');
    await assert.rejects(workspaceDir(link), /Symlink\/junction not allowed in managed paths/);
  } finally {
    await rmdir(link).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});
test('parseHookPayload rejects an unknown agent', async () => {
  await assert.rejects(parseHookPayload('unknown-agent', 'session-start', sessionStart), /Untrusted hook agent\/event/);
});
test('parseHookPayload rejects an unknown event', async () => {
  await assert.rejects(parseHookPayload('codex', 'bogus-event', sessionStart), /Untrusted hook agent\/event/);
});
test('parseHookPayload rejects a hook_event_name that mismatches the event', async () => {
  await assert.rejects(parseHookPayload('codex', 'session-start', { ...sessionStart, hook_event_name: 'PostToolUse', tool_name: 'Bash' }), /Hook event mismatch/);
});
test('parseHookPayload requires a prompt for user-prompt events', async () => {
  await assert.rejects(parseHookPayload('codex', 'user-prompt', sessionStart), /prompt/);
});
test('parseHookPayload rejects session ids with disallowed characters', async () => {
  await assert.rejects(parseHookPayload('codex', 'session-start', { session_id: 'bad id!', cwd: root }));
});
test('parseHookPayload rejects payloads nested deeper than 32 levels', async () => {
  let nested: unknown = {};
  for (let i = 0; i < 40; i++) nested = { a: nested };
  await assert.rejects(parseHookPayload('codex', 'post-tool-use', { session_id: 'sess-1', cwd: root, tool_name: 'Bash', tool_input: nested }), /nesting too deep/);
});
test('parseHookPayload keeps unknown native fields and drops transcript_path', async () => {
  const result = await parseHookPayload('claude-code', 'post-tool-use', {
    session_id: 'sess-1', cwd: root, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'ls' }, tool_response: { ok: true }, transcript_path: 'C:/secret.jsonl', native_extra: 1
  });
  assert.equal(result.native_extra, 1);
  assert.equal('transcript_path' in result, false);
  assert.equal(result.cwd, await realpath(root));
});
test('nativeHook validates the payload before reading any profile config', async () => {
  await assert.rejects(nativeHook('no-such-profile', 'codex', 'user-prompt', sessionStart), /prompt/);
});
test('recordActiveSession writes only the session id and leaves no temp file behind', async () => {
  const dir = await scratchDir();
  try {
    await recordActiveSession(dir, 'sess-42');
    assert.equal(await readFile(resolve(dir, ACTIVE_SESSION_FILE), 'utf8'), 'sess-42');
    assert.deepEqual((await readdir(dir)).filter(n => n.endsWith('.tmp')), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('recordActiveSession replaces the previous session id', async () => {
  const dir = await scratchDir();
  try {
    await recordActiveSession(dir, 'sess-old');
    await recordActiveSession(dir, 'sess-new');
    assert.equal(await readFile(resolve(dir, ACTIVE_SESSION_FILE), 'utf8'), 'sess-new');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('recordActiveSession swallows write failures so capture is never blocked', async () => {
  await assert.doesNotReject(recordActiveSession(resolve(localDir, `missing-dir-${Date.now()}`), 'sess-1'));
});
test('parseHookPayload accepts Codex null values for every optional field', async () => {
  const result = await parseHookPayload('codex', 'post-tool-use', {
    session_id: 'sess-1', cwd: root, hook_event_name: null, tool_name: 'shell', tool_input: {}, tool_response: {},
    transcript_path: null, model: null, permission_mode: null, tool_use_id: null
  });
  assert.equal(result.cwd, await realpath(root));
  assert.equal('transcript_path' in result, false);
});
test('parseHookPayload accepts null source and reason on lifecycle events', async () => {
  await assert.doesNotReject(parseHookPayload('codex', 'session-start', { ...sessionStart, source: null }));
  await assert.doesNotReject(parseHookPayload('codex', 'session-end', { ...sessionStart, reason: null }));
});
test('parseHookPayload still rejects a missing session_id even when optional fields are null', async () => {
  await assert.rejects(parseHookPayload('codex', 'session-start', { cwd: root, model: null }), /session_id/);
});
test('hookErrorLine lists zod issue paths and codes but never payload values', async () => {
  const secret = 'TOPSECRET-SENTINEL-42';
  const error = await parseHookPayload('codex', 'session-start', { session_id: 'bad id!', cwd: root, model: secret, transcript_path: 42, tool_input: { secret } })
    .then(() => undefined, (caught: unknown) => caught);
  const line = hookErrorLine('codex', 'session-start', error, new Date('2026-01-02T03:04:05.000Z'));
  assert.match(line, /^2026-01-02T03:04:05\.000Z agent=codex event=session-start error=/);
  assert.match(line, /transcript_path:invalid_type/);
  assert.match(line, /session_id:/);
  assert.equal(line.includes(secret), false);
});
test('hookErrorLine caps each line at 500 characters', () => {
  const line = hookErrorLine('codex', 'user-prompt', new Error('x'.repeat(2000)), new Date(0));
  assert.equal(line.length, 500);
});
test('hookErrorLine keeps a single line even when the error message contains newlines', () => {
  const line = hookErrorLine('codex', 'user-prompt', new Error('first\nsecond'), new Date(0));
  assert.equal(line.includes('\n'), false);
  assert.match(line, /error=first second$/);
});
