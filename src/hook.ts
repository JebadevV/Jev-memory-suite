import { spawn } from 'node:child_process';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z, ZodError } from 'zod';
import { readConfig, profileDir, profileName, root, workspaceDir } from './config.js';
import { memoryBinary } from './install.js';
import { baseEnv } from './local.js';
import { projectScopeMarker } from './scope.js';
export const events = { SessionStart: 'session-start', UserPromptSubmit: 'user-prompt', PreToolUse: 'pre-tool-use', PostToolUse: 'post-tool-use', SessionEnd: 'session-end' } as const;
const agents = ['codex', 'claude-code'] as const;
const MAX_PAYLOAD_DEPTH = 32, MAX_STDIN_BYTES = 1_000_000, MAX_STDOUT_BYTES = 262_144, HOOK_TIMEOUT_MS = 20_000;
const sessionId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const common = {
  session_id: sessionId, cwd: z.string().min(1).max(2048), hook_event_name: z.enum(Object.keys(events) as [keyof typeof events, ...Array<keyof typeof events>]).nullish(),
  // Codex sends absent optional fields as JSON null, so nullish (absent or null) is the accepted shape.
  transcript_path: z.string().max(4096).nullish(), model: z.string().max(200).nullish(), permission_mode: z.string().max(64).nullish(), tool_use_id: z.string().max(200).nullish()
};
const toolFields = { tool_name: z.string().min(1).max(200), tool_input: z.unknown(), tool_response: z.unknown() };
const payloadSchemas = {
  'session-start': z.looseObject({ ...common, source: z.string().max(64).nullish() }),
  'user-prompt': z.looseObject({ ...common, prompt: z.string().max(200_000) }),
  'pre-tool-use': z.looseObject({ ...common, ...toolFields }),
  'post-tool-use': z.looseObject({ ...common, ...toolFields }),
  'session-end': z.looseObject({ ...common, reason: z.string().max(200).nullish() })
} as const;
type HookEvent = keyof typeof payloadSchemas;
const isHookEvent = (event: string): event is HookEvent => Object.hasOwn(payloadSchemas, event);
const isAgent = (agent: string): agent is typeof agents[number] => (agents as readonly string[]).includes(agent);
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
function hookFields(agent: string, event: string, payload: unknown) {
  if (!isAgent(agent) || !isHookEvent(event)) throw new Error('Untrusted hook agent/event');
  if (exceedsDepth(payload)) throw new Error('Hook payload nesting too deep');
  const parsed = payloadSchemas[event].parse(payload) as Record<string, unknown> & { cwd: string; hook_event_name?: keyof typeof events | null };
  // A null hook_event_name is treated like an absent one: there is nothing to compare.
  if (parsed.hook_event_name && events[parsed.hook_event_name] !== event) throw new Error('Hook event mismatch');
  return parsed;
}
export async function parseHookPayload(agent: string, event: string, payload: unknown, boundary = root): Promise<Record<string, unknown>> {
  const parsed = hookFields(agent, event, payload);
  const canonicalCwd = await workspaceDir(parsed.cwd, boundary);
  // Avoid native transcript reads: preserve bounded lifecycle fields, drop path-based transcript ingestion.
  return { ...Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== 'transcript_path')), cwd: canonicalCwd };
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
  const file = resolve(dir, ACTIVE_SESSION_FILE), tmp = `${file}.tmp`;
  try {
    await writeFile(tmp, sessionId, { mode: 0o600 });
    await rename(tmp, file); // Rename keeps readers from seeing a half-written id.
  } catch {
    // Best effort: a missing breadcrumb only hides toasts, so it must never block capture.
  }
}
export async function nativeHook(name: string, agent: string, event: string, payload: unknown): Promise<string> {
  hookFields(agent, event, payload); // Reject invalid payloads before looking up any local configuration.
  const c = await readConfig(name); if (!c.memory.enabled) return '';
  const safePayload = await parseHookPayload(agent, event, payload, c.projectRoot ?? root);
  if (!(await projectScopeMarker(String(safePayload.cwd), c))) return '';
  await recordActiveSession(profileDir(name), String(safePayload.session_id));
  return spawnHook(name, c.memory.port, agent, event, String(safePayload.cwd), safePayload);
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
const HOOK_ERROR_LINE_MAX = 500, HOOK_ERROR_LOG = 'hook-errors.log';
const logToken = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, '?').slice(0, 64);
// Zod issues carry only schema paths and codes, so payload values never reach the log.
export function hookErrorLine(agent: string, event: string, error: unknown, now = new Date()): string {
  const detail = error instanceof ZodError
    ? error.issues.map(issue => `${issue.path.map(String).join('.') || '(root)'}:${issue.code}`).join(',')
    : error instanceof Error ? error.message : 'unknown error';
  return `${now.toISOString()} agent=${logToken(agent)} event=${logToken(event)} error=${detail.replace(/\s+/g, ' ')}`.slice(0, HOOK_ERROR_LINE_MAX);
}
// Diagnostics only: a logging failure must never change the hook outcome, so every error is swallowed.
async function logHookError(name: string, agent: string, event: string, error: unknown): Promise<void> {
  try {
    if (!profileName.safeParse(name).success) return; // A bogus argv must not pick a write location.
    const dir = resolve(profileDir(name), 'logs');
    await mkdir(dir, { recursive: true });
    await appendFile(resolve(dir, HOOK_ERROR_LOG), `${hookErrorLine(agent, event, error)}\n`, { mode: 0o600 });
  } catch {
    // Best effort: the stderr line is still printed, and a log that cannot be written is not worth failing over.
  }
}
async function main() {
  const input = await readStdin();
  process.stdout.write(await nativeHook(process.argv[2] ?? '', process.argv[3] ?? '', process.argv[4] ?? '', JSON.parse(input) as unknown));
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/hook.js')) main().catch(async (error: unknown) => {
  console.error('Suite hook rejected or unavailable; run doctor');
  process.exitCode = 1;
  await logHookError(process.argv[2] ?? '', process.argv[3] ?? '', process.argv[4] ?? '', error);
});
