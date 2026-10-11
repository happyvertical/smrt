import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

export interface Stub {
  origin: string;
  requests: Recorded[];
  close(): Promise<void>;
}

/** A real HTTP server on 127.0.0.1 that records every request and answers with `handler`. */
export async function startStub(
  handler: (request: Recorded) =>
    | { status?: number; body: unknown; raw?: boolean }
    | Promise<{
        status?: number;
        body: unknown;
        raw?: boolean;
      }>,
): Promise<Stub> {
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      const recorded: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const answer = await handler(recorded);
      res.statusCode = answer.status ?? 200;
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader(
        'content-type',
        answer.raw ? 'text/plain' : 'application/json',
      );
      res.end(answer.raw ? String(answer.body) : JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** An OpenAI-style completion body. */
export const completion = (content: string) => ({
  choices: [{ index: 0, message: { role: 'assistant', content } }],
});
