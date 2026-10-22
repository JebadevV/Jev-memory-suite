import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parse } from 'smol-toml';
import { z } from 'zod';
import { assertWithin, root, workspaceDir, type Config } from './config.js';

const markerSchema = z.strictObject({ workspace: z.string(), project: z.string() });

// Both launch and capture check the closest marker within the registered project boundary.
export async function projectScopeMarker(cwd: string, scope: Pick<Config, 'workspace' | 'project' | 'projectRoot'>): Promise<string | undefined> {
  const base = await realpath(scope.projectRoot ?? root);
  let current = await workspaceDir(cwd, base);
  for (;;) {
    const path = resolve(current, '.ai-memory.toml');
    await assertWithin(base, path);
    const exists = await stat(path).then(info => info.isFile(), (e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return false; throw e; });
    if (exists) {
      let declared: z.infer<typeof markerSchema>;
      try { declared = markerSchema.parse(parse(await readFile(path, 'utf8'))); }
      catch { throw new Error(`Scope marker ${path} is unreadable`); }
      if (declared.workspace !== scope.workspace || declared.project !== scope.project)
        throw new Error(`Scope marker ${path} declares another workspace/project`);
      return path;
    }
    if (current === base) return undefined;
    current = dirname(current);
  }
}
