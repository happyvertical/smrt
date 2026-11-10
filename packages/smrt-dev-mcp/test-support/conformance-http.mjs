import { createServer as createHttpServer } from 'node:http';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { createServer } from '../src/index.ts';

// cwd is the isolated consumer workspace supplied by the parent test.
const server = createHttpServer(
  toNodeHandler(createMcpHandler(() => createServer())),
);
server.listen(0, '127.0.0.1', () => {
  process.send({ url: `http://127.0.0.1:${server.address().port}/mcp` });
});
function close() {
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.once('SIGTERM', close);
process.once('disconnect', close);
