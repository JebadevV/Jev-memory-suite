import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { configSchema, type Config } from '../src/config.js';
import { isListedProfile, listProjects } from '../src/dashboard-projects.js';

// Builds a real, schema-valid profile so the filter sees the same shape the suite writes.
function profile(projectRoot: string | undefined, memoryEnabled = true): Config {
  return configSchema.parse({
    schemaVersion: 1, workspace: 'jev-suite', project: 'jev-memory-suite', controlPort: 18800,
    ...(projectRoot === undefined ? {} : { projectRoot }),
    memory: { enabled: memoryEnabled, port: 18801 }, dashboard: { port: 18802 },
    gateway: { enabled: false, port: 18803, upstreamUrl: 'https://example.com/', jevUrl: 'https://example.com/',
      allowedHosts: ['example.com'], upstreamKeyEnv: 'JMS_UPSTREAM_KEY', jevKeyEnv: 'JMS_JEV_KEY' },
  });
}

const tmp = resolve('/sys/tmp');
const exampleApp = resolve('/dev/work/example-app');

test('the current suite profile is always listed', () => {
  assert.equal(isListedProfile('default', profile(undefined), 'default', tmp, true), true);
});

test('a valid external project with an existing root is listed', () => {
  assert.equal(isListedProfile('project-abc123', profile(exampleApp), 'default', tmp, true), true);
});

test('a project whose root lives under the OS temp directory is excluded', () => {
  assert.equal(isListedProfile('project-abc123', profile(join(tmp, 'build', 'x')), 'default', tmp, true), false);
  assert.equal(isListedProfile('project-abc123', profile(tmp), 'default', tmp, true), false);
});

test('temp-directory exclusion is case-insensitive on Windows', { skip: process.platform !== 'win32' }, () => {
  assert.equal(isListedProfile('project-abc123', profile(join(tmp.toUpperCase(), 'proj')), 'default', tmp, true), false);
});

test('test and scratch profiles that are not project-* are excluded even when valid', () => {
  for (const name of ['unit-1700000000', 'e2e-both-1792609466760', 'port-conflict-1', 'client-check']) {
    assert.equal(isListedProfile(name, profile(exampleApp), 'default', tmp, true), false, name);
  }
});

test('a project whose root directory is missing is excluded', () => {
  assert.equal(isListedProfile('project-abc123', profile(exampleApp), 'default', tmp, false), false);
});

test('a project with memory disabled or no projectRoot is excluded', () => {
  assert.equal(isListedProfile('project-abc123', profile(exampleApp, false), 'default', tmp, true), false);
  assert.equal(isListedProfile('project-abc123', profile(undefined), 'default', tmp, true), false);
});

test('listProjects keeps the current profile first and returns only listable ids', async () => {
  const list = await listProjects('default');
  assert.equal(list[0]?.id, 'default');
  for (const entry of list.slice(1)) assert.match(entry.id, /^project-/);
});
