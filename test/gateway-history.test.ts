import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHistoryReader, historyFile, type HistoryResult } from '../src/gateway-history.js';

// Runs fn with a fresh temp directory and removes it afterwards.
async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'jev-history-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const routeLine = (tool: string, extra: Record<string, unknown> = {}): string =>
  `${JSON.stringify({ event: 'route', time: '2026-10-01T12:00:00.000Z', mode: 'none', tool, ...extra })}\n`;

test('historyFile joins the client log under .jev-gateway in the given or default home', () => {
  assert.equal(historyFile('claude', '/home/dev'), join('/home/dev', '.jev-gateway', 'claude.log'));
  assert.equal(historyFile('codex'), join(homedir(), '.jev-gateway', 'codex.log'));
  assert.equal(historyFile('agy', '/home/dev'), join('/home/dev', '.jev-gateway', 'agy.log'));
});

test('an Antigravity log is read as route events: usage is summed, passthrough events count as baseline and never as with-Jev', async () => {
  await withDir(async dir => {
    // Arrange: two passthrough route lines, as the Antigravity launcher writes them.
    const file = join(dir, 'agy.log');
    const agy = (usage: Record<string, number>): string => routeLine('stream', {
      mode: 'passthrough', reason: 'routing_disabled', path: '/v1internal:streamGenerateContent', model: 'gemini-3-pro', usage,
    });
    await writeFile(file, 'Jev gateway listening on 127.0.0.1:8794\n' + agy({ input: 119, output: 3 }) + agy({ input: 23192, output: 102, reasoning: 93 }));

    // Act
    const result = await createHistoryReader(file).refresh();

    // Assert: input is the total with cache, output includes reasoning, and the reasoning share is reported apart.
    assert.equal(result?.metrics.events, 2);
    assert.equal(result?.metrics.llm.input, 23311);
    assert.equal(result?.metrics.llm.output, 105);
    assert.equal(result?.metrics.llm.reasoning, 93);
    assert.deepEqual(result?.byModel.map(r => [r.model, r.metrics.events]), [['gemini-3-pro', 2]]);
    assert.equal(result?.compare.baseline.requests, 2);
    assert.equal(result?.compare.withJev.requests, 0);
  });
});

test('a missing log file reads as null, not as an error', async () => {
  await withDir(async dir => {
    const reader = createHistoryReader(join(dir, 'absent.log'));

    const result = await reader.refresh();

    assert.equal(result, null);
  });
});

test('banner lines, non-route events and torn JSON are skipped while route events are counted', async () => {
  await withDir(async dir => {
    // Arrange
    const file = join(dir, 'claude.log');
    await writeFile(file, [
      'Jev gateway listening on 127.0.0.1:8789',
      '{"event":"start","port":8789}',
      '[1,2,3]',
      '{"event":"route","mode":"none"',
      routeLine('Read'),
      '',
    ].join('\n'));

    // Act
    const result = await createHistoryReader(file).refresh();

    // Assert
    assert.ok(result);
    assert.equal(result.metrics.events, 1);
    assert.equal(result.complete, true);
  });
});

test('a refresh reads only bytes appended since the previous refresh', async () => {
  await withDir(async dir => {
    // Arrange
    const file = join(dir, 'claude.log');
    const first = routeLine('Read') + routeLine('Grep');
    await writeFile(file, first);
    const reader = createHistoryReader(file);
    const initial = await reader.refresh();
    const appended = routeLine('Bash');

    // Act
    await appendFile(file, appended);
    const next = await reader.refresh();

    // Assert
    assert.equal(initial?.bytesRead, Buffer.byteLength(first));
    assert.equal(initial?.metrics.events, 2);
    assert.equal(next?.bytesRead, Buffer.byteLength(appended));
    assert.equal(next?.metrics.events, 3);
  });
});

test('an unterminated trailing line is held back until its newline arrives', async () => {
  await withDir(async dir => {
    // Arrange
    const file = join(dir, 'claude.log');
    const whole = routeLine('Read');
    const tail = routeLine('Write');
    const split = tail.indexOf('"tool"');
    await writeFile(file, whole + tail.slice(0, split));
    const reader = createHistoryReader(file);
    const before = await reader.refresh();

    // Act
    await appendFile(file, tail.slice(split));
    const after = await reader.refresh();

    // Assert
    assert.equal(before?.metrics.events, 1);
    assert.equal(before?.complete, true);
    assert.equal(after?.metrics.events, 2);
    assert.equal(after?.bytesRead, Buffer.byteLength(tail.slice(split)));
  });
});

test('a truncated log resets the offset and the accumulator', async () => {
  await withDir(async dir => {
    // Arrange
    const file = join(dir, 'claude.log');
    await writeFile(file, routeLine('a') + routeLine('b') + routeLine('c'));
    const reader = createHistoryReader(file);
    await reader.refresh();

    // Act
    await writeFile(file, routeLine('only'));
    const result = await reader.refresh();

    // Assert
    assert.equal(result?.metrics.events, 1);
    assert.equal(result?.bytesRead, Buffer.byteLength(routeLine('only')));
  });
});

test('an oversized line is skipped up to its newline, even when it spans several reads', async () => {
  await withDir(async dir => {
    // Arrange
    const file = join(dir, 'claude.log');
    const huge = routeLine('huge', { pad: 'a'.repeat(200 * 1024) });
    await writeFile(file, huge + routeLine('small'));

    // Act
    const result = await createHistoryReader(file, { maxLineBytes: 1024 }).refresh();

    // Assert
    assert.equal(result?.metrics.events, 1);
    assert.equal(result?.complete, true);
  });
});

test('a line exactly at the size limit is still read', async () => {
  await withDir(async dir => {
    const file = join(dir, 'claude.log');
    const line = routeLine('exact');
    await writeFile(file, line);

    // The limit counts the line without its newline, so line.length - 1 bytes is exactly at the limit.
    const overLimit = await createHistoryReader(file, { maxLineBytes: line.length - 2 }).refresh();
    const atLimit = await createHistoryReader(file, { maxLineBytes: line.length - 1 }).refresh();

    assert.equal(overLimit?.metrics.events, 0);
    assert.equal(atLimit?.metrics.events, 1);
  });
});

test('maxReadBytes stops a refresh early, and later refreshes finish the file', async () => {
  await withDir(async dir => {
    // Arrange
    const file = join(dir, 'claude.log');
    const lines = Array.from({ length: 10 }, (_, i) => routeLine(`tool${i}`));
    await writeFile(file, lines.join(''));
    const reader = createHistoryReader(file, { maxReadBytes: 250 });

    // Act
    const first = await reader.refresh();
    assert.equal(first?.complete, false);
    assert.equal(first?.bytesRead, 250);

    let last: HistoryResult | null = first;
    for (let i = 0; i < 100 && last?.complete !== true; i += 1) last = await reader.refresh();

    // Assert
    assert.equal(last?.complete, true);
    assert.equal(last?.metrics.events, 10);
  });
});

test('byModel accumulates across refreshes, keyed by the model sent upstream', async () => {
  await withDir(async dir => {
    // Arrange
    const file = join(dir, 'codex.log');
    await writeFile(file, routeLine('Read', { model: 'gpt-6.1-sol', sentModel: 'gpt-6-sol' }) + routeLine('Grep', { model: 'gpt-6-luna' }));
    const reader = createHistoryReader(file);
    const initial = await reader.refresh();

    // Act
    await appendFile(file, routeLine('Bash', { model: 'gpt-6-luna' }));
    const next = await reader.refresh();

    // Assert
    assert.deepEqual(initial?.byModel.map(r => [r.model, r.metrics.events]), [['gpt-6-luna', 1], ['gpt-6-sol', 1]]);
    assert.deepEqual(next?.byModel.map(r => [r.model, r.metrics.events]), [['gpt-6-luna', 2], ['gpt-6-sol', 1]]);
    assert.equal(next?.metrics.events, 3);
  });
});

test('byModel restarts from zero when the log is truncated', async () => {
  await withDir(async dir => {
    // Arrange
    const file = join(dir, 'claude.log');
    await writeFile(file, routeLine('a', { model: 'claude-opus-4' }) + routeLine('b', { model: 'claude-opus-4' }));
    const reader = createHistoryReader(file);
    await reader.refresh();

    // Act
    await writeFile(file, routeLine('only', { model: 'claude-haiku-5' }));
    const result = await reader.refresh();

    // Assert
    assert.deepEqual(result?.byModel.map(r => [r.model, r.metrics.events]), [['claude-haiku-5', 1]]);
  });
});

test('concurrent refresh calls share one in-flight read', async () => {
  await withDir(async dir => {
    // Arrange
    const file = join(dir, 'claude.log');
    await writeFile(file, routeLine('Read'));
    const reader = createHistoryReader(file);

    // Act
    const a = reader.refresh();
    const b = reader.refresh();

    // Assert
    assert.equal(a, b);
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra?.metrics.events, 1);
    assert.equal(rb?.bytesRead, ra?.bytesRead);
  });
});

const meteredLine = (tool: string, input: number, extra: Record<string, unknown> = {}): string =>
  routeLine(tool, { mode: 'forced', usage: { input, output: 5, cached: 0, cacheWrite: 0, reasoning: 0 }, durationMs: 1000, ...extra });

test('compare accumulates metered events across refreshes and keeps baseline apart', async () => {
  await withDir(async dir => {
    // Arrange
    const file = join(dir, 'claude.log');
    await writeFile(file, meteredLine('a', 100) + meteredLine('b', 300));
    const reader = createHistoryReader(file);
    const first = await reader.refresh();

    // Act
    await appendFile(file, meteredLine('c', 500, { mode: 'passthrough', reason: 'routing_disabled' }) + routeLine('unmetered'));
    const next = await reader.refresh();

    // Assert
    assert.equal(first?.compare.withJev.requests, 2);
    assert.equal(first?.compare.withJev.inputPerRequest, 200);
    assert.equal(next?.compare.withJev.requests, 2);
    assert.equal(next?.compare.baseline.requests, 1);
    assert.equal(next?.compare.baseline.totalInput, 500);
  });
});

test('compare restarts from zero when the log is truncated', async () => {
  await withDir(async dir => {
    // Arrange
    const file = join(dir, 'claude.log');
    await writeFile(file, meteredLine('a', 100) + meteredLine('b', 100));
    const reader = createHistoryReader(file);
    await reader.refresh();

    // Act
    await writeFile(file, meteredLine('only', 700));
    const result = await reader.refresh();

    // Assert
    assert.equal(result?.compare.withJev.requests, 1);
    assert.equal(result?.compare.withJev.totalInput, 700);
  });
});

test('compare is empty before any metered event is read', async () => {
  await withDir(async dir => {
    const file = join(dir, 'claude.log');
    await writeFile(file, routeLine('Read'));

    const result = await createHistoryReader(file).refresh();

    assert.equal(result?.compare.withJev.requests, 0);
    assert.equal(result?.compare.shadow, null);
  });
});
