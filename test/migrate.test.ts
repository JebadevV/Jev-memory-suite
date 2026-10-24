import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:net';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { memoryBinary } from '../src/install.js';
import { assertSuiteStopped, migrateHistory, type MigrateInput, type MigrationReport } from '../src/migrate.js';
import { wikiUuid } from '../src/migrate-wiki.js';

// Fixtures: one real AI Memory store per run (ai-memory init + reindex creates schema v84), copied per test.
// Synthetic rows are inserted through node:sqlite. Nothing here touches the user's real data directories.

const DB = join('db', 'memory.sqlite');
const created: string[] = [];
let template = '';

before(async () => {
  template = await mkdtemp(join(tmpdir(), 'jev-migrate-template-'));
  created.push(template);
  const data = join(template, 'memory');
  execFileSync(memoryBinary(), ['--data-dir', data, 'init'], { stdio: 'ignore' });
  execFileSync(memoryBinary(), ['--data-dir', data, 'reindex'], { stdio: 'ignore' });
  const db = new DatabaseSync(join(data, DB));
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
});
after(async () => {
  for (const path of created) await rm(path, { recursive: true, force: true });
});

async function temp(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  created.push(path);
  return path;
}
// A fresh AI Memory data dir (db + wiki + config) copied from the initialized template.
async function freshDataDir(): Promise<string> {
  const dir = await temp('jev-migrate-data-');
  await cp(join(template, 'memory'), dir, { recursive: true });
  return dir;
}
function blobId(seed: string): Buffer {
  return createHash('md5').update(seed).digest();
}
function hex(id: Buffer): string {
  return id.toString('hex');
}
function sha(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}
type Value = string | number | Uint8Array | null;
function insert(db: DatabaseSync, table: string, row: Record<string, Value>): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...cols.map(c => row[c] as SQLInputValue));
}
function open(dir: string): DatabaseSync {
  return new DatabaseSync(join(dir, DB));
}
async function writeWiki(dir: string, rel: string, text: string): Promise<void> {
  const path = join(dir, 'wiki', rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text, 'utf8');
}

// Stable ids for the source and destination fixtures.
const ID = {
  wsSrc: blobId('src-ws-jev'), wsOtherSrc: blobId('src-ws-other'), wsDest: blobId('dest-ws-jev'),
  pSrc: blobId('src-proj-jms'), pOtherSrc: blobId('src-proj-docs'), pDest: blobId('dest-proj-jms'),
  p0: blobId('page-old'), p1: blobId('page-latest'), p2: blobId('page-decision'), p3: blobId('page-docs'),
  pdx: blobId('dest-page-decision'),
  s1: blobId('session-1'), s2: blobId('session-2'), s3: blobId('session-3'),
  o1: blobId('obs-1'), o2: blobId('obs-2'), o3: blobId('obs-3'), h1: blobId('handoff-1')
};

function seedSource(db: DatabaseSync): void {
  insert(db, 'workspaces', { id: ID.wsSrc, name: 'jev-suite', created_at: 1000 });
  insert(db, 'workspaces', { id: ID.wsOtherSrc, name: 'other-ws', created_at: 1100 });
  insert(db, 'projects', { id: ID.pSrc, workspace_id: ID.wsSrc, name: 'jev-memory-suite', created_at: 1200, identity: '', canonical_name: '', legacy_name: '' });
  insert(db, 'projects', { id: ID.pOtherSrc, workspace_id: ID.wsOtherSrc, name: 'docs', created_at: 1300, identity: '' });
  const page = (id: Buffer, path: string, title: string, body: string, latest: number, extra: Record<string, Value> = {}) => ({
    id, workspace_id: ID.wsSrc, project_id: ID.pSrc, path, title, tier: 'semantic', body, body_sha256: sha(body),
    frontmatter_json: '{}', is_latest: latest, pinned: 0, created_at: 2000, updated_at: 2100, access_count: 0,
    path_search: path, ...extra
  });
  insert(db, 'pages', page(ID.p0, 'notes/a.md', 'Nota antiga', 'versão antiga da nota', 0, { superseded_at: 2050 }));
  insert(db, 'pages', page(ID.p1, 'notes/a.md', 'Nota atual', 'versão atual da nota', 1, { supersedes: ID.p0, updated_at: 2200 }));
  insert(db, 'pages', page(ID.p2, 'decisions/x.md', 'Decisão X', 'decisão tomada na origem', 1));
  insert(db, 'pages', { ...page(ID.p3, 'readme.md', 'Docs readme', 'leia primeiro', 1), workspace_id: ID.wsOtherSrc, project_id: ID.pOtherSrc });
  insert(db, 'sessions', { id: ID.s1, workspace_id: ID.wsSrc, project_id: ID.pSrc, agent_kind: 'claude-code', cwd: '/src', started_at: 3000, summary_page_id: ID.p1 });
  insert(db, 'sessions', { id: ID.s2, workspace_id: ID.wsSrc, project_id: ID.pSrc, agent_kind: 'claude-code', cwd: '/src', started_at: 3100 });
  insert(db, 'sessions', { id: ID.s3, workspace_id: ID.wsOtherSrc, project_id: ID.pOtherSrc, agent_kind: 'codex', cwd: '/docs', started_at: 3200 });
  const observation = (id: Buffer, session: Buffer, ws: Buffer, pj: Buffer) => ({
    id, session_id: session, workspace_id: ws, project_id: pj, kind: 'note', title: 'obs', body: 'corpo da observação',
    importance: 1, created_at: 4000, extension: '{}', source_event: 'hook'
  });
  insert(db, 'observations', observation(ID.o1, ID.s1, ID.wsSrc, ID.pSrc));
  insert(db, 'observations', observation(ID.o2, ID.s3, ID.wsOtherSrc, ID.pOtherSrc));
  insert(db, 'observations', observation(ID.o3, ID.s2, ID.wsSrc, ID.pSrc));
  insert(db, 'ingest_keys', { project_id: ID.pSrc, key: 'k-1', seen_at: 5000, session_id: ID.s1, agent_kind: 'claude-code', observation_kind: 'note', event_identity: 'e1', recovery_retained: 0 });
  insert(db, 'ingest_keys', { project_id: ID.pSrc, key: 'k-2', seen_at: 5100, session_id: ID.s2, agent_kind: 'claude-code', observation_kind: 'note', event_identity: 'e2', recovery_retained: 0 });
  insert(db, 'handoffs', { id: ID.h1, workspace_id: ID.wsSrc, project_id: ID.pSrc, from_session_id: ID.s1, from_agent: 'claude', to_agent: 'codex', summary: 'resumo', state: 'open', created_at: 6000 });
  insert(db, 'page_evidence', { page_id: ID.p1, source_kind: 'observation', source_id: 'o1', created_at: 7000 });
}

function seedDestination(db: DatabaseSync): void {
  insert(db, 'workspaces', { id: ID.wsDest, name: 'jev-suite', created_at: 500 });
  insert(db, 'projects', { id: ID.pDest, workspace_id: ID.wsDest, name: 'jev-memory-suite', created_at: 600, identity: '' });
  insert(db, 'sessions', { id: ID.s2, workspace_id: ID.wsDest, project_id: ID.pDest, agent_kind: 'codex', cwd: '/local', started_at: 700 });
  insert(db, 'pages', {
    id: ID.pdx, workspace_id: ID.wsDest, project_id: ID.pDest, path: 'decisions/x.md', title: 'Decisão local', tier: 'semantic',
    body: 'decisão local', body_sha256: sha('decisão local'), frontmatter_json: '{}', is_latest: 1, pinned: 0,
    created_at: 800, updated_at: 800, access_count: 0, path_search: 'decisions/x.md'
  });
}

// Source: 2 workspaces ('jev-suite' collides by name with the destination), projects, pages with
// supersedes, a session collision (s2), a latest-path collision (decisions/x.md), handoff and ingest keys.
function withDb(dir: string, seed: (db: DatabaseSync) => void): void {
  const db = open(dir);
  try {
    seed(db);
  } finally {
    db.close();
  }
}
async function sourceAndDestination(): Promise<{ from: string; dest: string }> {
  const from = await freshDataDir();
  const dest = await freshDataDir();
  withDb(from, seedSource);
  withDb(dest, seedDestination);
  await writeWiki(from, `${wikiUuid(hex(ID.wsSrc))}/_meta.md`, 'meta jev-suite');
  await writeWiki(from, `${wikiUuid(hex(ID.wsSrc))}/${wikiUuid(hex(ID.pSrc))}/_meta.md`, 'meta projeto');
  await writeWiki(from, `${wikiUuid(hex(ID.wsSrc))}/${wikiUuid(hex(ID.pSrc))}/notes/a.md`, 'nota atual');
  await writeWiki(from, `${wikiUuid(hex(ID.wsSrc))}/${wikiUuid(hex(ID.pSrc))}/.git/HEAD`, 'ref: refs/heads/main');
  await writeWiki(from, `${wikiUuid(hex(ID.wsOtherSrc))}/_meta.md`, 'meta other');
  await writeWiki(from, `${wikiUuid(hex(ID.wsOtherSrc))}/${wikiUuid(hex(ID.pOtherSrc))}/readme.md`, 'leia primeiro');
  await writeWiki(dest, `${wikiUuid(hex(ID.wsDest))}/${wikiUuid(hex(ID.pDest))}/notes/a.md`, 'conteúdo local diferente');
  return { from, dest };
}

// Digest of every file and directory under a tree, so "unchanged" means byte-identical plus no new entries.
async function treeDigest(dir: string): Promise<string[]> {
  const names = await readdir(dir, { recursive: true });
  const out: string[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    const info = await lstat(path);
    if (info.isDirectory()) out.push(`D ${name}`);
    else out.push(`F ${name} ${createHash('sha256').update(await readFile(path)).digest('hex')}`);
  }
  return out;
}
// Logical content of every table, independent of page layout (so a VACUUM copy compares equal).
function contentDigest(path: string): string {
  const db = new DatabaseSync(path);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").all() as { name: string }[];
    const hash = createHash('sha256');
    for (const { name } of tables) {
      const rows = (db.prepare(`SELECT * FROM "${name}"`).all() as Record<string, unknown>[])
        .map(r => JSON.stringify(Object.entries(r).map(([k, v]) => [k, v instanceof Uint8Array ? hex(Buffer.from(v)) : v])))
        .sort();
      hash.update(`${name}\n${rows.join('\n')}\n`);
    }
    return hash.digest('hex');
  } finally {
    db.close();
  }
}

function input(from: string, dest: string, apply: boolean, extra: Partial<MigrateInput> = {}): MigrateInput {
  return { from, dest, workDir: '', apply, preflight: async () => undefined, ...extra };
}
async function run(from: string, dest: string, apply: boolean, extra: Partial<MigrateInput> = {}): Promise<MigrationReport> {
  const workDir = await temp('jev-migrate-work-');
  return migrateHistory({ ...input(from, dest, apply, extra), workDir });
}
function findTable(report: MigrationReport, name: string) {
  const table = report.tables[name];
  assert.ok(table, `table ${name} missing from report`);
  return table;
}

test('dry-run never writes to the destination, its wiki or its database file', async () => {
  const { from, dest } = await sourceAndDestination();
  const dbBefore = await readFile(join(dest, DB));
  const treeBefore = await treeDigest(dest);
  const sourceBefore = await treeDigest(from);
  const report = await run(from, dest, false);
  assert.equal(report.status, 'ok', report.error ?? '');
  assert.equal(report.mode, 'dry-run');
  assert.equal(findTable(report, 'sessions').inserted, 2);
  assert.ok(report.wiki && report.wiki.wouldCreate.length > 0 && report.wiki.created.length === 0);
  assert.deepEqual(await readFile(join(dest, DB)), dbBefore);
  assert.deepEqual(await treeDigest(dest), treeBefore);
  assert.deepEqual(await treeDigest(from), sourceBefore);
  assert.equal(report.source.unchanged, true);
  assert.ok(report.evidence?.endsWith('-dryrun.json'));
  assert.ok((await stat(report.evidence ?? '')).isFile());
});

test('apply inserts rows, preserves ids, timestamps and content, and maps names to destination ids', async () => {
  const { from, dest } = await sourceAndDestination();
  const report = await run(from, dest, true);
  assert.equal(report.status, 'ok', report.error ?? '');
  assert.deepEqual(report.mappings.map(m => [m.kind, m.name, m.status]), [
    ['workspace', 'jev-suite', 'mapped'], ['workspace', 'other-ws', 'created'],
    ['project', 'jev-memory-suite', 'mapped'], ['project', 'docs', 'created']
  ]);
  assert.equal(report.mappings[0]?.destId, hex(ID.wsDest));
  assert.equal(findTable(report, 'workspaces').alreadyPresent, 1);
  assert.equal(findTable(report, 'pages').inserted, 3);
  assert.equal(findTable(report, 'pages').conflict, 1);
  assert.equal(findTable(report, 'observations').inserted, 2);
  assert.equal(findTable(report, 'handoffs').inserted, 1);
  assert.equal(findTable(report, 'page_evidence').inserted, 1);
  assert.ok(report.validation?.ok, JSON.stringify(report.validation));
  assert.equal(report.validation?.fts.status, 'ok');

  const db = open(dest);
  try {
    const page = db.prepare('SELECT project_id, created_at, updated_at, body, supersedes FROM pages WHERE id = ?')
      .get(ID.p1) as { project_id: Buffer; created_at: number; updated_at: number; body: string; supersedes: Buffer };
    assert.deepEqual(Buffer.from(page.project_id), ID.pDest, 'project id remapped by name');
    assert.equal(page.created_at, 2000);
    assert.equal(page.updated_at, 2200);
    assert.equal(page.body, 'versão atual da nota');
    assert.deepEqual(Buffer.from(page.supersedes), ID.p0);
    const docs = db.prepare('SELECT id FROM projects WHERE name = ?').get('docs') as { id: Buffer };
    assert.deepEqual(Buffer.from(docs.id), ID.pOtherSrc, 'new project keeps its source id');
    const session = db.prepare('SELECT started_at, agent_kind FROM sessions WHERE id = ?').get(ID.s1) as { started_at: number; agent_kind: string };
    assert.equal(session.started_at, 3000);
    assert.equal(session.agent_kind, 'claude-code');
  } finally {
    db.close();
  }
  assert.equal(report.destination.backup && (await stat(report.destination.backup.file)).isFile(), true);
  const sums = await readFile(report.destination.backup?.sha256sums ?? '', 'utf8');
  assert.match(sums, /^[a-f0-9]{64}  memory\.sqlite\n$/);
  assert.equal(sums.trim().split('  ')[0], createHash('sha256').update(await readFile(report.destination.backup?.file ?? '')).digest('hex'));
});

test('a session id already present with different content conflicts and its children are not migrated', async () => {
  const { from, dest } = await sourceAndDestination();
  const report = await run(from, dest, true);
  assert.equal(report.status, 'ok', report.error ?? '');
  const sessions = findTable(report, 'sessions');
  assert.equal(sessions.conflict, 1);
  assert.deepEqual(sessions.conflicts.map(c => c.reason), ['same id, different content']);
  assert.equal(findTable(report, 'observations').conflict, 1);
  assert.match(findTable(report, 'observations').conflicts[0]?.reason ?? '', /parent not migrated \(sessions via session_id\)/);
  assert.equal(findTable(report, 'ingest_keys').conflict, 1);
  const db = open(dest);
  try {
    const kept = db.prepare('SELECT agent_kind FROM sessions WHERE id = ?').get(ID.s2) as { agent_kind: string };
    assert.equal(kept.agent_kind, 'codex', 'destination session is left as it was');
    const orphan = db.prepare('SELECT count(*) AS n FROM observations WHERE id = ?').get(ID.o3) as { n: number };
    assert.equal(orphan.n, 0, 'child of a conflicting session is not inserted');
  } finally {
    db.close();
  }
});

test('a latest page whose path is already latest in the destination conflicts and is not inserted', async () => {
  const { from, dest } = await sourceAndDestination();
  const report = await run(from, dest, true);
  assert.equal(report.status, 'ok', report.error ?? '');
  const pages = findTable(report, 'pages');
  assert.ok(pages.conflicts.some(c => c.id === hex(ID.p2) && /latest path/.test(c.reason)));
  const db = open(dest);
  try {
    const conflicting = db.prepare('SELECT count(*) AS n FROM pages WHERE id = ?').get(ID.p2) as { n: number };
    assert.equal(conflicting.n, 0, 'conflicting latest page is not inserted');
    const latest = db.prepare('SELECT id FROM pages WHERE workspace_id = ? AND project_id = ? AND path = ? AND is_latest = 1')
      .all(ID.wsDest, ID.pDest, 'decisions/x.md') as { id: Buffer }[];
    assert.equal(latest.length, 1);
    assert.deepEqual(Buffer.from(latest[0]?.id ?? Buffer.alloc(0)), ID.pdx);
  } finally {
    db.close();
  }
});

test('a wiki file that already exists with different content is reported and never overwritten', async () => {
  const { from, dest } = await sourceAndDestination();
  const report = await run(from, dest, true);
  assert.equal(report.status, 'ok', report.error ?? '');
  const local = join(dest, 'wiki', wikiUuid(hex(ID.wsDest)), wikiUuid(hex(ID.pDest)), 'notes', 'a.md');
  assert.equal(await readFile(local, 'utf8'), 'conteúdo local diferente');
  assert.ok(report.wiki?.conflicts.some(c => c.path.endsWith('notes/a.md')));
  assert.ok(report.wiki?.skipped.some(s => s.path.endsWith('.git')));
  assert.equal(report.wiki?.created.some(p => p.includes('.git')), false, 'git metadata never copied');
});

test('re-running apply is idempotent: nothing inserted and no wiki file created', async () => {
  const { from, dest } = await sourceAndDestination();
  const first = await run(from, dest, true);
  assert.equal(first.status, 'ok', first.error ?? '');
  const wikiAfterFirst = await treeDigest(join(dest, 'wiki'));
  const second = await run(from, dest, true);
  assert.equal(second.status, 'ok', second.error ?? '');
  for (const name of Object.keys(second.tables)) assert.equal(findTable(second, name).inserted, 0, name);
  assert.equal(findTable(second, 'pages').alreadyPresent, 3);
  assert.equal(findTable(second, 'sessions').alreadyPresent, 2);
  assert.equal(second.wiki?.created.length, 0);
  assert.equal(second.wiki?.alreadyPresent, 4);
  assert.deepEqual(await treeDigest(join(dest, 'wiki')), wikiAfterFirst);
});

test('source database and wiki are unchanged by apply', async () => {
  const { from, dest } = await sourceAndDestination();
  const before = await treeDigest(from);
  const report = await run(from, dest, true);
  assert.equal(report.source.unchanged, true);
  assert.deepEqual(await treeDigest(from), before);
});

test('incompatible source columns abort before anything is written', async () => {
  const { from, dest } = await sourceAndDestination();
  const src = open(from);
  src.exec('ALTER TABLE observations ADD COLUMN extra_col TEXT');
  src.close();
  const dbBefore = contentDigest(join(dest, DB));
  const report = await run(from, dest, true);
  assert.equal(report.status, 'failed');
  assert.match(report.error ?? '', /extra_col/);
  assert.equal(report.destination.backup, null);
  assert.equal(contentDigest(join(dest, DB)), dbBefore);
});

test('apply is refused while the suite runs or the memory port accepts connections', async () => {
  await assert.rejects(assertSuiteStopped(async () => 'running', 1), /pare a suíte: jev-memory stop/);
  const server: Server = createServer();
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await assert.rejects(assertSuiteStopped(async () => 'stopped', port), /aceita conexão/);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
  await assertSuiteStopped(async () => 'stopped', port);
});

test('a failing preflight writes nothing to the destination', async () => {
  const { from, dest } = await sourceAndDestination();
  const treeBefore = await treeDigest(dest);
  const report = await run(from, dest, true, {
    preflight: async () => { throw new Error('pare a suíte: jev-memory stop'); }
  });
  assert.equal(report.status, 'failed');
  assert.equal(report.error, 'pare a suíte: jev-memory stop');
  assert.deepEqual(await treeDigest(dest), treeBefore);
});

test('a foreign-key violation found before commit rolls the destination back to its pre-apply state', async () => {
  const { from, dest } = await sourceAndDestination();
  const contentBefore = contentDigest(join(dest, DB));
  const report = await run(from, dest, true, {
    hooks: {
      beforeCommit: db => {
        const project = db.prepare('SELECT workspace_id FROM projects WHERE id = ?').get(ID.pDest) as { workspace_id: Buffer };
        db.prepare(`INSERT INTO observations (id, session_id, workspace_id, project_id, kind, title, body, importance, created_at, extension, source_event)
          VALUES (?, ?, ?, ?, 'note', 'orfã', 'x', 1, 1, '{}', 'hook')`)
          .run(blobId('orphan'), blobId('missing-session'), project.workspace_id, ID.pDest);
      }
    }
  });
  assert.equal(report.status, 'failed');
  assert.match(report.error ?? '', /foreign_key_check/);
  assert.equal(contentDigest(join(dest, DB)), contentBefore, 'destination identical after rollback');
  assert.ok(report.destination.backup);
  assert.equal(contentDigest(report.destination.backup.file), contentBefore, 'backup matches destination');
  assert.equal(report.wiki, null, 'wiki is not copied after a failed transaction');
});

test('the source tree is never written, even on a refused run', async () => {
  const { from, dest } = await sourceAndDestination();
  const before = await treeDigest(from);
  await run(from, dest, true, { preflight: async () => { throw new Error('refused'); } });
  assert.deepEqual(await treeDigest(from), before);
  await assert.rejects(stat(join(from, 'wiki', 'nope')));
});

const SCOPE_JEV = { source: { workspace: 'jev-suite', project: 'jev-memory-suite' }, target: { workspace: 'jev-suite', project: 'jev-memory-suite' } };
const COUNTED_TABLES = ['workspaces', 'projects', 'sessions', 'observations', 'pages', 'handoffs', 'ingest_keys'];
function rowCounts(dest: string): Record<string, number> {
  const db = open(dest);
  try {
    return Object.fromEntries(COUNTED_TABLES.map(t => [t, countRowsIn(db, t)]));
  } finally {
    db.close();
  }
}
function countRowsIn(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT count(*) AS n FROM "${table}"`).get() as { n: number }).n;
}

test('scoped apply copies only the selected project and leaves other source projects out', async () => {
  const { from, dest } = await sourceAndDestination();
  const sourceBefore = await treeDigest(from);
  const report = await run(from, dest, true, { scope: SCOPE_JEV });
  assert.equal(report.status, 'ok', report.error ?? '');
  assert.deepEqual(report.scope, SCOPE_JEV);
  assert.deepEqual(report.excluded, { handoffsOutsideProject: 0 });
  assert.deepEqual(report.mappings.map(m => [m.kind, m.name, m.status]), [
    ['workspace', 'jev-suite', 'mapped'], ['project', 'jev-memory-suite', 'mapped']
  ]);
  assert.equal(findTable(report, 'pages').source, 3, 'only the selected project pages are counted');
  assert.equal(findTable(report, 'observations').source, 2);
  assert.equal(findTable(report, 'pages').inserted, 2);
  assert.equal(findTable(report, 'observations').inserted, 1);
  assert.equal(findTable(report, 'sessions').inserted, 1);
  assert.equal(findTable(report, 'handoffs').inserted, 1);
  assert.equal(findTable(report, 'ingest_keys').inserted, 1);
  assert.equal(findTable(report, 'page_evidence').inserted, 1);
  const db = open(dest);
  try {
    assert.equal((db.prepare('SELECT count(*) AS n FROM projects WHERE name = ?').get('docs') as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM workspaces WHERE name = ?').get('other-ws') as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM observations WHERE id = ?').get(ID.o2) as { n: number }).n, 0);
    assert.equal((db.prepare('SELECT count(*) AS n FROM pages WHERE id = ?').get(ID.p3) as { n: number }).n, 0);
  } finally {
    db.close();
  }
  assert.equal(report.source.unchanged, true);
  assert.deepEqual(await treeDigest(from), sourceBefore);
});

test('scoped apply with --as maps rows onto an existing destination project and keeps ids and timestamps', async () => {
  const { from, dest } = await sourceAndDestination();
  const altId = blobId('dest-proj-alt');
  withDb(dest, db => insert(db, 'projects', { id: altId, workspace_id: ID.wsDest, name: 'jev-alt', created_at: 650, identity: '' }));
  const report = await run(from, dest, true, {
    scope: { source: SCOPE_JEV.source, target: { workspace: 'jev-suite', project: 'jev-alt' } }
  });
  assert.equal(report.status, 'ok', report.error ?? '');
  const db = open(dest);
  try {
    const page = db.prepare('SELECT project_id, workspace_id, created_at, updated_at FROM pages WHERE id = ?')
      .get(ID.p1) as { project_id: Buffer; workspace_id: Buffer; created_at: number; updated_at: number };
    assert.deepEqual(Buffer.from(page.project_id), altId);
    assert.deepEqual(Buffer.from(page.workspace_id), ID.wsDest);
    assert.equal(page.created_at, 2000);
    assert.equal(page.updated_at, 2200);
    const session = db.prepare('SELECT project_id, started_at FROM sessions WHERE id = ?').get(ID.s1) as { project_id: Buffer; started_at: number };
    assert.deepEqual(Buffer.from(session.project_id), altId);
    assert.equal(session.started_at, 3000);
  } finally {
    db.close();
  }
  const landed = join(dest, 'wiki', wikiUuid(hex(ID.wsDest)), wikiUuid(hex(altId)), 'notes', 'a.md');
  assert.equal(await readFile(landed, 'utf8'), 'nota atual');
});

test('unknown source scope and missing destination target fail with nothing written', async () => {
  const { from, dest } = await sourceAndDestination();
  const contentBefore = contentDigest(join(dest, DB));
  const counts = rowCounts(dest);
  const unknownSource = await run(from, dest, true, {
    scope: { source: { workspace: 'nope', project: 'x' }, target: SCOPE_JEV.target }
  });
  assert.equal(unknownSource.status, 'failed');
  assert.equal(unknownSource.error, 'Escopo nope/x não existe na origem');
  assert.equal(unknownSource.destination.backup, null);
  const missingTarget = await run(from, dest, true, {
    scope: { source: SCOPE_JEV.source, target: { workspace: 'jev-suite', project: 'ausente' } }
  });
  assert.equal(missingTarget.status, 'failed');
  assert.equal(
    missingTarget.error,
    'Escopo de destino jev-suite/ausente não existe no destino; abra uma sessão no projeto antes de migrar'
  );
  assert.equal(missingTarget.destination.backup, null);
  assert.equal(contentDigest(join(dest, DB)), contentBefore);
  assert.deepEqual(rowCounts(dest), counts);
});

test('running the same scoped apply twice inserts nothing the second time', async () => {
  const { from, dest } = await sourceAndDestination();
  const first = await run(from, dest, true, { scope: SCOPE_JEV });
  assert.equal(first.status, 'ok', first.error ?? '');
  const wikiAfterFirst = await treeDigest(join(dest, 'wiki'));
  const second = await run(from, dest, true, { scope: SCOPE_JEV });
  assert.equal(second.status, 'ok', second.error ?? '');
  for (const name of Object.keys(second.tables)) assert.equal(findTable(second, name).inserted, 0, name);
  assert.equal(second.wiki?.created.length, 0);
  assert.deepEqual(await treeDigest(join(dest, 'wiki')), wikiAfterFirst);
});

test('handoffs whose cwd lies outside the project root are excluded and counted; inside ones are kept', async () => {
  const { from, dest } = await sourceAndDestination();
  const projectRoot = join(await temp('jev-handoff-'), 'proj');
  const outside = join(projectRoot, '..', 'elsewhere');
  const insideForward = `${projectRoot.replace(/\\/g, '/')}/fwd`;
  const insideCase = join(projectRoot.toUpperCase(), 'UP');
  const outsideId = blobId('handoff-outside');
  const forwardId = blobId('handoff-forward');
  const caseId = blobId('handoff-case');
  const noCwdId = blobId('handoff-no-cwd');
  const handoff = (id: Buffer, cwd: string | null) => ({
    id, workspace_id: ID.wsSrc, project_id: ID.pSrc, from_session_id: ID.s1, from_agent: 'claude', to_agent: 'codex',
    summary: 'resumo', state: 'open', created_at: 6100, cwd
  });
  withDb(from, db => {
    insert(db, 'handoffs', handoff(outsideId, outside));
    insert(db, 'handoffs', handoff(forwardId, insideForward));
    insert(db, 'handoffs', handoff(caseId, insideCase));
    insert(db, 'handoffs', handoff(noCwdId, null));
  });
  const report = await run(from, dest, true, { handoffRoot: projectRoot });
  assert.equal(report.status, 'ok', report.error ?? '');
  // On win32 the upper-cased path is the same directory; elsewhere it is a different path and is excluded.
  const windows = process.platform === 'win32';
  assert.equal(report.excluded.handoffsOutsideProject, windows ? 1 : 2);
  assert.equal(findTable(report, 'handoffs').inserted, windows ? 4 : 3);
  const db = open(dest);
  try {
    const present = (id: Buffer) => (db.prepare('SELECT count(*) AS n FROM handoffs WHERE id = ?').get(id) as { n: number }).n;
    assert.equal(present(outsideId), 0, 'handoff outside the root is not migrated');
    assert.equal(present(forwardId), 1, 'forward-slash path inside the root is migrated');
    assert.equal(present(caseId), windows ? 1 : 0, 'case-folded path is inside only on win32');
    assert.equal(present(noCwdId), 1, 'handoff without cwd is kept');
    assert.equal(present(ID.h1), 1, 'fixture handoff without cwd is kept');
  } finally {
    db.close();
  }
});

test('dry-run in scoped mode plans the copy but writes nothing to the destination', async () => {
  const { from, dest } = await sourceAndDestination();
  const dbBefore = await readFile(join(dest, DB));
  const treeBefore = await treeDigest(dest);
  const report = await run(from, dest, false, { scope: SCOPE_JEV });
  assert.equal(report.status, 'ok', report.error ?? '');
  assert.equal(report.mode, 'dry-run');
  assert.equal(findTable(report, 'pages').inserted, 2);
  assert.deepEqual(await readFile(join(dest, DB)), dbBefore);
  assert.deepEqual(await treeDigest(dest), treeBefore);
});
