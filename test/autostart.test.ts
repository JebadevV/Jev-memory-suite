import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { autostartCommand, parseRegValue, startupApprovedDisabled } from '../src/autostart.js';
import { root } from '../src/config.js';

test('the autostart command for the real repository fits the 260-character Run limit and points at the script', () => {
  const script = resolve(root, 'scripts/autostart.ps1');
  const command = autostartCommand(script);
  assert.ok(command.length <= 260, `${command.length} characters`);
  assert.ok(command.includes(`-File "${script}"`));
  assert.ok(command.endsWith('autostart.ps1"'));
});

test('a script path that pushes the command past 260 characters is rejected with a clear message', () => {
  const long = `D:\\${'a'.repeat(260)}\\autostart.ps1`;
  assert.throws(() => autostartCommand(long), /260/);
});

test('parseRegValue finds a present value and returns its type and data', () => {
  const output = [
    '',
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
    '    jev-memory-suite    REG_SZ    powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\\Dev\\jev-memory-suite\\scripts\\autostart.ps1"',
    '',
    '',
  ].join('\r\n');
  const found = parseRegValue(output, 'jev-memory-suite');
  assert.deepEqual(found, {
    type: 'REG_SZ',
    data: 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\\Dev\\jev-memory-suite\\scripts\\autostart.ps1"',
  });
});

test('parseRegValue reports an absent value as undefined', () => {
  const output = '\r\nHKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\r\n    OneDrive    REG_SZ    "C:\\OneDrive.exe"\r\n';
  assert.equal(parseRegValue(output, 'jev-memory-suite'), undefined);
  assert.equal(parseRegValue('', 'jev-memory-suite'), undefined);
});

test('parseRegValue matches the value name case-insensitively', () => {
  const output = '    JEV-MEMORY-SUITE    REG_SZ    x\r\n';
  assert.equal(parseRegValue(output, 'jev-memory-suite')?.data, 'x');
});

test('startupApprovedDisabled treats an odd first byte as disabled and an even one as enabled', () => {
  assert.equal(startupApprovedDisabled('03 00 00 00 00 00 00 00 00 00 00 00'), true);
  assert.equal(startupApprovedDisabled('02 00 00 00 00 00 00 00 00 00 00 00'), false);
  assert.equal(startupApprovedDisabled(undefined), false);
});
