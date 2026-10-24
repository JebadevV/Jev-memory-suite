// Static description of the history migration: which tables are copied, in which dependency order,
// and which foreign keys must resolve inside the destination before a row may be inserted.

export interface Ref {
  readonly column: string;
  readonly table: string;
  readonly nullable: boolean;
}

export interface Remap {
  // Source workspace/project id columns are rewritten to the destination id chosen by name mapping.
  readonly column: 'workspace_id' | 'project_id';
  readonly to: 'workspaces' | 'projects';
}

export interface TableSpec {
  readonly name: string;
  readonly remap: readonly Remap[];
  readonly refs: readonly Ref[];
  // Columns that identify an existing destination row for the same logical object (name mapping).
  readonly naturalKey?: readonly string[];
  // Table whose source ids are remapped through this table's name mapping.
  readonly maps?: 'workspaces' | 'projects';
  // Column referencing another row of the same table; parents are processed first.
  readonly selfRef?: string;
}

const WORKSPACE: Remap = { column: 'workspace_id', to: 'workspaces' };
const PROJECT: Remap = { column: 'project_id', to: 'projects' };
const ref = (column: string, table: string, nullable = false): Ref => ({ column, table, nullable });

// Dependency order: parents before children. Each table has an `id` primary key unless its
// composite primary key is listed in the destination schema (resolved at runtime via pragma).
export const TABLE_SPECS: readonly TableSpec[] = [
  { name: 'workspaces', remap: [], refs: [], naturalKey: ['name'], maps: 'workspaces' },
  { name: 'projects', remap: [WORKSPACE], refs: [ref('created_by', 'users', true)], naturalKey: ['workspace_id', 'name'], maps: 'projects' },
  { name: 'pages', remap: [WORKSPACE, PROJECT], refs: [ref('supersedes', 'pages', true), ref('author_id', 'users', true)], selfRef: 'supersedes' },
  { name: 'sessions', remap: [WORKSPACE, PROJECT], refs: [ref('summary_page_id', 'pages', true)] },
  { name: 'observations', remap: [WORKSPACE, PROJECT], refs: [ref('session_id', 'sessions')] },
  { name: 'ingest_keys', remap: [PROJECT], refs: [ref('session_id', 'sessions', true)] },
  { name: 'handoffs', remap: [WORKSPACE, PROJECT], refs: [ref('from_session_id', 'sessions', true), ref('accepted_by_session', 'sessions', true)] },
  { name: 'entities', remap: [WORKSPACE, PROJECT], refs: [] },
  { name: 'entity_page_links', remap: [], refs: [ref('entity_id', 'entities'), ref('page_id', 'pages')] },
  { name: 'links', remap: [], refs: [ref('from_page_id', 'pages'), ref('to_page_id', 'pages', true)] },
  { name: 'page_evidence', remap: [], refs: [ref('page_id', 'pages')] },
  { name: 'page_feedback', remap: [WORKSPACE, PROJECT], refs: [ref('page_id', 'pages'), ref('author_id', 'users', true)] },
];

export const MIGRATED_TABLES: readonly string[] = TABLE_SPECS.map(spec => spec.name);

// Columns the migration reads by name; they must exist in the source before anything runs.
export function requiredSourceColumns(spec: TableSpec): string[] {
  return [
    ...spec.remap.map(r => r.column),
    ...spec.refs.map(r => r.column),
    ...(spec.naturalKey ?? []),
    ...(spec.selfRef ? [spec.selfRef] : []),
  ];
}

const REASONS: Readonly<Record<string, string>> = {
  refinery_schema_history: 'controle de migrações do schema; o destino mantém o seu',
  users: 'identidade de usuários não migrada; páginas, projetos e feedback que referenciam um usuário ausente no destino viram conflito',
  human_auth_state: 'estado de autenticação; não migrado',
  api_credentials: 'credenciais; não migradas',
  api_credential_pepper_state: 'segredo de credenciais; não migrado',
  web_sessions: 'sessões web; não migradas',
  audit_log: 'auditoria do sistema de origem; não migrada',
  client_activity: 'atividade de clientes; não migrada',
  wiki_migrations: 'estado de migrações da wiki; não migrado',
  page_embeddings: 'regenerado pelo backfill local',
  page_abstract_embeddings: 'regenerado pelo backfill local',
  page_embed_failures: 'regenerado pelo backfill local',
  page_access: 'controle de acesso; regras do destino prevalecem',
  project_grants: 'concessões de projeto; regras do destino prevalecem',
  managed_runs: 'execuções gerenciadas; estado operacional',
  agent_messages: 'mensagens entre agentes; estado operacional',
  bootstrap_chunk_progress: 'progresso de bootstrap; estado operacional',
  session_consolidation_jobs: 'jobs de consolidação; estado operacional',
  maintenance_scheduler_state: 'agendador de manutenção; estado operacional',
};

const PREFIX_REASONS: readonly (readonly [string, string])[] = [
  ['profile_', 'perfil de consumo/contribuição; não migrado'],
  ['auto_improve_', 'auto-melhoria; estado operacional, não migrado'],
  ['purged_', 'registro de purga; não migrado'],
  ['workstream', 'workstreams; fora do escopo do histórico'],
];

const DERIVED_TABLE = /_fts(_|$)/;

// FTS virtual tables and their shadow tables are rebuilt by triggers; they carry no source rows of their own.
export function isDerivedTable(table: string): boolean {
  return DERIVED_TABLE.test(table);
}

export function notMigratedReason(table: string): string {
  if (isDerivedTable(table)) return 'índice FTS ou tabela auxiliar; reconstruído pelos triggers';
  const exact = REASONS[table];
  if (exact) return exact;
  const prefixed = PREFIX_REASONS.find(([prefix]) => table.startsWith(prefix));
  return prefixed ? prefixed[1] : 'sem regra de migração; não copiada';
}
