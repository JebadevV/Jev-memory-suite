import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { MIGRATED_TABLES } from './migrate-spec.js';
import { countRows, sameValue } from './migrate-db.js';

// Post-write checks on the destination connection. They read only; the caller decides commit or rollback.

export interface CountCheck { before: number; after: number; expected: number; ok: boolean; }
export interface ValidationReport {
  ok: boolean;
  integrity: string;
  foreignKeyViolations: number;
  counts: Record<string, CountCheck>;
  pages: { checked: number; mismatches: number };
  fts: { status: 'ok' | 'failed' | 'skipped'; reason?: string };
}

export interface ValidationInput {
  before: Record<string, number>;
  inserted: Record<string, number>;
  insertedPages: string[];
}

export function validateDestination(dest: DatabaseSync, source: DatabaseSync, input: ValidationInput): ValidationReport {
  const integrity = integrityOf(dest);
  const foreignKeyViolations = dest.prepare('PRAGMA foreign_key_check').all().length;
  const counts = countCheck(dest, input);
  const pages = pageCheck(dest, source, input.insertedPages);
  const fts = ftsCheck(dest, input.insertedPages);
  const countsOk = Object.values(counts).every(c => c.ok);
  return {
    ok: integrity === 'ok' && foreignKeyViolations === 0 && countsOk && pages.mismatches === 0 && fts.status !== 'failed',
    integrity, foreignKeyViolations, counts, pages, fts
  };
}

export function integrityOf(db: DatabaseSync): string {
  const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
  return rows.length === 1 ? String(rows[0]?.integrity_check) : `${rows.length} problem rows`;
}

function countCheck(dest: DatabaseSync, input: ValidationInput): Record<string, CountCheck> {
  const result: Record<string, CountCheck> = {};
  for (const table of MIGRATED_TABLES) {
    const before = input.before[table] ?? 0;
    const expected = before + (input.inserted[table] ?? 0);
    const after = countRows(dest, table);
    result[table] = { before, after, expected, ok: after === expected };
  }
  return result;
}

// Each inserted page must keep its body byte-for-byte and its stored digest must match the body.
function pageCheck(dest: DatabaseSync, source: DatabaseSync, ids: string[]): { checked: number; mismatches: number } {
  const destRead = dest.prepare('SELECT body, body_sha256 AS sha FROM pages WHERE id = ?');
  const sourceRead = source.prepare('SELECT body FROM pages WHERE id = ?');
  let mismatches = 0;
  for (const hex of ids) {
    const id = Buffer.from(hex, 'hex');
    const copy = destRead.get(id) as { body: string; sha: Uint8Array } | undefined;
    const original = sourceRead.get(id) as { body: string } | undefined;
    const digest = copy ? createHash('sha256').update(copy.body, 'utf8').digest() : undefined;
    if (!copy || !original || !digest || !sameValue(digest, copy.sha) || copy.body !== original.body) mismatches += 1;
  }
  return { checked: ids.length, mismatches };
}

// At least one inserted page must be findable through pages_fts by a word from its title.
function ftsCheck(dest: DatabaseSync, ids: string[]): { status: 'ok' | 'failed' | 'skipped'; reason?: string } {
  const titleRead = dest.prepare('SELECT title, rowid AS rid FROM pages WHERE id = ?');
  const search = dest.prepare('SELECT rowid FROM pages_fts WHERE pages_fts MATCH ?');
  let candidates = 0;
  for (const hex of ids) {
    const page = titleRead.get(Buffer.from(hex, 'hex')) as { title: string; rid: number } | undefined;
    const word = page?.title.match(/[\p{L}\p{N}]{3,}/u)?.[0];
    if (!page || !word) continue;
    candidates += 1;
    const hits = search.all(`"${word}"`) as { rowid: number }[];
    if (hits.some(h => h.rowid === page.rid)) return { status: 'ok' };
  }
  if (candidates === 0) return { status: 'skipped', reason: 'no inserted page with a searchable title' };
  return { status: 'failed', reason: 'inserted pages not found through pages_fts' };
}
