import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPathEntry, parseUserPath } from '../src/shell.js';

test('user PATH activation preserves raw entries, kind and idempotence', () => {
  const value = '%LOCALAPPDATA%\\Programs\\existing;C:\\Other tools;';
  const raw = `HKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    ${value}\r\n    OTHER    REG_SZ    untouched\r\n`;
  assert.deepEqual(parseUserPath(raw), { existed: true, kind: 'REG_EXPAND_SZ', value });
  const bin = 'D:\\Suite with spaces\\bin';
  const updated = addPathEntry(value, bin);
  assert.equal(updated, value + bin);
  assert.equal(addPathEntry(updated, 'd:\\SUITE WITH SPACES\\bin\\'), updated);
  assert.deepEqual(parseUserPath('    PATH    REG_SZ    C:\\Tools\r\n'), { existed: true, kind: 'REG_SZ', value: 'C:\\Tools' });
  assert.deepEqual(parseUserPath('HKEY_CURRENT_USER\\Environment\r\n'), { existed: false, kind: 'REG_EXPAND_SZ', value: '' });
  assert.throws(() => parseUserPath('    Path    REG_DWORD    1\r\n'), /refusing/);
  assert.throws(() => addPathEntry(value, 'D:\\suite;other\\bin'), /PATH entry/);
});
