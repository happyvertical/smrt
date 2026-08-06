import { createServer as createHttpServer } from 'node:http';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type Server } from '@modelcontextprotocol/server';

const generatedPath = process.argv[2];
if (!generatedPath) throw new Error('generated server path is required');
const generated = (await import(
  pathToFileURL(resolve(generatedPath)).href
)) as {
  createServer(): Promise<Server>;
};
const handler = createMcpHandler(() => generated.createServer());
const httpServer = createHttpServer(toNodeHandler(handler));
await new Promise<void>((resolveListen) =>
  httpServer.listen(0, '127.0.0.1', resolveListen),
);
const address = httpServer.address();
if (!address || typeof address === 'string')
  throw new Error('missing listener');
console.log(`http://127.0.0.1:${address.port}/mcp`);

const shutdown = () => httpServer.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
