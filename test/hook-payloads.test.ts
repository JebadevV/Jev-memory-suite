import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from '../src/config.js';
import { parseHookPayload } from '../src/hook.js';
// Sanitized real captures (Claude Code 2.1.309, Codex CLI 0.163.0). Each file is <agent>/<event>.json.
const fixturesDir = resolve(fileURLToPath(new URL('.', import.meta.url)), 'fixtures', 'hook-payloads');
const localDir = resolve(root, '.local');
type Fixture = { agent: string; event: string; label: string; payload: Record<string, unknown> };
async function listJsonFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...await listJsonFiles(full));
    else if (entry.isFile() && entry.name.endsWith('.json')) found.push(full);
  }
  return found.sort();
}
async function loadFixtures(): Promise<Fixture[]> {
  const files = await listJsonFiles(fixturesDir);
  return Promise.all(files.map(async file => {
    const [agent = '', fileName = ''] = relative(fixturesDir, file).split(/[\\/]/);
    const event = fileName.replace(/\.json$/, '');
    const payload = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    return { agent, event, label: `${agent}/${event}`, payload };
  }));
}
// The fixture cwd is a placeholder that does not exist on disk, and parseHookPayload resolves cwd with realpath
// inside the workspace boundary. Swap in a real scratch directory under .local and keep every other field exact.
async function scratchDir(): Promise<string> {
  await mkdir(localDir, { recursive: true });
  return mkdtemp(resolve(localDir, 'hook-payloads-test-'));
}
const fixtures = await loadFixtures();
test('hook payload fixtures cover every captured agent and event', () => {
  assert.ok(fixtures.length >= 12, `expected at least 12 fixtures, found ${fixtures.length}`);
  for (const agent of ['claude-code', 'codex']) {
    for (const event of ['session-start', 'user-prompt', 'pre-tool-use', 'post-tool-use', 'stop', 'session-end']) {
      assert.ok(fixtures.some(f => f.agent === agent && f.event === event), `missing ${agent}/${event}`);
    }
  }
});
for (const fixture of fixtures) {
  test(`${fixture.label} fixture is accepted and forwards its fields`, async () => {
    const dir = await scratchDir();
    try {
      const parsed = await parseHookPayload(fixture.agent, fixture.event, { ...fixture.payload, cwd: dir });
      assert.equal(parsed.cwd, await realpath(dir));
      assert.equal(parsed.session_id, fixture.payload.session_id);
      if ('tool_name' in fixture.payload) assert.equal(parsed.tool_name, fixture.payload.tool_name);
      if ('tool_input' in fixture.payload) assert.deepEqual(parsed.tool_input, fixture.payload.tool_input);
      if ('tool_response' in fixture.payload) assert.deepEqual(parsed.tool_response, fixture.payload.tool_response);
      assert.equal('transcript_path' in parsed, false);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  if (fixture.event === 'pre-tool-use') {
    test(`${fixture.label} documents the real shape: no tool_response key`, async () => {
      assert.equal('tool_response' in fixture.payload, false);
      const dir = await scratchDir();
      try {
        const parsed = await parseHookPayload(fixture.agent, fixture.event, { ...fixture.payload, cwd: dir });
        assert.equal('tool_response' in parsed, false);
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
}
