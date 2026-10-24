import { lstat, mkdir, readdir, readFile, rm, stat, writeFile, link } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { inside } from './config.js';

// Copies wiki files from the read-only source into the destination without overwriting anything.
// Paths are reported relative to the destination wiki root so a rollback knows exactly what to delete.

export interface WikiJob {
  srcDir: string;
  destDir: string;
  destRel: string;
  recursive: boolean;
}
export interface WikiResult {
  created: string[];
  wouldCreate: string[];
  alreadyPresent: number;
  conflicts: { path: string; reason: string }[];
  skipped: { path: string; reason: string }[];
}

export function emptyWikiResult(): WikiResult {
  return { created: [], wouldCreate: [], alreadyPresent: 0, conflicts: [], skipped: [] };
}

// Wiki directories are named with the lowercase, hyphenated UUID of the row id.
export function wikiUuid(hex: string): string {
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function copyWikiJobs(jobs: readonly WikiJob[], apply: boolean, result: WikiResult): Promise<void> {
  for (const job of jobs) {
    if (await isDirectory(job.srcDir)) await copyTree(job, job.srcDir, job.destDir, job.destRel, apply, result);
  }
}

async function copyTree(job: WikiJob, srcDir: string, destDir: string, shown: string, apply: boolean, result: WikiResult): Promise<void> {
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const path = `${shown}/${entry.name}`;
    if (entry.name === '.git') { result.skipped.push({ path, reason: '.git não é copiado' }); continue; }
    if (entry.isSymbolicLink()) { result.skipped.push({ path, reason: 'link simbólico não é copiado' }); continue; }
    if (entry.isDirectory()) {
      if (job.recursive) await copyTree(job, join(srcDir, entry.name), join(destDir, entry.name), path, apply, result);
      continue;
    }
    if (entry.isFile()) await copyFile(join(srcDir, entry.name), destDir, entry.name, path, apply, result);
  }
}

async function copyFile(src: string, destDir: string, name: string, shown: string, apply: boolean, result: WikiResult): Promise<void> {
  const target = inside(destDir, name);
  const data = await readFile(src);
  const existing = await readExisting(target);
  if (existing.kind === 'blocked') { result.conflicts.push({ path: shown, reason: existing.reason }); return; }
  if (existing.kind === 'file') {
    if (existing.data.equals(data)) result.alreadyPresent += 1;
    else result.conflicts.push({ path: shown, reason: 'arquivo existente diferente; não sobrescrito' });
    return;
  }
  if (!apply) { result.wouldCreate.push(shown); return; }
  await mkdir(destDir, { recursive: true });
  try {
    await createExclusive(target, data);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    result.conflicts.push({ path: shown, reason: 'arquivo criado durante a migração; não sobrescrito' });
    return;
  }
  result.created.push(shown);
}

type Existing = { kind: 'missing' } | { kind: 'file'; data: Buffer } | { kind: 'blocked'; reason: string };
async function readExisting(path: string): Promise<Existing> {
  const info = await lstat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  if (!info) return { kind: 'missing' };
  if (info.isSymbolicLink()) return { kind: 'blocked', reason: 'destino é link simbólico' };
  if (!info.isFile()) return { kind: 'blocked', reason: 'destino existe e não é arquivo' };
  return { kind: 'file', data: await readFile(path) };
}

// Write to a unique temp file, then hard-link it into place: link fails if the target exists,
// so a concurrent writer can never be overwritten (plain rename would replace it).
async function createExclusive(target: string, data: Buffer): Promise<void> {
  const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  await writeFile(temp, data, { flag: 'wx', mode: 0o600 });
  try {
    await link(temp, target);
  } finally {
    await rm(temp, { force: true });
  }
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch((e: NodeJS.ErrnoException) => {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  });
  return info?.isDirectory() ?? false;
}
