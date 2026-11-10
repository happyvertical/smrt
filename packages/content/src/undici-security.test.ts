import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const spiderRequire = createRequire(require.resolve('@happyvertical/spider'));

// Keep a hostile response in a child: the vulnerable fetch crashes even when
// its rejection is caught. Exercise both the direct and public Spider edges.
const probe = `
const assert = require('node:assert/strict');
const { createServer } = require('node:net');
const { once } = require('node:events');
const { fetch, Client } = require(process.argv[1]);
(async () => {
  let closed;
  const socketClosed = new Promise(resolve => { closed = resolve; });
  const server = createServer(socket => {
    socket.once('close', closed);
    socket.once('data', () => socket.end(
      'HTTP/1.1 200 OK\\r\\n' +
      'Content-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\\r\\n' +
      'Content-Length: 1\\r\\nConnection: close\\r\\n\\r\\n'
    ));
  });
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const url = 'http://127.0.0.1:' + server.address().port;
  const client = new Client(url);
  try {
    await assert.rejects(fetch(url, { dispatcher: client }), error => {
      assert.match(error.cause?.message ?? '', /content-encoding/);
      return true;
    });
    await socketClosed;
    console.log('hostile-response-refused-process-alive');
  } finally {
    await client.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
`;

it.each([
  ['content', require.resolve('undici')],
  ['spider', spiderRequire.resolve('undici')],
])('refuses excessive encodings without crashing the %s process', (_edge, entry) => {
  const result = spawnSync(process.execPath, ['-e', probe, entry], {
    encoding: 'utf8',
    timeout: 15000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('hostile-response-refused-process-alive');
});
