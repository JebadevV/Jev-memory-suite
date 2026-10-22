// Lists the projects the AI Memory dashboard may show: the current suite plus valid external project profiles.
// Purpose: maintainers. Date: 2026-10-22.
import { readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { type Config, profileName, readConfig, root } from './config.js';

export interface ProjectEntry { id: string; label: string }

// The scan touches every profile directory, and the dashboard polls the list, so the result is reused briefly.
const PROJECT_LIST_TTL_MS = 10_000;
const PROFILE_PREFIX = 'project-';
const fold = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;

// True when `path` is `base` or lies below it. Windows paths compare case-insensitively.
export function isInside(path: string, base: string): boolean {
  const rel = relative(fold(resolve(base)), fold(resolve(path)));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Pure filter so the listing rules can be tested without a real profile directory.
// Test and scratch projects live under the OS temp directory, so they are excluded even when they are valid.
export function isListedProfile(name: string, config: Config, current: string, tmp: string, rootExists: boolean): boolean {
  if (name === current) return true;
  if (!name.startsWith(PROFILE_PREFIX) || !config.memory.enabled || config.projectRoot === undefined) return false;
  return rootExists && !isInside(config.projectRoot, tmp);
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path).then(info => info.isDirectory(), () => false);
}

// Half-written or foreign profile folders are skipped silently: only fully valid profiles can be listed.
async function candidate(name: string, current: string, tmp: string): Promise<ProjectEntry | undefined> {
  const config = await readConfig(name).catch(() => undefined);
  if (!config) return undefined;
  const rootExists = config.projectRoot !== undefined && await isDirectory(config.projectRoot);
  if (!isListedProfile(name, config, current, tmp, rootExists)) return undefined;
  const label = name === current ? config.project : basename(config.projectRoot ?? name) || name;
  return { id: name, label };
}

// Current first, then alphabetical so the selector order is stable between polls.
const byCurrentThenLabel = (current: string) => (a: ProjectEntry, b: ProjectEntry): number =>
  (a.id === current ? 0 : 1) - (b.id === current ? 0 : 1) || a.label.localeCompare(b.label) || a.id.localeCompare(b.id);

async function scan(current: string): Promise<ProjectEntry[]> {
  // The supervisor runs with TEMP redirected to .local/tmp (baseEnv), so tmpdir() misses the real Windows temp.
  const tmp = process.env.LOCALAPPDATA ? resolve(process.env.LOCALAPPDATA, 'Temp') : tmpdir();
  const names = await readdir(resolve(root, '.local/profiles')).catch(() => [] as string[]);
  const wanted = names.filter(name => profileName.safeParse(name).success && (name === current || name.startsWith(PROFILE_PREFIX)));
  const entries = await Promise.all(wanted.map(name => candidate(name, current, tmp)));
  return entries.filter((entry): entry is ProjectEntry => entry !== undefined).sort(byCurrentThenLabel(current));
}

let cached: { at: number; current: string; value: ProjectEntry[] } | undefined;

export async function listProjects(current: string): Promise<ProjectEntry[]> {
  if (cached?.current === current && Date.now() - cached.at < PROJECT_LIST_TTL_MS) return cached.value;
  const value = await scan(current);
  cached = { at: Date.now(), current, value };
  return value;
}
