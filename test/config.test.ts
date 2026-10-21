import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { mkdtemp, symlink } from 'node:fs/promises';
import { configSchema, json, root, profileDir, inside, assertLocal } from '../src/config.js';
test('configuration fails closed on unknown fields, secret URLs, remote HTTP and shared ports', async () => {
  const c = configSchema.parse(await json(resolve(root, 'config/default.json')));
  for (const candidate of [
    { ...c, token: 'secret' }, { ...c, controlPort: c.memory.port },
    { ...c, gateway: { ...c.gateway, upstreamUrl: 'http://api.openai.com/v1' } },
    { ...c, gateway: { ...c.gateway, upstreamUrl: 'https://user:pass@api.openai.com/v1' } },
    { ...c, gateway: { ...c.gateway, jevUrl: 'https://evil.example/v1' } }
  ]) assert.equal(configSchema.safeParse(candidate).success, false);
});
test('managed paths reject traversal and symlinks', async () => {
  assert.throws(() => profileDir('../other')); assert.throws(() => inside(root, '../outside'));
  const dir = await mkdtemp(resolve(root, '.local/path-test-'));
  const link = resolve(dir, 'link'); await symlink(resolve(root, 'docs'), link, 'junction');
  await assert.rejects(assertLocal(resolve(link, 'file')));
});
