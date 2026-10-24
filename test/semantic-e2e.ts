import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type AddressInfo } from 'node:net';
import { readFile, rm, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { configSchema, json, prepare, profileDir, readConfig, root } from '../src/config.js';
import { init, start, stop } from '../src/lifecycle.js';
import { atomicJson, sleep, token } from '../src/local.js';
import { Mcp } from '../src/mcp.js';
import { MODEL_NAME, verifyModelDir } from '../src/models.js';

// Real memory engine with local embeddings: provisioned model, semantic vs. lexical ranking, restart persistence and loopback-only sockets.
type Evidence = Record<string, unknown>;
type State = z.infer<typeof stateSchema>;
type Scope = { workspace: string; project: string };
interface Ranked { paths: string[]; titles: string[]; streams: string[] | undefined }
interface TcpRow { LocalAddress: string; LocalPort: number; RemoteAddress: string; RemotePort: number }

const execFileAsync = promisify(execFile);
const EVIDENCE_DIR = resolve(root, '.local/evidence'), EVIDENCE_FILE = resolve(EVIDENCE_DIR, 'semantic-e2e.json');
const LOOPBACK = new Set(['127.0.0.1', '::1', '0.0.0.0', '::']);
const CONCEPTUAL = 'Como implementamos o login?', LEXICAL = 'Kubernetes Helm';
// Discriminative probe: a single token that appears in no page, so only a semantic match can reach the auth page.
const DISCRIMINATIVE = 'login';
const PAGES = {
  auth: { path: 'semantic-e2e/auth-flow', title: 'Fluxo de autenticação',
    body: 'Fluxo de autenticação: o usuário entra com e-mail e senha, o backend valida credenciais e emite um token JWT de sessão; sign-in com OAuth do Google.' },
  deploy: { path: 'semantic-e2e/kubernetes-deploy', title: 'Pipeline de deploy', body: 'Pipeline de deploy no Kubernetes com Helm.' },
  cake: { path: 'semantic-e2e/carrot-cake', title: 'Bolo de cenoura', body: 'Receita de bolo de cenoura com cobertura de chocolate.' }
} as const;

const stateSchema = z.object({ phase: z.string(), pid: z.number().int().positive(), services: z.record(z.string(), z.string()) });
const querySchema = z.object({ hits: z.array(z.object({ path: z.string(), title: z.string() })), streams_active: z.array(z.string()).optional() });
const tcpRowsSchema = z.array(z.object({ LocalAddress: z.string(), LocalPort: z.number(), RemoteAddress: z.string(), RemotePort: z.number() }));

// Polls a read until it holds or the deadline passes; a failed read counts as "not yet".
async function eventually(check: () => Promise<boolean>, timeoutMs = 60_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { if (await check()) return true; } catch { /* Not visible yet. */ }
    if (Date.now() >= deadline) return false;
    await sleep(1000);
  }
}
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(ok => server.close(() => ok()));
  return port;
}
async function uniquePort(used: Set<number>): Promise<number> {
  for (;;) {
    const port = await freePort();
    if (!used.has(port)) { used.add(port); return port; }
  }
}

// Fresh profile on free loopback ports; memory on with semantic search, gateway off.
async function createProfile(name: string): Promise<void> {
  await init(name);
  const path = resolve(profileDir(name), 'suite.json');
  const base = configSchema.parse(await json(path));
  const used = new Set<number>();
  const config = configSchema.parse({
    ...base,
    controlPort: await uniquePort(used),
    dashboard: { port: await uniquePort(used) },
    memory: { enabled: true, port: await uniquePort(used), semanticSearch: true },
    gateway: { ...base.gateway, enabled: false, port: await uniquePort(used) }
  });
  await atomicJson(path, config);
}
async function startProfile(name: string): Promise<State> {
  const state = stateSchema.parse(await start(name));
  assert.equal(state.phase, 'ready', 'profile must reach ready');
  assert.equal(state.services.memory, 'ready', 'memory service must be ready');
  return state;
}
async function setSemanticSearch(name: string, enabled: boolean): Promise<void> {
  const config = await readConfig(name);
  await atomicJson(resolve(profileDir(name), 'suite.json'), { ...config, memory: { ...config.memory, semanticSearch: enabled } });
}

// Memory engine files inside the profile.
const memoryDir = (name: string): string => resolve(profileDir(name), 'memory');
const memoryLog = (name: string): string => resolve(profileDir(name), 'logs/memory.log');
async function assertProviderFile(name: string, provider: 'local' | 'none'): Promise<void> {
  const text = await readFile(resolve(memoryDir(name), 'config.toml'), 'utf8');
  assert.ok(text.startsWith(`embedding_provider = "${provider}"\n`), `config.toml must start with embedding_provider = "${provider}"`);
  assert.match(text, /^backfill_on_start = false$/m, 'config.toml must keep backfill_on_start = false');
}
async function logSize(name: string): Promise<number> {
  return stat(memoryLog(name)).then(s => s.size, () => 0);
}
// The engine writes ANSI colour codes around field names; they are stripped so field matches are plain text.
const ANSI = /\u001b\[[0-9;]*m/g;
async function logSince(name: string, offset: number): Promise<string> {
  const bytes = await readFile(memoryLog(name)).catch(() => Buffer.alloc(0));
  return bytes.subarray(offset).toString('utf8').replace(ANSI, '');
}
// The engine logs "startup embedding backfill completed" only when it embedded, failed or errored on something.
function backfillReport(segment: string): { completedLines: number; failedLines: number; embedded: number[]; failed: number[] } {
  const lines = segment.split(/\r?\n/);
  const completed = lines.filter(l => l.includes('startup embedding backfill completed'));
  const fields = (field: string): number[] => completed.flatMap(l => [...l.matchAll(new RegExp(`\\b${field}=(\\d+)`, 'g'))].map(m => Number(m[1])));
  return {
    completedLines: completed.length,
    failedLines: lines.filter(l => l.includes('startup embedding backfill failed')).length,
    embedded: fields('embedded'), failed: fields('failed')
  };
}
const embedderIsLocal = (segment: string): boolean => /embedder enabled.*provider="local"/.test(segment);

async function query(mcp: Mcp, scope: Scope, text: string, explain = false): Promise<Ranked> {
  const body = querySchema.parse(await mcp.call('memory_query', { ...scope, query: text, ...(explain ? { explain: true } : {}) }));
  return { paths: body.hits.map(h => h.path), titles: body.hits.map(h => h.title), streams: body.streams_active };
}
const summarize = (ranked: Ranked): Evidence => ({
  hits: ranked.paths.map((path, i) => ({ rank: i + 1, path, title: ranked.titles[i] })),
  streams: ranked.streams ?? null
});

// Locality: the engine and the supervisor must have no TCP peer outside loopback (wildcard listeners included).
async function powershell(script: string): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 30_000 });
  return stdout.trim();
}
async function listenerPid(port: number): Promise<number> {
  const pid = Number(await powershell(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess`));
  assert.ok(Number.isInteger(pid) && pid > 0, `no listener found on port ${port}`);
  return pid;
}
async function tcpRows(pid: number): Promise<TcpRow[]> {
  const out = await powershell(`ConvertTo-Json -InputObject @(Get-NetTCPConnection -OwningProcess ${pid} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort) -Compress`);
  return out ? tcpRowsSchema.parse(JSON.parse(out)) : [];
}
async function localityCheck(state: State, memoryPort: number): Promise<Evidence[]> {
  const processes = [{ service: 'memory', pid: await listenerPid(memoryPort) }, { service: 'supervisor', pid: state.pid }];
  const reports: Evidence[] = [];
  for (const { service, pid } of processes) {
    const rows = await tcpRows(pid);
    assert.ok(rows.length > 0, `${service} owns no TCP rows; the locality check would be vacuous`);
    const external = rows.filter(r => !LOOPBACK.has(r.RemoteAddress));
    assert.deepEqual(external, [], `${service} has TCP rows with a non-loopback RemoteAddress`);
    reports.push({ service, connections: rows.length, remoteAddresses: [...new Set(rows.map(r => r.RemoteAddress))].sort() });
  }
  return reports;
}

// Evidence is written only after proving that no secret reached it.
async function writeEvidence(evidence: Evidence, name: string): Promise<void> {
  const text = JSON.stringify(evidence, null, 2);
  const secrets = [await token(profileDir(name)), await token(profileDir(name), 'router-token'), await readFile(resolve(memoryDir(name), 'auth-tokens/default'), 'utf8')];
  for (const secret of secrets) assert.equal(text.includes(secret.trim()), false, 'evidence must not contain a profile secret');
  assert.equal(text.includes('Bearer'), false, 'evidence must not contain bearer headers');
  await prepare(EVIDENCE_DIR);
  await atomicJson(EVIDENCE_FILE, evidence);
}

test('semantic search: local embeddings, lexical preservation, restart persistence and loopback-only sockets', { timeout: 900_000 }, async t => {
  if (process.platform !== 'win32') { t.skip('Get-NetTCPConnection locality check requires Windows'); return; }
  const name = `semantic-e2e-${Date.now()}`;
  let created = false;
  t.after(async () => {
    if (!created) return;
    try { await stop(name); }
    finally { await rm(profileDir(name), { recursive: true, force: true, maxRetries: 5 }); }
  });
  created = true;
  await createProfile(name);
  assert.equal(Object.values(PAGES).some(p => `${p.title} ${p.body}`.toLowerCase().includes(DISCRIMINATIVE)), false,
    'no page may contain the discriminative token');
  const config = await readConfig(name);
  const scope: Scope = { workspace: config.workspace, project: config.project }, memoryPort = config.memory.port;
  const evidence: Evidence = { purpose: 'Validate local semantic search through the real memory engine', date: new Date().toISOString(), profile: name, model: MODEL_NAME };

  // Steps 1-2: start with semantic search on; the profile carries the local provider and a verified model.
  const firstOffset = await logSize(name);
  const first = await startProfile(name);
  await assertProviderFile(name, 'local');
  const modelVerified = await verifyModelDir(resolve(memoryDir(name), 'models', MODEL_NAME));
  assert.equal(modelVerified, true, 'profile model must pass verifyModelDir');
  evidence.configAndModel = { providerLocal: true, backfillOnStartFalse: true, modelVerified };

  // Step 3: three pages through MCP in the profile scope.
  const mcp = await Mcp.connect(name);
  for (const page of Object.values(PAGES)) {
    await mcp.call('memory_write_page', { ...scope, path: page.path, title: page.title, body: `# ${page.title}\n\n${page.body}\n`, tags: [] });
  }

  // Step 4: semantic query ranks the auth page first; lexical query still returns the Kubernetes/Helm page.
  const conceptualReady = await eventually(async () => (await query(mcp, scope, CONCEPTUAL)).paths[0] === PAGES.auth.path);
  assert.ok(conceptualReady, 'conceptual query did not rank the auth page first within 60s');
  const conceptual = await query(mcp, scope, CONCEPTUAL, true);
  assert.equal(conceptual.paths[0], PAGES.auth.path, 'auth page must be the top hit for the conceptual query');
  await eventually(async () => (await query(mcp, scope, LEXICAL)).paths.includes(PAGES.deploy.path));
  const lexical = await query(mcp, scope, LEXICAL, true);
  assert.ok(lexical.paths.includes(PAGES.deploy.path), 'lexical query must return the Kubernetes/Helm page');
  const loginReady = await eventually(async () => (await query(mcp, scope, DISCRIMINATIVE)).paths[0] === PAGES.auth.path);
  assert.ok(loginReady, 'discriminative "login" query did not rank the auth page first within 60s');
  const login = await query(mcp, scope, DISCRIMINATIVE, true);
  assert.equal(login.paths[0], PAGES.auth.path, 'with embeddings the auth page must be top-1 for "login"');
  t.diagnostic(`with embeddings, "login" hits: ${JSON.stringify(login.titles)}`);
  evidence.withEmbeddings = { conceptual: summarize(conceptual), lexical: summarize(lexical), login: summarize(login),
    vectorStreamReported: conceptual.streams?.includes('vector') ?? null };

  const firstSegment = await logSince(name, firstOffset);
  evidence.firstStartLog = { localEmbedder: embedderIsLocal(firstSegment), backfill: backfillReport(firstSegment) };
  assert.ok(embedderIsLocal(firstSegment), 'engine must log embedder enabled with provider="local"');
  assert.equal(backfillReport(firstSegment).failedLines, 0, 'first start must not log a failed backfill');

  // Step 7 (first run, serve active): every TCP row of the engine and supervisor stays on loopback.
  evidence.locality = { firstRun: await localityCheck(first, memoryPort) };

  // Step 5: same profile with semanticSearch=false; syncEmbeddingProvider writes "none" on start.
  await stop(name);
  await setSemanticSearch(name, false);
  await startProfile(name);
  await assertProviderFile(name, 'none');
  const mcpNoEmbed = await Mcp.connect(name);
  const withoutEmbeddings = await query(mcpNoEmbed, scope, CONCEPTUAL, true);
  assert.equal(withoutEmbeddings.streams?.includes('vector') ?? false, false, 'no vector stream may run without an embedder');
  evidence.withoutEmbeddings = summarize(withoutEmbeddings);
  t.diagnostic(`without embeddings, conceptual hits: ${JSON.stringify(withoutEmbeddings.titles)}`);
  const loginWithout = await query(mcpNoEmbed, scope, DISCRIMINATIVE, true);
  assert.equal(loginWithout.paths.includes(PAGES.auth.path), false, 'without embeddings the auth page must not appear for "login"');
  evidence.withoutEmbeddingsLogin = summarize(loginWithout);
  t.diagnostic(`without embeddings, "login" hits: ${JSON.stringify(loginWithout.titles)}`);
  await stop(name);

  // Step 6: semantic search back on; the existing index must serve the same ranking without re-embedding.
  await setSemanticSearch(name, true);
  const restartOffset = await logSize(name);
  const third = await startProfile(name);
  await assertProviderFile(name, 'local');
  const mcpRestart = await Mcp.connect(name);
  const persistedReady = await eventually(async () => (await query(mcpRestart, scope, CONCEPTUAL)).paths[0] === PAGES.auth.path);
  assert.ok(persistedReady, 'auth page must be top-1 again after restart');
  const persisted = await query(mcpRestart, scope, CONCEPTUAL, true);
  const restartSegment = await logSince(name, restartOffset);
  const restartBackfill = backfillReport(restartSegment);
  assert.equal(restartBackfill.failedLines, 0, 'restart must not log a failed backfill');
  assert.deepEqual(restartBackfill.failed.filter(n => n > 0), [], 'restart backfill must report failed=0');
  assert.deepEqual(restartBackfill.embedded.filter(n => n > 0), [], 'restart must not re-embed the indexed pages');
  const loginPersisted = await eventually(async () => (await query(mcpRestart, scope, DISCRIMINATIVE)).paths[0] === PAGES.auth.path);
  assert.ok(loginPersisted, 'auth page must be top-1 for "login" after restart');
  const loginAfterRestart = await query(mcpRestart, scope, DISCRIMINATIVE, true);
  assert.equal(loginAfterRestart.paths[0], PAGES.auth.path, 'after restart the auth page must be top-1 for "login"');
  t.diagnostic(`after restart, "login" hits: ${JSON.stringify(loginAfterRestart.titles)}`);
  evidence.afterRestart = { conceptual: summarize(persisted), login: summarize(loginAfterRestart), localEmbedder: embedderIsLocal(restartSegment), backfill: restartBackfill,
    backfillLineLogged: restartBackfill.completedLines > 0 };
  evidence.locality = { ...(evidence.locality as Evidence), afterRestart: await localityCheck(third, memoryPort) };

  // Step 8: evidence without content, then cleanup in t.after.
  evidence.status = 'passed';
  await writeEvidence(evidence, name);
  t.diagnostic(`evidence written to ${EVIDENCE_FILE}`);
});
