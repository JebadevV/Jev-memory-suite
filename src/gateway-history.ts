// Incremental reader for the upstream launcher's JSON-lines route log (~/.jev-gateway/<client>.log). Purpose: history view.
// Reads only bytes appended since the last refresh, so a large log is not reparsed on every poll.
import { open, type FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  addModelEvent, addRouteEvent, createAccumulator, createModelAccumulator, finishMetrics, finishModels,
  type MetricsAccumulator, type ModelAccumulator, type ModelMetrics, type RouteMetrics,
} from './gateway-metrics.js';
import { addCompareEvent, createCompareAccumulator, finishCompare, type Compare, type CompareAccumulator } from './gateway-views.js';

export type HistoryClient = 'claude' | 'codex';
export interface HistoryResult { metrics: RouteMetrics; byModel: ModelMetrics[]; compare: Compare; complete: boolean; bytesRead: number }
export interface HistoryReader { refresh(): Promise<HistoryResult | null> }

interface ReaderState {
  // Bytes consumed from the file, including any incomplete trailing line held in `pending`.
  offset: number;
  pending: Buffer;
  // True while discarding the rest of an oversized line, up to its newline.
  skipping: boolean;
  identity: string | null;
  acc: MetricsAccumulator;
  models: ModelAccumulator;
  compare: CompareAccumulator;
}

const DEFAULT_MAX_LINE_BYTES = 64 * 1024;
const DEFAULT_MAX_READ_BYTES = 8 * 1024 * 1024;
const CHUNK_BYTES = 64 * 1024;
const NEWLINE = 0x0a;
const EMPTY = Buffer.alloc(0);

export function historyFile(client: HistoryClient, home?: string): string {
  return join(home ?? homedir(), '.jev-gateway', `${client}.log`);
}

function freshState(identity: string | null): ReaderState {
  return {
    offset: 0, pending: EMPTY, skipping: false, identity,
    acc: createAccumulator(), models: createModelAccumulator(), compare: createCompareAccumulator(),
  };
}

// The launcher prints non-JSON banner lines into the same file; those, and any line that is not a route event, are skipped.
function handleLine(state: ReaderState, line: Buffer): void {
  // Decoded per complete line so a multibyte character split across chunks is never corrupted.
  const text = line.toString('utf8');
  if (!text.startsWith('{')) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // A torn or foreign line is expected in a shared log; it is skipped, not treated as a failure.
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || (parsed as { event?: unknown }).event !== 'route') return;
  addRouteEvent(state.acc, parsed);
  addModelEvent(state.models, parsed);
  addCompareEvent(state.compare, parsed);
}

function appendPending(state: ReaderState, piece: Buffer, maxLine: number): void {
  state.pending = Buffer.concat([state.pending, piece]);
  if (state.pending.length > maxLine) {
    state.pending = EMPTY;
    state.skipping = true;
  }
}

// Splits a chunk into lines, carrying the unterminated tail over to the next read.
function consume(state: ReaderState, chunk: Buffer, maxLine: number): void {
  for (let start = 0; ;) {
    const end = chunk.indexOf(NEWLINE, start);
    if (!state.skipping) appendPending(state, chunk.subarray(start, end === -1 ? chunk.length : end), maxLine);
    if (end === -1) return;
    if (!state.skipping) handleLine(state, state.pending);
    state.pending = EMPTY;
    state.skipping = false;
    start = end + 1;
  }
}

const isMissing = (err: unknown): boolean => (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

export function createHistoryReader(file: string, opts: { maxLineBytes?: number; maxReadBytes?: number } = {}): HistoryReader {
  const maxLine = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxRead = opts.maxReadBytes ?? DEFAULT_MAX_READ_BYTES;
  let state = freshState(null);
  let inFlight: Promise<HistoryResult | null> | null = null;

  // Reads up to maxRead new bytes from the offset; a rotated or truncated file starts over.
  async function readNew(handle: FileHandle, size: number, identity: string): Promise<HistoryResult> {
    if ((state.identity !== null && state.identity !== identity) || size < state.offset) state = freshState(identity);
    state.identity = identity;
    let budget = maxRead;
    let bytesRead = 0;
    while (state.offset < size && budget > 0) {
      const want = Math.min(CHUNK_BYTES, budget, size - state.offset);
      const chunk = Buffer.alloc(want);
      const { bytesRead: got } = await handle.read(chunk, 0, want, state.offset);
      if (got === 0) break; // The file shrank after the stat; the next refresh sees the new size.
      state.offset += got;
      budget -= got;
      bytesRead += got;
      consume(state, chunk.subarray(0, got), maxLine);
    }
    return {
      metrics: finishMetrics(state.acc),
      byModel: finishModels(state.models),
      compare: finishCompare(state.compare),
      complete: state.offset >= size,
      bytesRead,
    };
  }

  async function refreshOnce(): Promise<HistoryResult | null> {
    let handle: FileHandle;
    try {
      handle = await open(file, 'r');
    } catch (err) {
      if (isMissing(err)) return null;
      throw err;
    }
    try {
      const stats = await handle.stat();
      return await readNew(handle, stats.size, `${stats.ino}:${stats.birthtimeMs}`);
    } finally {
      await handle.close();
    }
  }

  return {
    // Concurrent callers share one in-flight read, so the file is never read twice at once.
    refresh() {
      inFlight ??= refreshOnce().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
