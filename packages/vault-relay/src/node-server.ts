/**
 * Node `http` adapter for the relay's fetch-style handlers. The request URL is
 * built from the request target on a fixed origin, so the Host header never
 * influences routing or the signed path.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';

export type FetchHandler = (request: Request) => Promise<Response>;

const ORIGIN = 'http://vault-relay.invalid';

function toRequest(req: IncomingMessage): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const method = (req.method ?? 'GET').toUpperCase();
  // Only a request that declares a body gets one: clients send no
  // Content-Length on a bodiless DELETE or POST, and such a request must
  // reach the handler with `body === null`, not as an unsized stream.
  const length = req.headers['content-length'];
  const hasBody =
    method !== 'GET' &&
    method !== 'HEAD' &&
    ((length !== undefined && length !== '0') ||
      req.headers['transfer-encoding'] !== undefined);
  return new Request(`${ORIGIN}${req.url ?? '/'}`, {
    method,
    headers,
    ...(hasBody
      ? {
          body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
          duplex: 'half',
        }
      : {}),
  } as RequestInit);
}

async function writeResponse(
  response: Response,
  res: ServerResponse,
): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  const body =
    response.body === null ? null : Buffer.from(await response.arrayBuffer());
  if (body && headers['content-length'] === undefined) {
    headers['content-length'] = String(body.length);
  }
  res.writeHead(response.status, headers);
  res.end(body ?? undefined);
}

export interface NodeServerOptions {
  /** Whole-request deadline in milliseconds (slow-body protection). */
  requestTimeoutMs?: number;
}

/** Create (not start) an HTTP server around a fetch-style handler. */
export function createRelayHttpServer(
  handler: FetchHandler,
  options: NodeServerOptions = {},
): Server {
  const server = createServer(async (req, res) => {
    try {
      const response = await handler(toRequest(req));
      await writeResponse(response, res);
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end('{"error":"internal_error"}');
    }
  });
  server.requestTimeout = options.requestTimeoutMs ?? 120_000;
  server.headersTimeout = 30_000;
  return server;
}
