/** Loopback-only bridge for the live SvelteKit preview during local development. */
import { createServer, type Server as HttpServer } from 'node:http';
import type { KitchenSession, KitchenToolResult } from './tools.js';

export async function startKitchenPreview(
  session: KitchenSession,
  port: number,
  origin: string,
): Promise<{ server: HttpServer; url: string }> {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) {
    throw new Error('Preview origin must be a 127.0.0.1 HTTP origin.');
  }
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Vary', 'Origin');
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.headers.origin !== origin) {
      response
        .writeHead(403)
        .end(JSON.stringify({ ok: false, error: 'Origin refused.' }));
      return;
    }
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      return;
    }
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const match = /^\/plans\/(plan-[a-f0-9-]{8,36})(\/commands)?$/.exec(path);
    if (
      !match ||
      !session.previewPlans.has(match[1]) ||
      !(
        (request.method === 'GET' && !match[2]) ||
        (request.method === 'POST' && match[2])
      )
    ) {
      response
        .writeHead(404)
        .end(JSON.stringify({ ok: false, error: 'Not found.' }));
      return;
    }
    try {
      let result: KitchenToolResult;
      if (request.method === 'GET') {
        result = await session.call('get_plan', { planId: match[1] });
      } else {
        if (
          !/^application\/json(?:\s*;|$)/i.test(
            request.headers['content-type'] ?? '',
          )
        ) {
          response
            .writeHead(415)
            .end(JSON.stringify({ ok: false, error: 'JSON required.' }));
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        for await (const chunk of request) {
          bytes += chunk.length;
          if (bytes > 2_097_152) {
            response
              .writeHead(413)
              .end(JSON.stringify({ ok: false, error: 'Request too large.' }));
            return;
          }
          chunks.push(chunk);
        }
        const input: unknown = JSON.parse(
          Buffer.concat(chunks).toString('utf8'),
        );
        if (!input || typeof input !== 'object' || Array.isArray(input)) {
          response.writeHead(400).end(
            JSON.stringify({
              ok: false,
              error: {
                code: 'invalid_input',
                message: 'A JSON object is required.',
              },
            }),
          );
          return;
        }
        result = await session.call('run_commands', {
          ...(input as Record<string, unknown>),
          planId: match[1],
        });
      }
      response.writeHead(200).end(JSON.stringify(result.data));
    } catch {
      response.writeHead(400).end(
        JSON.stringify({
          ok: false,
          error: { code: 'invalid_input', message: 'Invalid JSON request.' },
        }),
      );
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Preview listener has no port.');
  return { server, url: `http://127.0.0.1:${address.port}` };
}
