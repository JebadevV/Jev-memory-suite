import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactLogLine } from '../src/supervisor.js';

// The supervisor's log redaction, checked as a pure function: no process is started and nothing is written.
const none: string[] = [];

test('bearer and sk- forms are redacted exactly as before', () => {
  assert.equal(redactLogLine('Authorization: Bearer abc.def-ghi', none), 'Authorization: Bearer [REDACTED]');
  assert.equal(redactLogLine('key sk-live_ABC-123 used', none), 'key [REDACTED] used');
  assert.equal(redactLogLine('x=Bearer one y=bearer two', none), 'x=Bearer [REDACTED] y=Bearer [REDACTED]');
});

test('known secrets are replaced everywhere they occur', () => {
  const secrets = ['control-secret-value', 'router-secret-value'];
  assert.equal(redactLogLine('a control-secret-value b router-secret-value c control-secret-value', secrets), 'a [REDACTED] b [REDACTED] c [REDACTED]');
});

test('a chatgpt account id is redacted in JSON form', () => {
  const line = 'headers={"authorization": "[REDACTED]", "chatgpt-account-id": "acct-e2e-1234", "originator": "codex_exec"}';
  assert.equal(redactLogLine(line, none),
    'headers={"authorization": "[REDACTED]", "chatgpt-account-id": "[REDACTED]", "originator": "codex_exec"}');
});

test('a chatgpt account id is redacted in header form and case-insensitively', () => {
  assert.equal(redactLogLine('chatgpt-account-id: acct-e2e-1234', none), 'chatgpt-account-id: [REDACTED]');
  assert.equal(redactLogLine('CHATGPT-Account-Id=acct-e2e-1234;', none), 'CHATGPT-Account-Id=[REDACTED];');
  assert.equal(redactLogLine("'chatgpt-account-id': 'acct-e2e-1234'", none), "'chatgpt-account-id': '[REDACTED]'");
});

test('lines without an account id are returned byte-identical', () => {
  const plain = 'INFO 2026-10-23 request completed status=200 path=/v1/items/3 request_id=req-100003';
  assert.equal(redactLogLine(plain, none), plain);
  const withoutValue = 'chatgpt-account-id is a header name only';
  assert.equal(redactLogLine(withoutValue, none), withoutValue);
});
