import type { DatabaseSync, StatementSync, SQLInputValue } from 'node:sqlite';
import { posix, win32 } from 'node:path';
import { TABLE_SPECS, requiredSourceColumns, type Ref, type TableSpec } from './migrate-spec.js';

// Row-level planning and insertion for the history migration. Every decision is made against the
// destination connection, so the same code drives both the dry-run (on a copy) and the apply.

export type Row = Record<string, unknown>;
export type RowStatus = 'inserted' | 'alreadyPresent' | 'conflict';
export interface Outcome { status: RowStatus; reason?: string; destId?: Uint8Array; }
export interface TableCount {
  source: number; inserted: number; alreadyPresent: number; conflict: number;
  conflicts: { id: string; reason: string }[];
}
export interface IdMapping {
  kind: 'workspace' | 'project';
  name: string;
  workspace?: string;
  sourceId: string;
  destId: string | null;
  status: 'mapped' | 'created' | 'conflict';
  reason?: string;
  sourceWorkspaceId?: string;
  destWorkspaceId?: string | null;
}
export interface Plan {
  tables: Record<string, TableCount>; mappings: IdMapping[]; insertedPages: string[];
  excluded: { handoffsOutsideProject: number };
}
export interface ScopeName { workspace: string; project: string; }
export interface ScopeSelection { source: ScopeName; target: ScopeName; }
// Source ids are hex strings (row-id comparison); destination ids are the blobs used for inserts.
export interface ScopeIds { sourceWorkspace: string; sourceProject: string; destWorkspace: Uint8Array; destProject: Uint8Array; }
export interface ColumnInfo { name: string; notnull: boolean; hasDefault: boolean; pk: number; }
export interface CompatibilityReport { checked: string[]; issues: string[]; }

const MAX_LISTED_CONFLICTS = 50;
const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export function hexOf(value: unknown): string {
  return value instanceof Uint8Array ? Buffer.from(value).toString('hex') : String(value);
}
export function quoteIdentifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`Identificador inválido na migração: ${name}`);
  return `"${name}"`;
}
export function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Uint8Array || b instanceof Uint8Array) {
    return a instanceof Uint8Array && b instanceof Uint8Array && Buffer.compare(a, b) === 0;
  }
  return a === b;
}
function asBlob(value: unknown): Uint8Array | undefined {
  return value instanceof Uint8Array ? value : undefined;
}
function display(row: Row, keys: readonly string[]): string {
  return keys.map(k => (row[k] instanceof Uint8Array ? hexOf(row[k]) : String(row[k]))).join('/');
}
// Stable key for a row's primary key; the same encoding is used for parent lookups by `id`.
function encode(row: Row, keys: readonly string[]): string {
  return JSON.stringify(keys.map(k => {
    const v = row[k];
    if (v instanceof Uint8Array) return `x${hexOf(v)}`;
    return v === null || v === undefined ? 'n' : `t${String(v)}`;
  }));
}

class Statements {
  private readonly cache = new Map<string, StatementSync>();
  constructor(private readonly db: DatabaseSync) {}
  get(sql: string): StatementSync {
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.cache.set(sql, statement);
    }
    return statement;
  }
}

export function tableExists(db: DatabaseSync, table: string): boolean {
  return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}
export function columnsOf(db: DatabaseSync, table: string): ColumnInfo[] {
  const rows = db.prepare('SELECT name, "notnull" AS nn, dflt_value AS dflt, pk FROM pragma_table_info(?)').all(table) as
    { name: string; nn: number; dflt: string | null; pk: number }[];
  return rows.map(r => ({ name: r.name, notnull: r.nn === 1, hasDefault: r.dflt !== null, pk: r.pk }));
}
export function countRows(db: DatabaseSync, table: string): number {
  const row = db.prepare(`SELECT count(*) AS n FROM ${quoteIdentifier(table)}`).get() as { n: number };
  return row.n;
}
export function refineryVersion(db: DatabaseSync): number | null {
  if (!tableExists(db, 'refinery_schema_history')) return null;
  const row = db.prepare('SELECT max(version) AS v FROM refinery_schema_history').get() as { v: number | null };
  return row.v;
}

// Compares the source schema with the destination for every migrated table. Any issue aborts the run.
export function checkCompatibility(dest: DatabaseSync, source: DatabaseSync): CompatibilityReport {
  const checked: string[] = [];
  const issues: string[] = [];
  for (const spec of TABLE_SPECS) {
    if (!tableExists(dest, spec.name)) { issues.push(`${spec.name}: tabela ausente no destino`); continue; }
    if (!tableExists(source, spec.name)) continue;
    checked.push(spec.name);
    issues.push(...compareTable(spec, columnsOf(source, spec.name), columnsOf(dest, spec.name)));
  }
  return { checked, issues };
}
function compareTable(spec: TableSpec, src: ColumnInfo[], dst: ColumnInfo[]): string[] {
  const srcNames = new Set(src.map(c => c.name));
  const dstNames = new Set(dst.map(c => c.name));
  const problems: string[] = [];
  const missingInDest = [...srcNames].filter(c => !dstNames.has(c));
  if (missingInDest.length > 0) problems.push(`${spec.name}: colunas da origem ausentes no destino: ${missingInDest.join(', ')}`);
  const unfilled = dst.filter(c => !srcNames.has(c.name) && (c.pk > 0 || (c.notnull && !c.hasDefault))).map(c => c.name);
  if (unfilled.length > 0) problems.push(`${spec.name}: colunas obrigatórias do destino sem valor na origem: ${unfilled.join(', ')}`);
  const absent = requiredSourceColumns(spec).filter(c => !srcNames.has(c));
  if (absent.length > 0) problems.push(`${spec.name}: colunas esperadas ausentes na origem: ${absent.join(', ')}`);
  return problems;
}

interface Context {
  readonly dest: DatabaseSync;
  readonly sql: Statements;
  readonly statuses: Map<string, Map<string, RowStatus>>;
  readonly ids: Record<'workspaces' | 'projects', Map<string, Uint8Array>>;
  readonly workspaceNames: Map<string, string>;
  readonly primaryKeys: Map<string, string[]>;
  // Source ids of the rows selected for each table; used by scoped refs of tables without a project column.
  readonly keptIds: Map<string, Set<string>>;
  readonly scope: ScopeIds | undefined;
  readonly handoffRoot: string | undefined;
  readonly plan: Plan;
}

// Resolves the scope in both databases. Nothing is written here; it only reads.
export function resolveScope(dest: DatabaseSync, source: DatabaseSync, scope: ScopeSelection): ScopeIds {
  const sourceWorkspace = findId(source, 'SELECT "id" FROM "workspaces" WHERE "name" = ? LIMIT 1', scope.source.workspace);
  const sourceProject = sourceWorkspace && findId(
    source, 'SELECT "id" FROM "projects" WHERE "workspace_id" = ? AND "name" = ? LIMIT 1', sourceWorkspace, scope.source.project
  );
  if (!sourceWorkspace || !sourceProject) {
    throw new Error(`Escopo ${scope.source.workspace}/${scope.source.project} não existe na origem`);
  }
  const destWorkspace = findId(dest, 'SELECT "id" FROM "workspaces" WHERE "name" = ? LIMIT 1', scope.target.workspace);
  const destProject = destWorkspace && findId(
    dest, 'SELECT "id" FROM "projects" WHERE "workspace_id" = ? AND "name" = ? LIMIT 1', destWorkspace, scope.target.project
  );
  if (!destWorkspace || !destProject) {
    throw new Error(
      `Escopo de destino ${scope.target.workspace}/${scope.target.project} não existe no destino; abra uma sessão no projeto antes de migrar`
    );
  }
  return {
    sourceWorkspace: hexOf(sourceWorkspace), sourceProject: hexOf(sourceProject), destWorkspace, destProject
  };
}
function findId(db: DatabaseSync, sql: string, ...params: SQLInputValue[]): Uint8Array | undefined {
  const row = db.prepare(sql).get(...params) as { id: unknown } | undefined;
  return asBlob(row?.id);
}

// Plans (and, on the connection's open transaction, inserts) every migrated table in dependency order.
// With a scope, only that source project is copied, under the target project of the destination.
export function planMigration(dest: DatabaseSync, source: DatabaseSync, scope?: ScopeSelection, handoffRoot?: string): Plan {
  const ctx: Context = {
    dest, sql: new Statements(dest), statuses: new Map(), workspaceNames: new Map(),
    ids: { workspaces: new Map(), projects: new Map() }, primaryKeys: new Map(), keptIds: new Map(),
    scope: scope ? resolveScope(dest, source, scope) : undefined, handoffRoot,
    plan: { tables: {}, mappings: [], insertedPages: [], excluded: { handoffsOutsideProject: 0 } }
  };
  for (const spec of TABLE_SPECS) planTable(ctx, source, spec);
  return ctx.plan;
}

function emptyCount(): TableCount {
  return { source: 0, inserted: 0, alreadyPresent: 0, conflict: 0, conflicts: [] };
}
function planTable(ctx: Context, source: DatabaseSync, spec: TableSpec): void {
  const count = emptyCount();
  ctx.plan.tables[spec.name] = count;
  if (!tableExists(source, spec.name)) return;
  const rows = selectRows(ctx, spec, source.prepare(`SELECT * FROM ${quoteIdentifier(spec.name)}`).all() as Row[]);
  ctx.keptIds.set(spec.name, new Set(rows.map(row => hexOf(row.id))));
  count.source = rows.length;
  const keys = primaryKeyOf(ctx, spec.name);
  for (const row of orderRows(rows, spec.selfRef)) {
    const outcome = anchorOutcome(ctx, spec) ?? decide(ctx, spec, row);
    record(ctx, spec, row, keys, outcome, count);
  }
}

// Rows outside the selected scope, and handoffs outside the project root, are not part of the migration.
function selectRows(ctx: Context, spec: TableSpec, rows: Row[]): Row[] {
  const scope = ctx.scope;
  const scoped = scope === undefined ? rows : rows.filter(row => inScope(ctx, spec, row, scope));
  const allowed = scoped.filter(row => handoffAllowed(ctx.handoffRoot, spec, row));
  ctx.plan.excluded.handoffsOutsideProject += scoped.length - allowed.length;
  return allowed;
}
function inScope(ctx: Context, spec: TableSpec, row: Row, scope: ScopeIds): boolean {
  if (spec.name === 'workspaces') return hexOf(row.id) === scope.sourceWorkspace;
  if (spec.name === 'projects') return hexOf(row.id) === scope.sourceProject;
  if (spec.remap.some(r => r.column === 'project_id')) return hexOf(row.project_id) === scope.sourceProject;
  // Tables without a project column: every non-null reference must point to a row already selected.
  return spec.refs.every(reference => {
    const value = row[reference.column];
    if (value === null || value === undefined) return true;
    return ctx.keptIds.get(reference.table)?.has(hexOf(value)) === true;
  });
}
function handoffAllowed(root: string | undefined, spec: TableSpec, row: Row): boolean {
  if (root === undefined || spec.name !== 'handoffs') return true;
  const cwd = row.cwd;
  return typeof cwd !== 'string' || cwd === '' || isWithinRoot(cwd, root);
}

// In scoped mode the selected workspace and project are not inserted: they map onto the chosen targets.
function anchorOutcome(ctx: Context, spec: TableSpec): Outcome | undefined {
  if (!ctx.scope) return undefined;
  if (spec.name === 'workspaces') return { status: 'alreadyPresent', destId: ctx.scope.destWorkspace };
  if (spec.name === 'projects') return { status: 'alreadyPresent', destId: ctx.scope.destProject };
  return undefined;
}

const PATH_API = process.platform === 'win32' ? win32 : posix;
function withTrailingSep(path: string): string {
  return path.endsWith(PATH_API.sep) ? path : `${path}${PATH_API.sep}`;
}
// True when cwd is the root or lies below it. Windows paths compare case-insensitively.
function isWithinRoot(cwd: string, root: string): boolean {
  const fold = (path: string): string => {
    const normal = withTrailingSep(PATH_API.normalize(path));
    return process.platform === 'win32' ? normal.toLowerCase() : normal;
  };
  return fold(cwd).startsWith(fold(root));
}

// Parents first for self-references (pages.supersedes). A cycle is left for the parent check to reject.
export function orderRows(rows: Row[], selfRef: string | undefined): Row[] {
  if (!selfRef) return rows;
  const byId = new Map(rows.map(r => [hexOf(r.id), r] as const));
  const ordered: Row[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  const visit = (row: Row): void => {
    const id = hexOf(row.id);
    if (done.has(id) || visiting.has(id)) return;
    visiting.add(id);
    const parent = row[selfRef];
    const parentRow = parent instanceof Uint8Array ? byId.get(hexOf(parent)) : undefined;
    if (parentRow) visit(parentRow);
    visiting.delete(id);
    done.add(id);
    ordered.push(row);
  };
  rows.forEach(visit);
  return ordered;
}

function primaryKeyOf(ctx: Context, table: string): string[] {
  const cached = ctx.primaryKeys.get(table);
  if (cached) return cached;
  const keys = columnsOf(ctx.dest, table).filter(c => c.pk > 0).sort((a, b) => a.pk - b.pk).map(c => c.name);
  ctx.primaryKeys.set(table, keys);
  return keys;
}

function record(ctx: Context, spec: TableSpec, row: Row, keys: string[], outcome: Outcome, count: TableCount): void {
  setStatus(ctx, spec.name, encode(row, keys), outcome.status);
  if (outcome.status === 'conflict') {
    count.conflict += 1;
    if (count.conflicts.length < MAX_LISTED_CONFLICTS) {
      count.conflicts.push({ id: display(row, keys), reason: outcome.reason ?? 'conflict' });
    }
  } else if (outcome.status === 'inserted') {
    count.inserted += 1;
  } else {
    count.alreadyPresent += 1;
  }
  if (outcome.status === 'inserted' && spec.name === 'pages') ctx.plan.insertedPages.push(hexOf(row.id));
  if (spec.name === 'workspaces' && outcome.destId) ctx.workspaceNames.set(hexOf(row.id), String(row.name));
  if (spec.maps) recordMapping(ctx, spec, row, outcome);
}
function setStatus(ctx: Context, table: string, key: string, status: RowStatus): void {
  let byKey = ctx.statuses.get(table);
  if (!byKey) { byKey = new Map(); ctx.statuses.set(table, byKey); }
  byKey.set(key, status);
}
function recordMapping(ctx: Context, spec: TableSpec, row: Row, outcome: Outcome): void {
  const isProject = spec.maps === 'projects';
  const sourceWorkspace = isProject ? hexOf(row.workspace_id) : undefined;
  const destWorkspace = sourceWorkspace === undefined ? undefined : ctx.ids.workspaces.get(sourceWorkspace);
  if (outcome.destId) ctx.ids[spec.maps!].set(hexOf(row.id), outcome.destId);
  ctx.plan.mappings.push({
    kind: isProject ? 'project' : 'workspace',
    name: String(row.name),
    ...(isProject && { workspace: ctx.workspaceNames.get(sourceWorkspace ?? '') ?? sourceWorkspace }),
    sourceId: hexOf(row.id),
    destId: outcome.destId ? hexOf(outcome.destId) : null,
    status: outcome.status === 'conflict' ? 'conflict' : outcome.status === 'inserted' ? 'created' : 'mapped',
    ...(outcome.reason && { reason: outcome.reason }),
    ...(isProject && { sourceWorkspaceId: sourceWorkspace, destWorkspaceId: destWorkspace ? hexOf(destWorkspace) : null })
  });
}

function decide(ctx: Context, spec: TableSpec, row: Row): Outcome {
  const values = remapRow(ctx, spec, row);
  const broken = unresolvedRef(ctx, spec, row);
  if (broken) return { status: 'conflict', reason: broken };
  const named = findByNaturalKey(ctx, spec, values);
  if (named) return { status: 'alreadyPresent', destId: named };
  const existing = findByPrimaryKey(ctx, spec, values);
  if (existing) return compareWithExisting(values, existing, asBlob(row.id));
  const guard = INSERT_GUARDS[spec.name]?.(ctx, values);
  if (guard) return { status: 'conflict', reason: guard };
  insertRow(ctx, spec, values);
  return { status: 'inserted', destId: asBlob(row.id) };
}

function remapRow(ctx: Context, spec: TableSpec, row: Row): Row {
  const values: Row = { ...row };
  for (const remap of spec.remap) {
    const mapped = ctx.ids[remap.to].get(hexOf(row[remap.column]));
    if (mapped) values[remap.column] = mapped;
  }
  return values;
}

// A foreign key is satisfied when its parent is migrated (or already present) in the destination.
function unresolvedRef(ctx: Context, spec: TableSpec, row: Row): string | undefined {
  const refs: Ref[] = [
    ...spec.remap.map(r => ({ column: r.column, table: r.to, nullable: false })),
    ...spec.refs
  ];
  for (const reference of refs) {
    const value = row[reference.column];
    if (value === null || value === undefined) {
      if (!reference.nullable) return `missing required reference ${reference.column}`;
      continue;
    }
    if (!parentAvailable(ctx, reference.table, value)) {
      return `parent not migrated (${reference.table} via ${reference.column})`;
    }
  }
  return undefined;
}
function parentAvailable(ctx: Context, table: string, value: unknown): boolean {
  const status = ctx.statuses.get(table)?.get(encode({ id: value }, ['id']));
  if (status !== undefined) return status !== 'conflict';
  const found = ctx.sql.get(`SELECT 1 AS found FROM ${quoteIdentifier(table)} WHERE "id" = ? LIMIT 1`)
    .get(value as SQLInputValue);
  return found !== undefined;
}

// Same logical object already present under another id (name mapping) is reused, not duplicated.
function findByNaturalKey(ctx: Context, spec: TableSpec, values: Row): Uint8Array | undefined {
  const keys = spec.naturalKey ?? [];
  if (keys.length === 0) return undefined;
  const where = keys.map(k => `${quoteIdentifier(k)} = ?`).join(' AND ');
  const hit = ctx.sql.get(`SELECT "id" FROM ${quoteIdentifier(spec.name)} WHERE ${where} LIMIT 1`)
    .get(...keys.map(k => values[k] as SQLInputValue)) as { id: unknown } | undefined;
  return asBlob(hit?.id);
}
function findByPrimaryKey(ctx: Context, spec: TableSpec, values: Row): Row | undefined {
  const keys = primaryKeyOf(ctx, spec.name);
  const where = keys.map(k => `${quoteIdentifier(k)} = ?`).join(' AND ');
  return ctx.sql.get(`SELECT * FROM ${quoteIdentifier(spec.name)} WHERE ${where} LIMIT 1`)
    .get(...keys.map(k => values[k] as SQLInputValue)) as Row | undefined;
}
function compareWithExisting(values: Row, existing: Row, id: Uint8Array | undefined): Outcome {
  for (const column of Object.keys(values)) {
    if (!sameValue(values[column], existing[column])) return { status: 'conflict', reason: 'same id, different content' };
  }
  return { status: 'alreadyPresent', destId: id };
}

// Extra invariants that the destination enforces only through unique indexes (checked before insert).
const INSERT_GUARDS: Partial<Record<string, (ctx: Context, values: Row) => string | undefined>> = {
  pages: (ctx, values) => {
    if (values.is_latest !== 1) return undefined;
    const hit = ctx.sql.get(
      'SELECT "id" FROM "pages" WHERE "workspace_id" = ? AND "project_id" = ? AND "path" = ? AND "is_latest" = 1 LIMIT 1'
    ).get(values.workspace_id as SQLInputValue, values.project_id as SQLInputValue, values.path as SQLInputValue);
    return hit ? 'latest path already present in destination for this project' : undefined;
  },
  projects: (ctx, values) => {
    if (typeof values.identity !== 'string' || values.identity === '') return undefined;
    const hit = ctx.sql.get(
      'SELECT "id" FROM "projects" WHERE "workspace_id" = ? AND "identity" = ? AND "identity" <> \'\' LIMIT 1'
    ).get(values.workspace_id as SQLInputValue, values.identity);
    return hit ? 'identity already used by another project in destination' : undefined;
  }
};

function insertRow(ctx: Context, spec: TableSpec, values: Row): void {
  const columns = Object.keys(values);
  const names = columns.map(quoteIdentifier).join(', ');
  const marks = columns.map(() => '?').join(', ');
  ctx.sql.get(`INSERT INTO ${quoteIdentifier(spec.name)} (${names}) VALUES (${marks})`)
    .run(...columns.map(c => values[c] as SQLInputValue));
}
