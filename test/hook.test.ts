import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, stat, symlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { root, workspaceDir } from '../src/config.js';
import { nativeHook, parseHookPayload, recordActiveSession, hookErrorLine, hookOutput, hookSkipLine, hostEvents, ACTIVE_SESSION_FILE, type HookSkipReason,
  antigravityCliSurface, antigravityEvents, antigravityOutput, launchSessionsFile, readLaunchSessions, recordLaunchSession } from '../src/hook.js';
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
const subagent = { session_id: 'sess-1', cwd: root, agent_id: 'agent-7', agent_type: 'Explore' };
// Shape of a real Claude Code SubagentStop payload; agent_type arrives empty in practice (hook-errors.log: agent_type:too_small).
const realSubagentStop = { session_id: 'sess-1', transcript_path: 'C:/redacted/parent.jsonl', cwd: root, permission_mode: 'default', hook_event_name: 'SubagentStop', stop_hook_active: false, agent_id: 'a1b2c3d4e5f6', agent_type: '', agent_transcript_path: 'C:/redacted/agent.jsonl', last_assistant_message: 'redacted' };
test('parseHookPayload accepts a valid payload for each new Claude Code event', async () => {
  await assert.doesNotReject(parseHookPayload('claude-code', 'pre-compact', { ...sessionStart, hook_event_name: 'PreCompact', trigger: 'auto', custom_instructions: '' }));
  await assert.doesNotReject(parseHookPayload('claude-code', 'stop', { ...sessionStart, hook_event_name: 'Stop', stop_hook_active: false }));
  await assert.doesNotReject(parseHookPayload('claude-code', 'subagent-start', { ...subagent, hook_event_name: 'SubagentStart' }));
  await assert.doesNotReject(parseHookPayload('claude-code', 'subagent-stop', { ...subagent, hook_event_name: 'SubagentStop', stop_hook_active: true }));
});
test('parseHookPayload drops agent_transcript_path and last_assistant_message but keeps agent identity', async () => {
  const result = await parseHookPayload('claude-code', 'subagent-stop', {
    ...subagent, transcript_path: 'C:/parent.jsonl', agent_transcript_path: 'C:/agent.jsonl', last_assistant_message: 'private answer'
  });
  for (const key of ['transcript_path', 'agent_transcript_path', 'last_assistant_message']) assert.equal(key in result, false, key);
  assert.equal(result.agent_id, 'agent-7');
  assert.equal(result.agent_type, 'Explore');
  assert.equal(result.session_id, 'sess-1');
  assert.equal(result.cwd, await realpath(root));
});
test('parseHookPayload drops last_assistant_message from stop events', async () => {
  const result = await parseHookPayload('claude-code', 'stop', { ...sessionStart, last_assistant_message: 'private answer' });
  assert.equal('last_assistant_message' in result, false);
});
test('parseHookPayload rejects subagent events for Codex', async () => {
  await assert.rejects(parseHookPayload('codex', 'subagent-start', subagent), /not supported by agent/);
  await assert.rejects(parseHookPayload('codex', 'subagent-stop', subagent), /not supported by agent/);
});
test('parseHookPayload requires agent_id and a present agent_type string on subagent events', async () => {
  await assert.rejects(parseHookPayload('claude-code', 'subagent-start', { session_id: 'sess-1', cwd: root, agent_type: 'Explore' }), /agent_id/);
  await assert.rejects(parseHookPayload('claude-code', 'subagent-start', { ...subagent, agent_id: 'bad id!' }), /agent_id/);
  await assert.rejects(parseHookPayload('claude-code', 'subagent-start', { session_id: 'sess-1', cwd: root, agent_id: 'agent-7' }), /agent_type/);
});
test('parseHookPayload accepts the real Claude Code SubagentStop shape with an empty agent_type', async () => {
  const result = await parseHookPayload('claude-code', 'subagent-stop', realSubagentStop);
  assert.equal(result.agent_type, '');
  assert.equal(result.agent_id, 'a1b2c3d4e5f6');
  for (const key of ['transcript_path', 'agent_transcript_path', 'last_assistant_message']) assert.equal(key in result, false, key);
});
test('parseHookPayload accepts SubagentStart with an empty agent_type', async () => {
  await assert.doesNotReject(parseHookPayload('claude-code', 'subagent-start', { ...subagent, hook_event_name: 'SubagentStart', agent_type: '' }));
});
test('parseHookPayload rejects a subagent agent_id that is not allowlisted even with an empty agent_type', async () => {
  await assert.rejects(parseHookPayload('claude-code', 'subagent-stop', { ...realSubagentStop, agent_id: 'bad id!' }), /agent_id/);
});
test('parseHookPayload still rejects a subagent agent_type that is missing, null, non-string, or over 200 characters', async () => {
  const missing = { session_id: 'sess-1', cwd: root, agent_id: 'agent-7' };
  await assert.rejects(parseHookPayload('claude-code', 'subagent-stop', missing), /agent_type/);
  await assert.rejects(parseHookPayload('claude-code', 'subagent-stop', { ...subagent, agent_type: null }), /agent_type/);
  await assert.rejects(parseHookPayload('claude-code', 'subagent-stop', { ...subagent, agent_type: 42 }), /agent_type/);
  await assert.rejects(parseHookPayload('claude-code', 'subagent-stop', { ...subagent, agent_type: 'x'.repeat(201) }), /agent_type/);
});
test('parseHookPayload rejects a hook_event_name that mismatches a new event', async () => {
  await assert.rejects(parseHookPayload('claude-code', 'stop', { ...sessionStart, hook_event_name: 'PreCompact' }), /Hook event mismatch/);
  await assert.rejects(parseHookPayload('claude-code', 'subagent-stop', { ...subagent, hook_event_name: 'Stop' }), /Hook event mismatch/);
});
test('parseHookPayload accepts Codex null values for stop and pre-compact', async () => {
  await assert.doesNotReject(parseHookPayload('codex', 'stop', { ...sessionStart, hook_event_name: null, stop_hook_active: null, last_assistant_message: null, turn_id: 'turn-1' }));
  await assert.doesNotReject(parseHookPayload('codex', 'pre-compact', { ...sessionStart, trigger: null, custom_instructions: null }));
});
test('parseHookPayload rejects oversized pre-compact custom instructions', async () => {
  await assert.rejects(parseHookPayload('claude-code', 'pre-compact', { ...sessionStart, custom_instructions: 'x'.repeat(20_001) }));
});
test('hostEvents gives Claude Code all nine events and Codex the seven without subagent events', () => {
  assert.equal(hostEvents['claude-code'].length, 9);
  assert.equal(hostEvents.codex.length, 7);
  assert.equal(hostEvents.codex.includes('subagent-start'), false);
  assert.equal(hostEvents.codex.includes('subagent-stop'), false);
});
test('hookOutput discards native output for silent events and passes it through for the rest', () => {
  const native = '{"decision":"block"}';
  for (const event of ['pre-compact', 'stop', 'subagent-start', 'subagent-stop']) assert.equal(hookOutput(event, native), '{}', event);
  for (const event of ['session-start', 'user-prompt', 'pre-tool-use', 'post-tool-use', 'session-end']) assert.equal(hookOutput(event, native), native, event);
});
test('hookSkipLine formats a fixed-shape line with only the agent, event and reason', () => {
  const now = new Date('2026-01-02T03:04:05.000Z');
  assert.equal(hookSkipLine('claude-code', 'stop', 'no-scope-marker', now), '2026-01-02T03:04:05.000Z agent=claude-code event=stop skip=no-scope-marker');
  assert.equal(hookSkipLine('codex', 'user-prompt', 'memory-disabled', now), '2026-01-02T03:04:05.000Z agent=codex event=user-prompt skip=memory-disabled');
});
test('hookSkipLine keeps cwd, paths, session ids and payload text out of the line', () => {
  const now = new Date('2026-01-02T03:04:05.000Z');
  const line = hookSkipLine('claude-code', 'pre-tool-use', 'no-scope-marker', now);
  for (const leaked of [root, 'C:', '\\', '/', 'sess-', 'prompt', 'secret']) assert.equal(line.includes(leaked), false, leaked);
  // Tokens are sanitized: separators and whitespace from hostile input never survive into the log.
  assert.equal(hookSkipLine('a b/c:d', 'x\ny', 'memory-disabled', now), '2026-01-02T03:04:05.000Z agent=a?b?c?d event=x?y skip=memory-disabled');
  assert.equal(hookSkipLine('a'.repeat(300), 'b'.repeat(300), 'no-scope-marker', now).length <= 500, true);
});
test('hookSkipLine accepts only the fixed skip reasons at compile time', () => {
  const reasons: HookSkipReason[] = ['memory-disabled', 'no-scope-marker'];
  for (const reason of reasons) assert.match(hookSkipLine('codex', 'stop', reason), /skip=(memory-disabled|no-scope-marker)$/);
  // @ts-expect-error free-form reasons (such as a cwd) are rejected by the type; the call only needs to compile here
  hookSkipLine('codex', 'stop', '/home/user/project');
});
test('recordActiveSession uses a unique temp name per write and leaves none behind under concurrency', async () => {
  const dir = await scratchDir();
  try {
    await Promise.all(['sess-a', 'sess-b', 'sess-c', 'sess-d'].map(id => recordActiveSession(dir, id)));
    assert.match(await readFile(resolve(dir, ACTIVE_SESSION_FILE), 'utf8'), /^sess-[a-d]$/);
    assert.deepEqual((await readdir(dir)).filter(n => n.endsWith('.tmp')), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
// Antigravity CLI (agy) fixtures: placeholders are substituted on parsed values, so Windows paths need no JSON escaping.
const agyDir = resolve(root, 'test/fixtures/antigravity');
const agyConversation = '00000000-0000-4000-8000-000000000001';
const agyHome = homedir().replaceAll('\\', '/');
async function agyFixture(name: string, workspace: string): Promise<Record<string, unknown>> {
  const fill = (value: unknown): unknown => {
    if (typeof value === 'string') return value.replaceAll('{{WORKSPACE}}', workspace).replaceAll('{{HOME}}', agyHome);
    if (Array.isArray(value)) return value.map(fill);
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, fill(child)]));
    return value;
  };
  return fill(JSON.parse(await readFile(resolve(agyDir, `${name}.json`), 'utf8'))) as Record<string, unknown>;
}
const agyMapped = [['PreInvocation-0', 'session-start'], ['PreInvocation-1', 'session-start'], ['PreToolUse', 'pre-tool-use'], ['PostToolUse', 'post-tool-use'], ['Stop', 'stop']] as const;
test('parseHookPayload accepts every mapped Antigravity fixture and exposes cwd and session_id', async () => {
  const dir = await scratchDir();
  try {
    for (const [fixture, event] of agyMapped) {
      const result = await parseHookPayload('antigravity-cli', event, await agyFixture(fixture, dir));
      assert.equal(result.cwd, await realpath(dir), fixture);
      assert.equal(result.session_id, agyConversation, fixture);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('parseHookPayload maps Antigravity workspace and artifact fields and drops the transcript path', async () => {
  const dir = await scratchDir();
  try {
    const result = await parseHookPayload('antigravity-cli', 'session-start', await agyFixture('PreInvocation-0', dir));
    assert.equal('transcriptPath' in result, false);
    assert.equal('transcript_path' in result, false);
    assert.deepEqual(result.workspacePaths, [await realpath(dir)]);
    assert.equal(result.artifactDirectoryPath, `${agyHome}/.gemini/antigravity-cli/brain/${agyConversation}`);
    assert.equal(result.invocationNum, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('parseHookPayload drops an Antigravity artifact directory outside the CLI brain', async () => {
  const dir = await scratchDir();
  try {
    const fixture = await agyFixture('PreToolUse', dir);
    fixture.artifactDirectoryPath = `${agyHome}/.gemini/antigravity-ide/brain/${agyConversation}`;
    const result = await parseHookPayload('antigravity-cli', 'pre-tool-use', fixture);
    assert.equal('artifactDirectoryPath' in result, false);
    assert.equal(result.session_id, agyConversation);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('parseHookPayload rejects an Antigravity workspace outside the boundary', async () => {
  await assert.rejects(parseHookPayload('antigravity-cli', 'stop', await agyFixture('Stop', resolve(root, '..'))), /Path escapes its workspace boundary/);
});
test('antigravity session-start requires invocationNum, so the SessionStart fixture is not accepted as a handoff event', async () => {
  await assert.rejects(parseHookPayload('antigravity-cli', 'session-start', await agyFixture('SessionStart', root)), /invocationNum/);
});
test('antigravityEvents maps only the four events the hook receives', () => {
  assert.deepEqual(Object.entries(antigravityEvents), [['PreInvocation', 'session-start'], ['PreToolUse', 'pre-tool-use'], ['PostToolUse', 'post-tool-use'], ['Stop', 'stop']]);
  assert.deepEqual([...hostEvents['antigravity-cli']], ['session-start', 'pre-tool-use', 'post-tool-use', 'stop']);
});
test('antigravity rejects suite events it does not receive', async () => {
  for (const event of ['user-prompt', 'pre-compact', 'session-end', 'subagent-start']) {
    await assert.rejects(parseHookPayload('antigravity-cli', event, await agyFixture('Stop', root)), /not supported by agent/, event);
  }
});
test('antigravityCliSurface is true only for the CLI brain directory', async () => {
  const fixture = await agyFixture('PreToolUse', root);
  assert.equal(antigravityCliSurface(fixture, homedir()), true);
  assert.equal(antigravityCliSurface(fixture), true);
  assert.equal(antigravityCliSurface(fixture, resolve(root, 'elsewhere')), false);
  assert.equal(antigravityCliSurface({ ...fixture, artifactDirectoryPath: `${agyHome}/.gemini/antigravity-ide/brain/${agyConversation}` }, homedir()), false);
  assert.equal(antigravityCliSurface({ ...fixture, artifactDirectoryPath: undefined }, homedir()), false);
  assert.equal(antigravityCliSurface(null, homedir()), false);
});
test('antigravityOutput maps each event to the host contract', () => {
  assert.equal(antigravityOutput('pre-tool-use', '{"decision":"block"}'), '{"decision":"allow"}');
  assert.equal(antigravityOutput('post-tool-use', '{"decision":"block"}'), '{}');
  assert.equal(antigravityOutput('stop', '{"decision":"block"}'), '{"decision":""}');
  assert.equal(antigravityOutput('user-prompt', '{"injectSteps":[{"ephemeralMessage":"x"}]}'), '{}');
});
test('antigravityOutput passes a valid session-start handoff and strips extra keys', () => {
  const native = JSON.stringify({ injectSteps: [{ ephemeralMessage: 'handoff', extra: 1 }], other: true });
  assert.equal(antigravityOutput('session-start', native), '{"injectSteps":[{"ephemeralMessage":"handoff"}]}');
});
test('antigravityOutput falls back to {} for empty, malformed or invalid session-start output', () => {
  const cases = ['', 'not json', '{}', 'null', '{"injectSteps":[]}', '{"injectSteps":[{"ephemeralMessage":1}]}', '{"injectSteps":["text"]}', `{"injectSteps":[{"ephemeralMessage":"${'x'.repeat(100_001)}"}]}`];
  for (const native of cases) assert.equal(antigravityOutput('session-start', native), '{}', native.slice(0, 40));
});
test('antigravityOutput accepts a handoff of exactly 100000 characters', () => {
  const out = antigravityOutput('session-start', JSON.stringify({ injectSteps: [{ ephemeralMessage: 'x'.repeat(100_000) }] }));
  assert.match(out, /^\{"injectSteps":\[\{"ephemeralMessage":"x{100000}"\}\]\}$/);
});
const launch = 'a'.repeat(32);
test('recordLaunchSession appends each conversation once and readLaunchSessions returns them in order', async () => {
  const dir = await scratchDir();
  try {
    await recordLaunchSession(dir, launch, agyConversation);
    await recordLaunchSession(dir, launch, agyConversation);
    await recordLaunchSession(dir, launch, 'conv-2');
    assert.deepEqual(await readLaunchSessions(dir, launch), [agyConversation, 'conv-2']);
    assert.equal(await readFile(launchSessionsFile(dir, launch), 'utf8'), `${agyConversation}\nconv-2\n`);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('readLaunchSessions returns only valid, deduplicated ids from a hand-edited file', async () => {
  const dir = await scratchDir();
  try {
    await mkdir(resolve(dir, 'launch', 'agy'), { recursive: true });
    await writeFile(launchSessionsFile(dir, launch), 'conv-a\nconv-a\nbad id!\r\nconv-b\n\n');
    assert.deepEqual(await readLaunchSessions(dir, launch), ['conv-a', 'conv-b']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('readLaunchSessions returns an empty list when the launch file is missing', async () => {
  const dir = await scratchDir();
  try {
    assert.deepEqual(await readLaunchSessions(dir, launch), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('recordLaunchSession and readLaunchSessions reject bad launch and conversation ids without writing', async () => {
  const dir = await scratchDir();
  try {
    await recordLaunchSession(dir, 'not-hex', agyConversation);
    await recordLaunchSession(dir, launch.toUpperCase(), agyConversation);
    await recordLaunchSession(dir, launch, 'bad id!');
    await recordLaunchSession(dir, launch, '../escape');
    await assert.rejects(stat(resolve(dir, 'launch')), /ENOENT/);
    assert.deepEqual(await readLaunchSessions(dir, 'not-hex'), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
