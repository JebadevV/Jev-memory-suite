import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root, json } from './config.js';
import { atomicJson, run, baseEnv } from './local.js';
const exec = promisify(execFile);
const engines = {
  gateway: { prefix: 'upstream/jev-gateway', url: 'https://github.com/vinilana/jev-gateway' },
  memory: { prefix: 'upstream/ai-memory', url: 'https://github.com/akitaonrails/ai-memory' }
};
export async function update(engine: string, sha: string): Promise<void> {
  if (!(engine in engines) || !/^[a-f0-9]{40}$/.test(sha)) throw new Error('Use gateway|memory and an exact 40-character lowercase commit SHA');
  const status = await exec('git', ['status', '--porcelain'], { cwd: root, env: baseEnv() });
  if (status.stdout.trim()) throw new Error('Subtree updates require a clean working tree');
  const e = engines[engine as keyof typeof engines];
  await run('git', ['subtree', 'pull', `--prefix=${e.prefix}`, e.url, sha, '--squash'], 'subtree-update.log');
  // Append provenance without discarding the original import manifest.
  const path = resolve(root, 'upstream.updates.json');
  const previous = await readFile(path, 'utf8').then(s => JSON.parse(s) as unknown[], () => []);
  await atomicJson(path, [...previous, { engine, ...e, commit: sha, at: new Date().toISOString(), importedSources: await json(resolve(root, 'upstream.sources.json')) }]);
}
