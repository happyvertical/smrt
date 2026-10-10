/**
 * The local server behind `smrt kitchen` (#3750): the planner's static app,
 * the host-mode chat endpoint, and the one endpoint that receives the cookbook.
 *
 * It only ever listens on 127.0.0.1 (a random port) and every request must
 * carry a `Host` of this server, which defeats DNS rebinding. State-changing
 * requests are same-origin JSON; the cookbook also needs the one-time token.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, sep } from 'node:path';
import type { KitchenAI } from './ai.js';
import type { AppliedBody, CookbookApplier } from './apply.js';
import type { PlannerCore, PlannerInstall } from './planner.js';

export const CHAT_PATH = '/api/planner/chat';
export const COOKBOOK_PATH = '/api/kitchen/cookbook';
export const CONFIG_PATH = '/planner.config.json';
export const TOKEN_HEADER = 'x-kitchen-token';

const CHAT_LIMIT = 256 * 1024;
const COOKBOOK_LIMIT = 2 * 1024 * 1024;

export interface KitchenServerOptions {
  planner: PlannerInstall;
  core: PlannerCore;
  /** The configured model; null serves the planner's in-browser model. */
  ai: KitchenAI | null;
  apply: CookbookApplier;
  /** Fixed port (default: random). */
  port?: number;
  /** Fixed token (tests). Default: 32 random bytes, base64url. */
  token?: string;
  log?: (line: string) => void;
}

export interface KitchenServer {
  url: string;
  port: number;
  token: string;
  /** `host` when the chat endpoint is served, else `browser`. */
  mode: 'host' | 'browser';
  /** Resolves once a cookbook was applied and the answer sent to the page. */
  applied: Promise<AppliedBody>;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit)
      throw new HttpError(413, 'The request body is too large.');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf-8');
}

export async function startKitchenServer(
  options: KitchenServerOptions,
): Promise<KitchenServer> {
  const log = options.log ?? (() => {});
  const token = options.token ?? randomBytes(32).toString('base64url');
  const mode: KitchenServer['mode'] = options.ai ? 'host' : 'browser';
  const appRoot = normalize(options.planner.appDir);
  let port = 0;
  let applying = false;
  let applied = false;

  let resolveApplied!: (body: AppliedBody) => void;
  const appliedPromise = new Promise<AppliedBody>((resolve) => {
    resolveApplied = resolve;
  });

  const origins = () => [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
  ];

  const config = () => ({
    inference:
      mode === 'host'
        ? { mode: 'host', host: { endpoint: CHAT_PATH } }
        : { mode: 'browser' },
    kitchen: { endpoint: COOKBOOK_PATH, token },
  });

  function checkToken(supplied: string | undefined): boolean {
    if (!supplied) return false;
    const a = Buffer.from(supplied);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** A browser POST states its origin; it must be this server's own. */
  function checkOrigin(req: IncomingMessage, required: boolean): void {
    const origin = req.headers.origin;
    if (origin === undefined) {
      if (required) throw new HttpError(403, 'Same-origin requests only.');
      return;
    }
    if (!origins().includes(origin)) {
      throw new HttpError(403, 'Same-origin requests only.');
    }
  }

  function requireJson(req: IncomingMessage): void {
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      throw new HttpError(415, 'Send application/json.');
    }
  }

  async function chat(req: IncomingMessage, res: ServerResponse) {
    if (!options.ai) throw new HttpError(503, 'No AI provider is configured.');
    checkOrigin(req, false);
    requireJson(req);
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, CHAT_LIMIT));
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'The body is not valid JSON.');
    }
    const parsed = options.core.parseHostRequest(body);
    if (!parsed.ok) throw new HttpError(400, parsed.error);
    const { system, messages } = options.core.buildHostPrompt(parsed.request);
    let text: string;
    try {
      text = await options.ai.chat([
        { role: 'system', content: system },
        ...(messages as Array<{
          role: 'user' | 'assistant';
          content: string;
        }>),
      ]);
    } catch (error) {
      log(
        `The model could not answer: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new HttpError(502, 'The model could not answer.');
    }
    const reply = options.core.parseHostReply(text);
    if (reply.issues.length) log(`planner reply: ${reply.issues.join('; ')}`);
    sendJson(res, 200, reply.reply);
  }

  async function cookbook(req: IncomingMessage, res: ServerResponse) {
    checkOrigin(req, true);
    requireJson(req);
    if (
      applied ||
      !checkToken(req.headers[TOKEN_HEADER] as string | undefined)
    ) {
      throw new HttpError(401, 'Missing or wrong kitchen token.');
    }
    if (applying)
      throw new HttpError(409, 'A cookbook is already being applied.');
    // Claim the slot before the first await: two POSTs must not both pass the
    // check while their bodies are still being read.
    applying = true;
    try {
      const text = await readBody(req, COOKBOOK_LIMIT);
      log('Received a cookbook from the planner.');
      const outcome = await options.apply(text);
      if (!outcome.ok) {
        log(`Not applied: ${outcome.errors.join('; ')}`);
        sendJson(res, outcome.status, { ok: false, errors: outcome.errors });
        return;
      }
      applied = true;
      res.once('close', () => resolveApplied(outcome.body));
      sendJson(res, 200, outcome.body);
    } finally {
      applying = false;
    }
  }

  function serveStatic(
    req: IncomingMessage,
    res: ServerResponse,
    path: string,
  ) {
    let relative: string;
    try {
      relative = decodeURIComponent(path);
    } catch {
      throw new HttpError(400, 'Bad path.');
    }
    if (relative.includes('\0')) throw new HttpError(400, 'Bad path.');
    let file = normalize(join(appRoot, relative));
    if (file !== appRoot && !file.startsWith(appRoot + sep)) {
      throw new HttpError(403, 'Forbidden.');
    }
    let stat = statSync(file, { throwIfNoEntry: false });
    if (stat?.isDirectory()) {
      file = join(file, 'index.html');
      stat = statSync(file, { throwIfNoEntry: false });
    }
    if (!stat?.isFile()) throw new HttpError(404, 'Not found.');
    res.writeHead(200, {
      'content-type':
        TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': path.includes('/_app/immutable/')
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  }

  const server: Server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    try {
      if (!origins().some((o) => o.endsWith(`//${req.headers.host}`))) {
        throw new HttpError(403, 'Unexpected Host.');
      }
      const path = (req.url ?? '/').split('?')[0];
      const get = req.method === 'GET' || req.method === 'HEAD';
      if (path === CONFIG_PATH && get) {
        sendJson(res, 200, config());
      } else if (path === CHAT_PATH && req.method === 'POST') {
        await chat(req, res);
      } else if (path === COOKBOOK_PATH && req.method === 'POST') {
        await cookbook(req, res);
      } else if (get) {
        serveStatic(req, res, path);
      } else {
        throw new HttpError(405, 'Method not allowed.');
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError ? error.message : 'Server error.';
      if (!(error instanceof HttpError)) {
        log(
          `server error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (res.headersSent) {
        res.destroy();
      } else if (req.url?.startsWith('/api/')) {
        sendJson(res, status, { ok: false, error: message, errors: [message] });
      } else {
        res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(message);
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    mode,
    applied: appliedPromise,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
