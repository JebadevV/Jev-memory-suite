import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { readConfig, profileDir, profileName, root, workspaceDir } from './config.js';
import { memoryBinary } from './install.js';
import { baseEnv } from './local.js';
import { projectScopeMarker } from './scope.js';
export const events = { SessionStart: 'session-start', UserPromptSubmit: 'user-prompt', PreToolUse: 'pre-tool-use', PostToolUse: 'post-tool-use', SessionEnd: 'session-end',
  PreCompact: 'pre-compact', Stop: 'stop', SubagentStart: 'subagent-start', SubagentStop: 'subagent-stop' } as const;
const agents = ['codex', 'claude-code', 'antigravity-cli'] as const;
type Agent = typeof agents[number];
// Codex has no subagent lifecycle events, so only Claude Code receives them.
const subagentEvents = new Set<string>(['subagent-start', 'subagent-stop']);
const nativeEvents = Object.values(events);
// Antigravity CLI (agy) native event name to suite event. agy SessionStart and PostInvocation are intentionally unmapped: native drops SessionStart because it lacks invocationNum.
export const antigravityEvents = { PreInvocation: 'session-start', PreToolUse: 'pre-tool-use', PostToolUse: 'post-tool-use', Stop: 'stop' } as const;
export const hostEvents: Record<Agent, readonly string[]> = {
  'claude-code': nativeEvents,
  codex: nativeEvents.filter(event => !subagentEvents.has(event)),
  'antigravity-cli': Object.values(antigravityEvents)
};
// These events produce no decision for the host: the native engine output is discarded so it can never block or continue a turn.
const silentEvents = new Set<string>(['pre-compact', 'stop', 'subagent-start', 'subagent-stop']);
const MAX_PAYLOAD_DEPTH = 32, MAX_STDIN_BYTES = 1_000_000, MAX_STDOUT_BYTES = 262_144, HOOK_TIMEOUT_MS = 20_000;
const MAX_TEXT_CHARS = 200_000, MAX_PATH_CHARS = 4096, MAX_NAME_CHARS = 200;
const sessionId = z.string().min(1).max(MAX_NAME_CHARS).regex(/^[A-Za-z0-9._:-]+$/);
const common = {
  session_id: sessionId, cwd: z.string().min(1).max(2048), hook_event_name: z.enum(Object.keys(events) as [keyof typeof events, ...Array<keyof typeof events>]).nullish(),
  // Codex sends absent optional fields as JSON null, so nullish (absent or null) is the accepted shape.
  transcript_path: z.string().max(MAX_PATH_CHARS).nullish(), model: z.string().max(MAX_NAME_CHARS).nullish(), permission_mode: z.string().max(64).nullish(), tool_use_id: z.string().max(MAX_NAME_CHARS).nullish()
};
const toolFields = { tool_name: z.string().min(1).max(MAX_NAME_CHARS), tool_input: z.unknown(), tool_response: z.unknown() };
// Real Claude Code SubagentStop sends agent_type as an empty string; presence and type are still enforced.
const subagentFields = { agent_id: sessionId, agent_type: z.string().max(MAX_NAME_CHARS) };
const stopFields = { stop_hook_active: z.boolean().nullish(), last_assistant_message: z.string().max(MAX_TEXT_CHARS).nullish() };
const payloadSchemas = {
  'session-start': z.looseObject({ ...common, source: z.string().max(64).nullish() }),
  'user-prompt': z.looseObject({ ...common, prompt: z.string().max(MAX_TEXT_CHARS) }),
  'pre-tool-use': z.looseObject({ ...common, ...toolFields }),
  'post-tool-use': z.looseObject({ ...common, ...toolFields }),
  'session-end': z.looseObject({ ...common, reason: z.string().max(MAX_NAME_CHARS).nullish() }),
  'pre-compact': z.looseObject({ ...common, trigger: z.string().max(32).nullish(), custom_instructions: z.string().max(20_000).nullish() }),
  stop: z.looseObject({ ...common, ...stopFields }),
  'subagent-start': z.looseObject({ ...common, ...subagentFields }),
  'subagent-stop': z.looseObject({ ...common, ...subagentFields, ...stopFields, agent_transcript_path: z.string().max(MAX_PATH_CHARS).nullish() })
} as const;
type HookEvent = keyof typeof payloadSchemas;
const isHookEvent = (event: string): event is HookEvent => Object.hasOwn(payloadSchemas, event);
const isAgent = (agent: string): agent is Agent => (agents as readonly string[]).includes(agent);
// Antigravity payloads are camelCase and carry no cwd or session_id; they are mapped to the suite fields after validation.
const agyCommon = {
  conversationId: sessionId, workspacePaths: z.array(z.string().min(1).max(MAX_PATH_CHARS)).min(1).max(16),
  transcriptPath: z.string().max(MAX_PATH_CHARS).nullish(), artifactDirectoryPath: z.string().max(MAX_PATH_CHARS).nullish(), modelName: z.string().max(MAX_NAME_CHARS).nullish()
};
const agyToolFields = {
  toolCall: z.looseObject({ name: z.string().min(1).max(MAX_NAME_CHARS), args: z.unknown() }), stepIdx: z.number().int().min(0), error: z.string().max(MAX_TEXT_CHARS).nullish()
};
const agyPayloadSchemas = {
  'session-start': z.looseObject({ ...agyCommon, invocationNum: z.number().int().min(0), initialNumSteps: z.number().int().min(0).nullish() }),
  'pre-tool-use': z.looseObject({ ...agyCommon, ...agyToolFields }),
  'post-tool-use': z.looseObject({ ...agyCommon, ...agyToolFields }),
  stop: z.looseObject({ ...agyCommon, executionNum: z.number().int().nullish(), terminationReason: z.string().max(64).nullish(), error: z.string().max(MAX_TEXT_CHARS).nullish(), fullyIdle: z.boolean() })
} as const;
type AgyEvent = keyof typeof agyPayloadSchemas;
const isAgyEvent = (event: string): event is AgyEvent => Object.hasOwn(agyPayloadSchemas, event);
// The schema guarantees at least one workspace path, so the first entry is always present.
type AgyFields = Record<string, unknown> & { conversationId: string; workspacePaths: [string, ...string[]]; artifactDirectoryPath?: string | null };
// Fields that must never reach the native engine: transcript files and assistant text are not captured.
const droppedFields = new Set(['transcript_path', 'agent_transcript_path', 'last_assistant_message']);
// Pure: the CLI brain directory for a conversation, the only artifact location this hook accepts.
const cliBrainDir = (home: string, conversation: string): string => resolve(home, '.gemini', 'antigravity-cli', 'brain', conversation);
// Pure: true only for the Antigravity CLI surface; the IDE/App shares the same hooks file but writes its artifacts elsewhere.
export function antigravityCliSurface(payload: unknown, home = homedir()): boolean {
  const { artifactDirectoryPath, conversationId } = (payload ?? {}) as Record<string, unknown>;
  if (typeof artifactDirectoryPath !== 'string' || typeof conversationId !== 'string' || !sessionId.safeParse(conversationId).success) return false;
  const actual = resolve(artifactDirectoryPath), expected = cliBrainDir(home, conversationId);
  return process.platform === 'win32' ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}
// Iterative so hostile deeply-nested input cannot overflow the call stack.
export function exceedsDepth(value: unknown, limit = MAX_PAYLOAD_DEPTH): boolean {
  const stack: Array<[unknown, number]> = [[value, 1]];
  for (let item = stack.pop(); item; item = stack.pop()) {
    const [current, depth] = item;
    if (depth > limit) return true;
    if (current && typeof current === 'object') for (const child of Object.values(current)) stack.push([child, depth + 1]);
  }
  return false;
}
function hookFields(agent: string, event: string, payload: unknown): Record<string, unknown> {
  if (!isAgent(agent) || !isHookEvent(event)) throw new Error('Untrusted hook agent/event');
  if (!hostEvents[agent].includes(event)) throw new Error('Hook event not supported by agent');
  if (exceedsDepth(payload)) throw new Error('Hook payload nesting too deep');
  if (agent === 'antigravity-cli') {
    if (!isAgyEvent(event)) throw new Error('Hook event not supported by agent');
    return agyPayloadSchemas[event].parse(payload) as Record<string, unknown>;
  }
  const parsed = payloadSchemas[event].parse(payload) as Record<string, unknown> & { cwd: string; hook_event_name?: keyof typeof events | null };
  // A null hook_event_name is treated like an absent one: there is nothing to compare.
  if (parsed.hook_event_name && events[parsed.hook_event_name] !== event) throw new Error('Hook event mismatch');
  return parsed;
}
// Maps Antigravity fields to the suite shape: the workspace becomes cwd, the conversation becomes session_id, and the artifact dir is kept only for the CLI.
async function antigravitySafePayload(parsed: AgyFields, boundary: string): Promise<Record<string, unknown>> {
  const canonicalCwd = await workspaceDir(parsed.workspacePaths[0], boundary);
  const kept = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'transcriptPath' && key !== 'artifactDirectoryPath'));
  if (antigravityCliSurface(parsed)) kept.artifactDirectoryPath = parsed.artifactDirectoryPath;
  return { ...kept, cwd: canonicalCwd, session_id: parsed.conversationId, workspacePaths: [canonicalCwd] };
}
export async function parseHookPayload(agent: string, event: string, payload: unknown, boundary = root): Promise<Record<string, unknown>> {
  const parsed = hookFields(agent, event, payload);
  if (agent === 'antigravity-cli') return antigravitySafePayload(parsed as AgyFields, boundary);
  const canonicalCwd = await workspaceDir(String(parsed.cwd), boundary);
  // Avoid native transcript reads: preserve bounded lifecycle fields, drop path-based transcript and assistant-text ingestion.
  return { ...Object.fromEntries(Object.entries(parsed).filter(([key]) => !droppedFields.has(key))), cwd: canonicalCwd };
}
function spawnHook(name: string, port: number, agent: string, event: string, cwd: string, payload: Record<string, unknown>): Promise<string> {
  return new Promise<string>((ok, fail) => {
    const chunks: Buffer[] = []; let size = 0, settled = false;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) fail(error); else ok(Buffer.concat(chunks).toString('utf8'));
    };
    const child = spawn(memoryBinary(), ['--data-dir', resolve(profileDir(name), 'memory'), 'hook', '--event', event, '--agent', agent,
      '--server-url', `http://127.0.0.1:${port}`, '--capture-mode', 'allowlist'], {
      // Threshold 1: every post-tool-use drains the spool (250 ms budget), so the dashboard sees activity live.
      cwd, env: { ...baseEnv(), AI_MEMORY_HOOK_INCREMENTAL_THRESHOLD: '1' }, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => { child.kill(); settle(new Error('Native hook timeout')); }, HOOK_TIMEOUT_MS);
    child.stdout.on('data', (b: Buffer) => {
      if (settled) return;
      size += b.length;
      if (size > MAX_STDOUT_BYTES) { child.kill(); settle(new Error('Native hook output too large')); return; }
      chunks.push(b);
    });
    child.stderr.resume(); child.once('error', settle);
    child.once('close', code => settle(code === 0 ? undefined : new Error(`Native hook exit ${code}`)));
    child.stdin.on('error', () => undefined); child.stdin.end(JSON.stringify(payload));
  });
}
// Breadcrumb for the dashboard live feed: the session id only, never hook content.
export const ACTIVE_SESSION_FILE = 'active-session';
export async function recordActiveSession(dir: string, sessionId: string): Promise<void> {
  const file = resolve(dir, ACTIVE_SESSION_FILE), tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`; // Unique temp name: parallel subagent hooks must not share one.
  try {
    await writeFile(tmp, sessionId, { mode: 0o600, flag: 'wx' });
    await rename(tmp, file); // Rename keeps readers from seeing a half-written id.
  } catch {
    // Best effort: a missing breadcrumb only hides toasts, so it must never block capture.
    await unlink(tmp).catch(() => undefined); // Never leave a stray temp file behind.
  }
}
// Pure: the host only ever sees the native engine output for events that can carry a decision.
export function hookOutput(event: string, nativeStdout: string): string {
  return silentEvents.has(event) ? '{}' : nativeStdout;
}
// Launch tracking: an agy launch records the conversations it ran so finalization can target them exactly. Ids only, never content.
export const AGY_LAUNCH_ENV = 'JEV_MEMORY_AGY_LAUNCH';
const launchIdPattern = /^[a-f0-9]{32}$/;
export function launchSessionsFile(profileDirPath: string, launchId: string): string {
  return resolve(profileDirPath, 'launch', 'agy', `${launchId}.sessions`);
}
// Best effort: launch tracking only narrows finalization, so a write failure or invalid id must never block capture.
export async function recordLaunchSession(profileDirPath: string, launchId: string, conversationId: string): Promise<void> {
  try {
    if (!launchIdPattern.test(launchId) || !sessionId.safeParse(conversationId).success) return;
    if ((await readLaunchSessions(profileDirPath, launchId)).includes(conversationId)) return;
    const file = launchSessionsFile(profileDirPath, launchId);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${conversationId}\n`, { mode: 0o600 });
  } catch {
    // Swallowed by design: the launch simply finalizes without this conversation.
  }
}
// Missing file means no sessions yet; only valid, deduplicated conversation ids are returned.
export async function readLaunchSessions(profileDirPath: string, launchId: string): Promise<string[]> {
  if (!launchIdPattern.test(launchId)) return [];
  let text: string;
  try {
    text = await readFile(launchSessionsFile(profileDirPath, launchId), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return [...new Set(text.split(/\r?\n/).filter(line => sessionId.safeParse(line).success))];
}
const MAX_HANDOFF_CHARS = 100_000;
const agyInjectSteps = z.object({ injectSteps: z.array(z.object({ ephemeralMessage: z.string().max(MAX_HANDOFF_CHARS) })).min(1) });
// Antigravity output contract. pre-tool-use allow is observe-only: it does not bypass agy permission prompts.
// stop uses an empty decision so the stop proceeds; Stop is not a session end.
export function antigravityOutput(event: string, nativeStdout: string): string {
  if (event === 'pre-tool-use') return '{"decision":"allow"}';
  if (event === 'stop') return '{"decision":""}';
  if (event !== 'session-start') return '{}';
  let parsed: unknown;
  try { parsed = JSON.parse(nativeStdout); } catch { return '{}'; } // Malformed native stdout never reaches the host.
  const result = agyInjectSteps.safeParse(parsed); // Parsing strips any keys beyond injectSteps and ephemeralMessage.
  return result.success ? JSON.stringify(result.data) : '{}';
}
async function captureNative(name: string, agent: string, event: string, payload: unknown): Promise<string> {
  hookFields(agent, event, payload); // Reject invalid payloads before looking up any local configuration.
  if (agent === 'antigravity-cli' && !antigravityCliSurface(payload)) { await logHookSkip(name, agent, event, 'non-cli-surface'); return ''; }
  const c = await readConfig(name); if (!c.memory.enabled) { await logHookSkip(name, agent, event, 'memory-disabled'); return ''; }
  const safePayload = await parseHookPayload(agent, event, payload, c.projectRoot ?? root);
  if (!(await projectScopeMarker(String(safePayload.cwd), c))) { await logHookSkip(name, agent, event, 'no-scope-marker'); return ''; }
  await recordActiveSession(profileDir(name), String(safePayload.session_id));
  const launchId = process.env[AGY_LAUNCH_ENV];
  if (agent === 'antigravity-cli' && launchId) await recordLaunchSession(profileDir(name), launchId, String(safePayload.session_id));
  return spawnHook(name, c.memory.port, agent, event, String(safePayload.cwd), safePayload);
}
export async function nativeHook(name: string, agent: string, event: string, payload: unknown): Promise<string> {
  // A spawn failure rejects here, so the discarded stdout of silent events never hides an error.
  if (agent === 'antigravity-cli') return antigravityOutput(event, await captureNative(name, agent, event, payload));
  return hookOutput(event, await captureNative(name, agent, event, payload));
}
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of process.stdin as AsyncIterable<Buffer>) {
    total += chunk.length;
    if (total > MAX_STDIN_BYTES) throw new Error('Hook payload too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
const HOOK_ERROR_LINE_MAX = 500, HOOK_ERROR_LOG = 'hook-errors.log', HOOK_SKIP_LOG = 'hook-skips.log';
const logToken = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64);
export type HookSkipReason = 'memory-disabled' | 'no-scope-marker' | 'non-cli-surface';
// Pure and content-free: only sanitized agent/event tokens and the fixed reason, never cwd, paths, session ids or payload.
export function hookSkipLine(agent: string, event: string, reason: HookSkipReason, now = new Date()): string {
  return `${now.toISOString()} agent=${logToken(agent)} event=${logToken(event)} skip=${logToken(reason)}`.slice(0, HOOK_ERROR_LINE_MAX);
}
// Zod issues carry only schema paths and codes, so payload values never reach the log.
export function hookErrorLine(agent: string, event: string, error: unknown, now = new Date()): string {
  const detail = error instanceof ZodError
    ? error.issues.map(issue => `${issue.path.map(String).join('.') || '(root)'}:${issue.code}`).join(',')
    : error instanceof Error ? error.message : 'unknown error';
  return `${now.toISOString()} agent=${logToken(agent)} event=${logToken(event)} error=${detail.replace(/\s+/g, ' ')}`.slice(0, HOOK_ERROR_LINE_MAX);
}
// Diagnostics only: a logging failure must never change the hook outcome, so every error is swallowed.
async function appendHookLog(name: string, file: string, line: () => string): Promise<void> {
  try {
    if (!profileName.safeParse(name).success) return; // A bogus argv must not pick a write location.
    const dir = resolve(profileDir(name), 'logs');
    await mkdir(dir, { recursive: true });
    await appendFile(resolve(dir, file), `${line()}\n`, { mode: 0o600 });
  } catch {
    // Best effort: the stderr line is still printed, and a log that cannot be written is not worth failing over.
  }
}
async function logHookError(name: string, agent: string, event: string, error: unknown): Promise<void> {
  await appendHookLog(name, HOOK_ERROR_LOG, () => hookErrorLine(agent, event, error));
}
// Silent skips keep their '' outcome; the log only records that the hook was skipped and why.
async function logHookSkip(name: string, agent: string, event: string, reason: HookSkipReason): Promise<void> {
  await appendHookLog(name, HOOK_SKIP_LOG, () => hookSkipLine(agent, event, reason));
}
async function main() {
  const input = await readStdin();
  process.stdout.write(await nativeHook(process.argv[2] ?? '', process.argv[3] ?? '', process.argv[4] ?? '', JSON.parse(input) as unknown));
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/hook.js')) main().catch(async (error: unknown) => {
  const [name, agent, event] = [process.argv[2] ?? '', process.argv[3] ?? '', process.argv[4] ?? ''];
  console.error('Suite hook rejected or unavailable; run doctor');
  // Antigravity fails open: agy needs a valid contract output with exit 0, so a failure never blocks the host.
  if (agent === 'antigravity-cli') process.stdout.write(antigravityOutput(event, ''));
  else process.exitCode = 1;
  await logHookError(name, agent, event, error);
});
