import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { profileDir, readConfig } from './config.js';
const responseSchema = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.number(), z.string()]),
  error: z.object({ code: z.number(), message: z.string() }).optional(), result: z.unknown().optional() });
const resultSchema = z.object({ isError: z.boolean().optional(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })) });
const MAX_MCP_RESPONSE_BYTES = 4_000_000;
async function readBounded(res: Response): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_MCP_RESPONSE_BYTES) { await res.body?.cancel(); throw new Error('MCP response too large'); }
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let total = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    total += next.value.byteLength;
    if (total > MAX_MCP_RESPONSE_BYTES) { await reader.cancel(); throw new Error('MCP response too large'); }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
// SSE events are separated by blank lines; notifications carry no id and are skipped.
function sseMessage(body: string, id: number): unknown {
  for (const event of body.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
    if (!data) continue;
    const message = JSON.parse(data) as unknown;
    if (typeof message === 'object' && message !== null && (message as { id?: unknown }).id === id) return message;
  }
  throw new Error('MCP RPC failed: id mismatch');
}
export class Mcp {
  private id = 0;
  constructor(private url: string, private bearer: string) {}
  static async connect(name: string): Promise<Mcp> {
    const c = await readConfig(name);
    if (!c.memory.enabled) throw new Error('Memory engine disabled');
    const bearer = (await readFile(resolve(profileDir(name), 'memory/auth-tokens/default'), 'utf8')).trim();
    const mcp = new Mcp(`http://127.0.0.1:${c.memory.port}/mcp`, bearer);
    await mcp.rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'jev-memory-suite', version: '0.1.0' } });
    await mcp.rpc('notifications/initialized', {}, true);
    return mcp;
  }
  async rpc(method: string, params: unknown, notification = false): Promise<unknown> {
    if (!['initialize', 'notifications/initialized', 'tools/list', 'tools/call'].includes(method)) throw new Error('Method not allowed');
    const id = ++this.id;
    const res = await fetch(this.url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${this.bearer}` },
      body: JSON.stringify({ jsonrpc: '2.0', ...(notification ? {} : { id }), method, params }) });
    if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
    if (notification) return;
    const body = await readBounded(res);
    const raw = res.headers.get('content-type')?.includes('text/event-stream') ? sseMessage(body, id) : JSON.parse(body) as unknown;
    const parsed = responseSchema.parse(raw);
    if (parsed.id !== id || parsed.error) throw new Error(`MCP RPC failed: ${parsed.error?.code ?? 'id mismatch'}`);
    return parsed.result;
  }
  async tools(): Promise<string[]> {
    return z.object({ tools: z.array(z.object({ name: z.string() })) }).parse(await this.rpc('tools/list', {})).tools.map(t => t.name);
  }
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!['memory_status', 'memory_query', 'memory_write_page', 'memory_read_page', 'memory_read_session_observations', 'memory_recent'].includes(name)) throw new Error('Suite diagnostic tool not allowed');
    const result = resultSchema.parse(await this.rpc('tools/call', { name, arguments: args }));
    if (result.isError) throw new Error('MCP tool returned isError');
    const text = result.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
    try { return JSON.parse(text) as unknown; } catch { return text; }
  }
}
export async function checkMcp(name: string): Promise<unknown> {
  const c = await readConfig(name), mcp = await Mcp.connect(name), tools = await mcp.tools();
  if (!tools.includes('memory_status') || !tools.includes('memory_query')) throw new Error('Required memory tools missing');
  return { handshake: true, requiredTools: ['memory_status', 'memory_query'], toolsCount: tools.length,
    status: await mcp.call('memory_status', { workspace: c.workspace, project: c.project }) };
}
