import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Mcp } from '../src/mcp.js';
type Handler = (res: import('node:http').ServerResponse) => void;
async function withServer(handler: Handler, run: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer((req, res) => {
    req.resume(); res.on('error', () => undefined); handler(res);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  try {
    await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`);
  } finally {
    await new Promise<void>(r => server.close(() => r()));
  }
}
test('rpc rejects a response whose declared content-length exceeds 4 MB', async () => {
  await withServer(res => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': '5000000' });
    res.end('x'.repeat(5_000_000));
  }, async url => {
    await assert.rejects(new Mcp(url, 'x').rpc('tools/list', {}), /too large/);
  });
});
test('rpc aborts a chunked response that streams more than 4 MB', async () => {
  await withServer(res => {
    res.writeHead(200, { 'content-type': 'application/json' });
    const chunk = 'x'.repeat(1_000_000);
    let sent = 0;
    const pump = () => {
      while (sent < 6) { sent++; if (!res.write(chunk)) { res.once('drain', pump); return; } }
      res.end();
    };
    pump();
  }, async url => {
    await assert.rejects(new Mcp(url, 'x').rpc('tools/list', {}), /too large/);
  });
});
test('rpc resolves an SSE response by matching the request id and ignoring notifications', async () => {
  await withServer(res => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\n'
      + 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n');
  }, async url => {
    assert.deepEqual(await new Mcp(url, 'x').rpc('tools/list', {}), { tools: [] });
  });
});
