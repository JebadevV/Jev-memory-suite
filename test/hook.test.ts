import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, realpath, rm, rmdir, symlink } from 'node:fs/promises';
import { root, workspaceDir } from '../src/config.js';
import { nativeHook, parseHookPayload } from '../src/hook.js';
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
