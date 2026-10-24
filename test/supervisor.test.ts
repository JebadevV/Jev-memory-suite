import { test } from 'node:test';
import assert from 'node:assert/strict';
import { restartDelay, RESTART_WINDOW_MS } from '../src/supervisor.js';

const NOW = 10_000_000;

test('the first restarts wait 1s, then 2s, then 4s', () => {
  assert.equal(restartDelay([], NOW), 1000);
  assert.equal(restartDelay([NOW - 5000], NOW), 2000);
  assert.equal(restartDelay([NOW - 5000, NOW - 3000], NOW), 4000);
});

test('a fourth unexpected exit within the window is refused', () => {
  const history = [NOW - 30_000, NOW - 20_000, NOW - 10_000];
  assert.equal(restartDelay(history, NOW), undefined);
});

test('restarts older than the window no longer count against the budget', () => {
  const old = NOW - RESTART_WINDOW_MS - 1;
  assert.equal(restartDelay([old, old, old], NOW), 1000);
  assert.equal(restartDelay([NOW - 59_000, old, old], NOW), 2000);
});
