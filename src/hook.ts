import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { z } from 'zod';
import { readConfig, profileDir, workspaceDir } from './config.js';
import { memoryBinary } from './install.js';
import { baseEnv } from './local.js';
export const events = { SessionStart: 'session-start', UserPromptSubmit: 'user-prompt', PreToolUse: 'pre-tool-use', PostToolUse: 'post-tool-use', SessionEnd: 'session-end' } as const;
const agents = ['codex', 'claude-code'] as const;
const MAX_PAYLOAD_DEPTH = 32, MAX_STDIN_BYTES = 1_000_000, MAX_STDOUT_BYTES = 262_144, HOOK_TIMEOUT_MS = 20_000;
const sessionId = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/);
const common = {
  session_id: sessionId, cwd: z.string().min(1).max(2048), hook_event_name: z.enum(Object.keys(events) as [keyof typeof events, ...Array<keyof typeof events>]).optional(),
  transcript_path: z.string().max(4096).optional(), model: z.string().max(200).optional(), permission_mode: z.string().max(64).optional(), tool_use_id: z.string().max(200).optional()
};
const toolFields = { tool_name: z.string().min(1).max(200), tool_input: z.unknown(), tool_response: z.unknown() };
const payloadSchemas = {
  'session-start': z.looseObject({ ...common, source: z.string().max(64).optional() }),
  'user-prompt': z.looseObject({ ...common, prompt: z.string().max(200_000) }),
  'pre-tool-use': z.looseObject({ ...common, ...toolFields }),
  'post-tool-use': z.looseObject({ ...common, ...toolFields }),
  'session-end': z.looseObject({ ...common, reason: z.string().max(200).optional() })
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
export async function parseHookPayload(agent: string, event: string, payload: unknown): Promise<Record<string, unknown>> {
  if (!isAgent(agent) || !isHookEvent(event)) throw new Error('Untrusted hook agent/event');
  if (exceedsDepth(payload)) throw new Error('Hook payload nesting too deep');
  const parsed = payloadSchemas[event].parse(payload) as Record<string, unknown> & { cwd: string; hook_event_name?: keyof typeof events };
  if (parsed.hook_event_name && events[parsed.hook_event_name] !== event) throw new Error('Hook event mismatch');
  const canonicalCwd = await workspaceDir(parsed.cwd);
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
      cwd, env: baseEnv(), windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']
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
export async function nativeHook(name: string, agent: string, event: string, payload: unknown): Promise<string> {
  const safePayload = await parseHookPayload(agent, event, payload);
  const c = await readConfig(name); if (!c.memory.enabled) return '';
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
async function main() {
  const input = await readStdin();
  process.stdout.write(await nativeHook(process.argv[2] ?? '', process.argv[3] ?? '', process.argv[4] ?? '', JSON.parse(input) as unknown));
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/hook.js')) main().catch(() => { console.error('Suite hook rejected or unavailable; run doctor'); process.exitCode = 1; });
