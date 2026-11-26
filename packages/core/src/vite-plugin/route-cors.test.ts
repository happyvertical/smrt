/**
 * Runtime behaviour of the CORS wrapper emitted into generated SvelteKit routes
 * (#5195): a hand-written route is wrapped by `applyRouteCors`, bundled against
 * a stubbed `@sveltejs/kit` and the real CORS policy, and called with requests.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { corsPreflightResponse, corsResponseHeaders } from '../generators/cors';
import { applyRouteCors, resolveRouteCors } from './route-cors';

const APP = 'https://app.example.com';
const EVIL = 'https://evil.example.com';

const ROUTE = `
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url }) => {
  if (url.searchParams.has('boom')) error(401, 'Authentication required');
  if (url.searchParams.has('crash')) throw new Error('unexpected');
  return json({ ok: true });
};

export const POST: RequestHandler = async () => {
  return new Response(null, { status: 204, headers: { Vary: 'Cookie' } });
};
`;

describe('resolveRouteCors', () => {
  it('is off unless there is a usable allow-list', () => {
    expect(resolveRouteCors(undefined)).toBeUndefined();
    expect(resolveRouteCors({})).toBeUndefined();
    expect(resolveRouteCors({ allowedOrigins: [] })).toBeUndefined();
    expect(
      resolveRouteCors({ allowedOrigins: ['*'], allowCredentials: true }),
    ).toBeUndefined();
  });
  it('cleans the list and defaults credentials off', () => {
    expect(resolveRouteCors({ allowedOrigins: [` ${APP} `, APP] })).toEqual({
      allowedOrigins: [APP],
      allowCredentials: false,
    });
  });
});

describe('applyRouteCors', () => {
  it('returns the source untouched when CORS is off', () => {
    expect(applyRouteCors(ROUTE, undefined)).toBe(ROUTE);
    expect(applyRouteCors(ROUTE, { allowedOrigins: ['*'] })).toBe(ROUTE);
  });
  it('returns the source untouched when it exports no method handler', () => {
    const source = 'export const load = () => ({});\n';
    expect(applyRouteCors(source, { allowedOrigins: [APP] })).toBe(source);
  });
});

describe('emitted CORS wrapper at run time', () => {
  let dir: string;
  let route: {
    GET: (event: unknown) => Promise<Response>;
    POST: (event: unknown) => Promise<Response>;
    OPTIONS: (event: unknown) => Promise<Response>;
  };
  const cors = { allowedOrigins: [APP], allowCredentials: true };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'route-cors-'));
    const src = join(dir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'route.ts'), applyRouteCors(ROUTE, cors));
    writeFileSync(
      join(src, 'kit.ts'),
      [
        'class HttpError extends Error { constructor(public status: number, public body: { message: string }) { super(body.message); } }',
        'export const error = (status: number, message: string) => { throw new HttpError(status, { message }); };',
        'export const isHttpError = (e: unknown) => e instanceof HttpError;',
        'export const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { "content-type": "application/json" } });',
      ].join('\n'),
    );
    writeFileSync(
      join(src, 'core.ts'),
      `export * from ${JSON.stringify(
        fileURLToPath(new URL('../generators/cors.ts', import.meta.url)),
      )};`,
    );
    const out = join(dir, 'route.mjs');
    await build({
      bundle: true,
      entryPoints: [join(src, 'route.ts')],
      format: 'esm',
      outfile: out,
      platform: 'node',
      plugins: [
        {
          name: 'aliases',
          setup(b) {
            b.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
              path: join(src, 'kit.ts'),
            }));
            b.onResolve({ filter: /^@happyvertical\/smrt-core$/ }, () => ({
              path: join(src, 'core.ts'),
            }));
            b.onResolve({ filter: /^\.\/\$types$/ }, () => ({
              path: join(src, 'types.ts'),
            }));
          },
        },
      ],
    });
    writeFileSync(join(src, 'types.ts'), 'export type RequestHandler = any;');
    route = await import(pathToFileURL(out).href);
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const event = (origin?: string, query = '') => ({
    request: new Request(`https://api.example.com/x${query}`, {
      headers: origin ? { origin } : {},
    }),
    url: new URL(`https://api.example.com/x${query}`),
  });

  it('gives an allow-listed origin the same headers as the shared policy', async () => {
    const res = await route.GET(event(APP));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    for (const [name, value] of Object.entries(
      corsResponseHeaders(APP, cors),
    )) {
      expect(res.headers.get(name)).toBe(value);
    }
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBe('true');
  });

  it('adds no CORS headers for another origin or none', async () => {
    for (const origin of [EVIL, undefined]) {
      const res = await route.GET(event(origin));
      expect(res.status).toBe(200);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
      expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
    }
  });

  it('carries the headers on a thrown error() response', async () => {
    const res = await route.GET(event(APP, '?boom=1'));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ message: 'Authentication required' });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(APP);
    const other = await route.GET(event(EVIL, '?boom=1'));
    expect(other.status).toBe(401);
    expect(other.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('rethrows anything that is not an HTTP error', async () => {
    await expect(route.GET(event(APP, '?crash=1'))).rejects.toThrow(
      'unexpected',
    );
  });

  it('extends an existing Vary', async () => {
    const res = await route.POST(event(APP));
    expect(res.status).toBe(204);
    expect(res.headers.get('Vary')).toBe('Cookie, Origin');
  });

  it('answers the preflight exactly as the shared policy does', async () => {
    for (const origin of [APP, EVIL]) {
      const mine = await route.OPTIONS(event(origin));
      const shared = corsPreflightResponse(event(origin).request, cors);
      expect(mine.status).toBe(shared.status);
      expect([...mine.headers].sort()).toEqual([...shared.headers].sort());
    }
  });
});
