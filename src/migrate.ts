import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { connect } from 'node:net';
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { profileDir, readConfig, root } from './config.js';
import { supervisorState, type SupervisorState } from './lifecycle.js';
import { MIGRATED_TABLES, isDerivedTable, notMigratedReason } from './migrate-spec.js';
import {
  checkCompatibility, countRows, planMigration, refineryVersion, resolveScope,
  type CompatibilityReport, type IdMapping, type ScopeName, type ScopeSelection, type TableCount
} from './migrate-db.js';
import { integrityOf, validateDestination, type ValidationReport } from './migrate-validate.js';
import { copyWikiJobs, emptyWikiResult, wikiUuid, type WikiJob, type WikiResult } from './migrate-wiki.js';

// Orchestration of the history migration: staging, preflight, backup, one transaction, wiki copy,
// source-integrity check and the JSON evidence report. Dry-run takes the same path on a copy of the
// destination and never writes to it.

export type MigrationMode = 'dry-run' | 'apply';
export interface MigrateInput {
  from: string;
  dest: string;
  workDir: string;
  apply: boolean;
  preflight?: () => Promise<void>;
  hooks?: { beforeCommit?: (db: DatabaseSync) => void };
  // Copies only this source project, into the destination project named by `target`.
  scope?: ScopeSelection;
  // Handoffs whose cwd is set and lies outside this root are not migrated.
  handoffRoot?: string;
}
export interface NotMigrated { table: string; rows: number | null; reason: string; }
export interface MigrationReport {
  schemaVersion: 1;
  mode: MigrationMode;
  status: 'ok' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  scope: ScopeSelection | null;
  source: { dataDir: string; refineryVersion: number | null; files: FileDigest | null; unchanged: boolean | null };
  destination: {
    dataDir: string; refineryVersion: number | null;
    backup: { dir: string; file: string; sha256sums: string } | null;
  };
  compatibility: CompatibilityReport;
  mappings: IdMapping[];
  tables: Record<string, TableCount>;
  excluded: { handoffsOutsideProject: number };
  notMigrated: NotMigrated[];
  validation: ValidationReport | null;
  wiki: WikiResult | null;
  rollback: string[];
  evidence: string | null;
}
interface FileDigest { db: Record<string, string>; wikiFiles: number; sha256: string; }
type Manifest = Map<string, string>;

const DB_RELATIVE = join('db', 'memory.sqlite');
const SIDECARS = ['', '-wal', '-shm'] as const;
const BUSY_TIMEOUT_MS = 5000;
const PORT_PROBE_MS = 1000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Falha desconhecida na migração';
}
async function ensureDir(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return path;
}
async function fileExists(path: string): Promise<boolean> {
  const info = await stat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  return info?.isFile() ?? false;
}
async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  return info?.isDirectory() ?? false;
}
async function writeNew(path: string, text: string): Promise<void> {
  await writeFile(path, text, { flag: 'wx', mode: 0o600 });
}
async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Hashes the database and WAL plus every wiki file. The -shm index is excluded: readers may touch it.
async function manifestOf(dataDir: string): Promise<Manifest> {
  const entries: Manifest = new Map();
  for (const rel of ['db/memory.sqlite', 'db/memory.sqlite-wal']) {
    const path = join(dataDir, rel);
    if (await fileExists(path)) entries.set(rel, await sha256File(path));
  }
  const wiki = join(dataDir, 'wiki');
  if (await isDirectory(wiki)) {
    for (const name of await readdir(wiki, { recursive: true })) {
      const path = join(wiki, name);
      if ((await lstat(path)).isFile()) entries.set(`wiki/${name.split(sep).join('/')}`, await sha256File(path));
    }
  }
  return entries;
}
function digestOf(manifest: Manifest): FileDigest {
  const sorted = [...manifest].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const combined = createHash('sha256');
  for (const [name, hash] of sorted) combined.update(`${name} ${hash}\n`);
  return {
    db: Object.fromEntries(sorted.filter(([name]) => !name.startsWith('wiki/'))),
    wikiFiles: sorted.filter(([name]) => name.startsWith('wiki/')).length,
    sha256: combined.digest('hex')
  };
}
function sameManifest(a: Manifest, b: Manifest): boolean {
  if (a.size !== b.size) return false;
  return [...a].every(([name, hash]) => b.get(name) === hash);
}

// Copies a database and its sidecars into staging. Both the source and the dry-run destination are
// only ever read through such copies, so the original files are never opened by this process.
async function stageDatabase(dataDir: string, target: string, suffixes: readonly string[]): Promise<string> {
  const out = await ensureDir(target);
  for (const suffix of suffixes) {
    const path = join(dataDir, 'db', `memory.sqlite${suffix}`);
    if (await fileExists(path)) await copyFile(path, join(out, `memory.sqlite${suffix}`));
  }
  return join(out, 'memory.sqlite');
}
async function openDestination(input: MigrateInput, staging: string): Promise<DatabaseSync> {
  const live = join(input.dest, DB_RELATIVE);
  if (!(await fileExists(live))) throw new Error('Destino sem db/memory.sqlite; inicialize a memória do perfil antes de migrar');
  if (input.apply) return new DatabaseSync(live);
  // Dry-run works on a copy; the volatile -shm index is left out and rebuilt by SQLite.
  const copy = await stageDatabase(input.dest, join(staging, 'dest'), ['', '-wal']);
  return new DatabaseSync(copy);
}
async function backupDestination(work: DatabaseSync, dir: string): Promise<NonNullable<MigrationReport['destination']['backup']>> {
  await ensureDir(dir);
  const file = join(dir, 'memory.sqlite');
  work.prepare('VACUUM INTO ?').run(file);
  const sums = join(dir, 'SHA256SUMS');
  await writeNew(sums, `${await sha256File(file)}  memory.sqlite\n`);
  return { dir, file, sha256sums: sums };
}

function assertIntegrity(db: DatabaseSync, label: string): void {
  const result = integrityOf(db);
  if (result !== 'ok') throw new Error(`integrity_check falhou em ${label}: ${result}`);
}
function countMigrated(db: DatabaseSync): Record<string, number> {
  return Object.fromEntries(MIGRATED_TABLES.map(t => [t, countRows(db, t)]));
}
function insertedCounts(tables: Record<string, TableCount>): Record<string, number> {
  return Object.fromEntries(Object.entries(tables).map(([t, c]) => [t, c.inserted]));
}
function notMigrated(source: DatabaseSync): NotMigrated[] {
  const names = source.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name")
    .all() as { name: string }[];
  return names
    .filter(({ name }) => !MIGRATED_TABLES.includes(name))
    .map(({ name }) => ({
      table: name,
      rows: isDerivedTable(name) ? null : countRows(source, name),
      reason: notMigratedReason(name)
    }));
}

// Each mapped workspace and project gets its wiki directory copied. Conflicting ones are skipped.
function wikiJobs(input: MigrateInput, mappings: IdMapping[]): WikiJob[] {
  const jobs: WikiJob[] = [];
  for (const m of mappings) {
    if (m.status === 'conflict' || !m.destId) continue;
    if (m.kind === 'workspace' && input.scope) continue; // A scoped copy carries one project's pages, never another workspace's root files.
    if (m.kind === 'workspace') {
      const destRel = wikiUuid(m.destId);
      jobs.push({
        srcDir: join(input.from, 'wiki', wikiUuid(m.sourceId)),
        destDir: join(input.dest, 'wiki', destRel), destRel, recursive: false
      });
    } else if (m.sourceWorkspaceId && m.destWorkspaceId) {
      const destRel = `${wikiUuid(m.destWorkspaceId)}/${wikiUuid(m.destId)}`;
      jobs.push({
        srcDir: join(input.from, 'wiki', wikiUuid(m.sourceWorkspaceId), wikiUuid(m.sourceId)),
        destDir: join(input.dest, 'wiki', destRel), destRel, recursive: true
      });
    }
  }
  return jobs;
}

interface RunContext {
  readonly input: MigrateInput;
  readonly report: MigrationReport;
  readonly stamp: string;
  readonly staging: string;
  readonly opened: DatabaseSync[];
}

function checkSchemas(ctx: RunContext, source: DatabaseSync, work: DatabaseSync): void {
  const compat = checkCompatibility(work, source);
  ctx.report.compatibility = compat;
  if (compat.issues.length > 0) {
    throw new Error(`Esquemas incompatíveis; nada foi gravado:\n- ${compat.issues.join('\n- ')}`);
  }
  const sourceVersion = refineryVersion(source);
  const destVersion = refineryVersion(work);
  ctx.report.source.refineryVersion = sourceVersion;
  ctx.report.destination.refineryVersion = destVersion;
  if (sourceVersion === null || destVersion === null) throw new Error('refinery_schema_history ausente na origem ou no destino');
  if (sourceVersion > destVersion) {
    throw new Error(`Versão de schema da origem (${sourceVersion}) é maior que a do destino (${destVersion})`);
  }
}
// Scope errors are raised before any backup is taken, so a refused run leaves no evidence of writes.
function checkScope(ctx: RunContext, source: DatabaseSync, work: DatabaseSync): void {
  if (ctx.input.scope) resolveScope(work, source, ctx.input.scope);
}

// One transaction covers every insert. Dry-run always rolls back; apply commits only after the FK check.
function migrateInTransaction(ctx: RunContext, source: DatabaseSync, work: DatabaseSync, before: Record<string, number>): void {
  const { input, report } = ctx;
  work.exec('BEGIN IMMEDIATE');
  let committed = false;
  try {
    work.exec('PRAGMA defer_foreign_keys = ON');
    const plan = planMigration(work, source, input.scope, input.handoffRoot);
    report.tables = plan.tables;
    report.mappings = plan.mappings;
    report.excluded = plan.excluded;
    input.hooks?.beforeCommit?.(work);
    const violations = work.prepare('PRAGMA foreign_key_check').all();
    if (violations.length > 0) throw new Error(`foreign_key_check: ${violations.length} violação(ões); nada foi gravado`);
    if (input.apply) {
      work.exec('COMMIT');
      committed = true;
    }
    report.validation = validateDestination(work, source, {
      before, inserted: insertedCounts(plan.tables), insertedPages: plan.insertedPages
    });
  } finally {
    if (!committed && work.isTransaction) work.exec('ROLLBACK');
  }
}

async function runMigration(ctx: RunContext): Promise<void> {
  const { input, report } = ctx;
  const source = new DatabaseSync(await stageDatabase(input.from, join(ctx.staging, 'source'), SIDECARS));
  ctx.opened.push(source);
  const work = await openDestination(input, ctx.staging);
  ctx.opened.push(work);
  work.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  work.exec('PRAGMA foreign_keys = ON');
  report.source.refineryVersion = refineryVersion(source);
  assertIntegrity(source, 'origem');
  assertIntegrity(work, 'destino');
  report.notMigrated = notMigrated(source);
  checkSchemas(ctx, source, work);
  checkScope(ctx, source, work);
  if (input.apply) {
    report.destination.backup = await backupDestination(work, join(input.workDir, 'backups', `migration-${ctx.stamp}`));
  }
  migrateInTransaction(ctx, source, work, countMigrated(work));
  if (report.validation?.ok !== true) throw new Error('Validação pós-migração falhou; cópia de wiki não executada');
  report.wiki = emptyWikiResult();
  await copyWikiJobs(wikiJobs(input, report.mappings), input.apply, report.wiki);
}

function rollbackSteps(report: MigrationReport, dest: string): string[] {
  const backup = report.destination.backup;
  if (!backup) return ['Nenhuma escrita foi feita no destino; nada a reverter.'];
  return [
    'Pare o suite: jev-memory stop',
    `Restaure o banco: copie ${backup.file} para ${join(dest, DB_RELATIVE)} e remova memory.sqlite-wal e memory.sqlite-shm do destino`,
    `Confira o hash do backup em ${backup.sha256sums}`,
    `Apague os arquivos de wiki criados (lista em wiki.created, relativa a ${join(dest, 'wiki')}; ${report.wiki?.created.length ?? 0} arquivos)`,
    'Inicie o suite: jev-memory start'
  ];
}

function newReport(input: MigrateInput, mode: MigrationMode, startedAt: Date): MigrationReport {
  return {
    schemaVersion: 1, mode, status: 'failed', startedAt: startedAt.toISOString(), finishedAt: null, error: null,
    scope: input.scope ?? null,
    source: { dataDir: input.from, refineryVersion: null, files: null, unchanged: null },
    destination: { dataDir: input.dest, refineryVersion: null, backup: null },
    compatibility: { checked: [], issues: [] }, mappings: [], tables: {}, excluded: { handoffsOutsideProject: 0 },
    notMigrated: [], validation: null, wiki: null, rollback: [], evidence: null
  };
}

async function writeEvidence(workDir: string, stamp: string, mode: MigrationMode, report: MigrationReport): Promise<void> {
  const dir = await ensureDir(join(workDir, 'evidence'));
  const file = join(dir, `migration-${stamp}-${mode === 'apply' ? 'apply' : 'dryrun'}.json`);
  report.evidence = file;
  await writeNew(file, `${JSON.stringify(report, null, 2)}\n`);
}

async function finalize(ctx: RunContext, before: Manifest | undefined): Promise<void> {
  const { input, report } = ctx;
  if (before) {
    const after = await manifestOf(input.from);
    report.source.unchanged = sameManifest(before, after);
    if (!report.source.unchanged && report.error === null) report.error = 'Fonte alterada durante a migração';
  }
  await rm(ctx.staging, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.status = report.error === null && report.validation?.ok === true && report.source.unchanged === true ? 'ok' : 'failed';
  report.rollback = rollbackSteps(report, input.dest);
  await writeEvidence(input.workDir, ctx.stamp, input.apply ? 'apply' : 'dry-run', report);
}

export async function migrateHistory(input: MigrateInput): Promise<MigrationReport> {
  const started = new Date();
  const stamp = started.toISOString().replace(/[:.]/g, '-');
  const report = newReport(input, input.apply ? 'apply' : 'dry-run', started);
  const staging = await mkdtemp(join(await ensureDir(join(input.workDir, 'tmp')), 'migrate-'));
  const ctx: RunContext = { input, report, stamp, staging, opened: [] };
  let before: Manifest | undefined;
  try {
    if (resolve(input.from) === resolve(input.dest)) throw new Error('A origem não pode ser o próprio destino');
    if (!(await fileExists(join(input.from, DB_RELATIVE)))) throw new Error('Origem sem db/memory.sqlite');
    if (input.apply) await input.preflight?.();
    before = await manifestOf(input.from);
    report.source.files = digestOf(before);
    await runMigration(ctx);
  } catch (error) {
    report.error = errorMessage(error);
  } finally {
    for (const db of ctx.opened) db.close();
  }
  await finalize(ctx, before);
  return report;
}

export async function assertSuiteStopped(
  state: () => Promise<SupervisorState>, memoryPort: number, probe: (port: number) => Promise<boolean> = portAccepts
): Promise<void> {
  if (await state() === 'running') throw new Error('pare a suíte: jev-memory stop');
  if (await probe(memoryPort)) throw new Error(`porta ${memoryPort} da memória aceita conexão; pare a suíte: jev-memory stop`);
}
// A port that answers, or does not answer in time, is treated as in use: the conservative choice.
function portAccepts(port: number): Promise<boolean> {
  return new Promise(done => {
    const socket = connect({ host: '127.0.0.1', port });
    const finish = (open: boolean) => { socket.destroy(); done(open); };
    socket.setTimeout(PORT_PROBE_MS, () => finish(true));
    socket.once('connect', () => finish(true));
    socket.once('error', (e: NodeJS.ErrnoException) => finish(e.code !== 'ECONNREFUSED'));
  });
}

// A scope part is one workspace or project name: 1 to 200 characters, no separators and no NUL.
const SCOPE_PATTERN = /^([^/\\\u0000]{1,200})\/([^/\\\u0000]{1,200})$/;
export function parseScopeName(text: string, flag: string): ScopeName {
  const match = SCOPE_PATTERN.exec(text);
  if (!match) throw new Error(`${flag} deve ser <workspace>/<projeto>, com 1 a 200 caracteres por parte e sem \\ ou / extra`);
  const [, workspace = '', project = ''] = match;
  return { workspace, project };
}
// --project selects the source project; --as picks the destination project (default: the same name).
export function scopeSelection(project: string | undefined, target: string | undefined): ScopeSelection | undefined {
  if (project === undefined) {
    if (target !== undefined) throw new Error('--as requer --project <workspace>/<projeto>');
    return undefined;
  }
  const source = parseScopeName(project, '--project');
  return { source, target: target === undefined ? source : parseScopeName(target, '--as') };
}

export async function runMigrateHistory(
  profile: string, from: string | undefined, apply: boolean, project?: string, target?: string
): Promise<void> {
  if (!from) throw new Error('migrate-history requer --from <diretório de dados da origem>');
  const scope = scopeSelection(project, target);
  const config = await readConfig(profile);
  const report = await migrateHistory({
    from: resolve(from),
    dest: resolve(profileDir(profile), 'memory'),
    workDir: resolve(root, '.local'),
    apply,
    preflight: () => assertSuiteStopped(() => supervisorState(profile), config.memory.port),
    scope,
    handoffRoot: config.projectRoot ?? root
  });
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== 'ok') process.exitCode = 1;
}
