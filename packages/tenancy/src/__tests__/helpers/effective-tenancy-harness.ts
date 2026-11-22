/**
 * Shared fixture plumbing for the effective-tenancy suites: emitted SvelteKit
 * routes generated from the live registry and imported through Vitest (one
 * core and one tenancy instance shared with the test), and a request helper
 * that runs each call in its own async scope, as a server runs each request.
 *
 * Only `@sveltejs/kit` and the application's config module are stand-ins.
 */

import { AsyncResource } from 'node:async_hooks';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getRuntimeManifest } from '@happyvertical/smrt-core/generators/rest';
import { generateSvelteKitRoutes } from '@happyvertical/smrt-core/vite-plugin';
import { vi } from 'vitest';

export const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
export const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';

/** The registry key of a registered class (qualified when it has one). */
export function keyOf(name: string | Function): string {
  const info =
    typeof name === 'string'
      ? ObjectRegistry.getClass(name)
      : ObjectRegistry.getClassByConstructor(name as never);
  if (!info) throw new Error(`${String(name)} is not registered`);
  return info.qualifiedName || info.name;
}

/** The REST collection segment of a registered class. */
export function segmentOf(name: string | Function): string {
  const info =
    typeof name === 'string'
      ? ObjectRegistry.getClass(name)
      : ObjectRegistry.getClassByConstructor(name as never);
  if (!info?.collection) throw new Error(`${String(name)} has no collection`);
  return info.collection;
}

export interface HttpAnswer {
  status: number;
  body: unknown;
  headers: Headers;
}

/** Read a handler answer, including a thrown SvelteKit `error()`. */
async function answerOf(run: () => Promise<Response>): Promise<HttpAnswer> {
  try {
    const response = await run();
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    return { status: response.status, body, headers: response.headers };
  } catch (cause) {
    const status = (cause as { status?: unknown }).status;
    if (typeof status === 'number') {
      return { status, body: null, headers: new Headers() };
    }
    throw cause;
  }
}

/** Run `fn` in a fresh async scope, as a server runs one request. */
export function inRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  return new AsyncResource('effective-tenancy-request').runInAsyncScope(fn);
}

type RouteModule = Record<
  string,
  (event: Record<string, unknown>) => Promise<Response>
>;

export interface EmittedApp {
  /**
   * Call an emitted handler. `path` is the route directory below
   * `src/routes/api`, e.g. `'flyers/[id]'`.
   */
  call(
    method: string,
    path: string,
    event?: {
      params?: Record<string, string>;
      locals?: Record<string, unknown>;
      body?: unknown;
      query?: Record<string, string>;
      headers?: Record<string, string>;
    },
  ): Promise<HttpAnswer>;
  dispose(): void;
}

/**
 * Generate emitted routes for registered models, from the manifest the live
 * registry describes, and prepare their imports.
 *
 * @param name - Folder name below this package's ignored `.smrt/`
 * @param models - Registered class names or constructors of the item models
 * @param collections - Collections the routes' config module hands out, by
 *   registry key (and simple name)
 * @param extra - Manifest entries to add or replace, by key (for example a
 *   collection entry hosting a custom action)
 */
export async function emitApp(
  name: string,
  models: Array<string | Function>,
  collections: Map<string, unknown>,
  extra: Record<string, Record<string, unknown>> = {},
): Promise<EmittedApp> {
  const projectRoot = join(import.meta.dirname, '../../../.smrt', name);
  const keys = models.map(keyOf);
  const entries = [...ObjectRegistry.getAllClasses()].filter(([key, info]) =>
    keys.includes(info.qualifiedName || key),
  );
  const manifest = getRuntimeManifest(entries);
  Object.assign(manifest.objects, extra);
  for (const definition of Object.values(manifest.objects)) {
    const objectName = String(
      (definition as { extendsTypeArg?: string }).extendsTypeArg ??
        definition.className,
    );
    definition.filePath = join(projectRoot, `src/lib/objects/${objectName}.ts`);
  }

  rmSync(projectRoot, { recursive: true, force: true });
  mkdirSync(projectRoot, { recursive: true });
  const log = console.log;
  console.log = () => {};
  try {
    await generateSvelteKitRoutes(
      projectRoot,
      { ...manifest, packageName: '@happyvertical/smrt-tenancy' } as never,
      {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
        configFileName: 'smrt.ts',
      },
    );
  } finally {
    console.log = log;
  }

  vi.doMock('@sveltejs/kit', () => ({
    error: (status: number, message: string) => {
      throw Object.assign(new Error(message), { status });
    },
    json: (body: unknown, init: ResponseInit = {}) =>
      new Response(JSON.stringify(body), init),
  }));
  vi.doMock('$lib/server/smrt', () => ({
    getCollection: undefined,
    getSmrtConfig: undefined,
    runtime: {
      getCollection: async (collectionName: string) => {
        const collection = collections.get(collectionName);
        if (!collection) throw new Error(`No collection for ${collectionName}`);
        return collection;
      },
      classOptions: () => ({}),
    },
  }));
  vi.doMock('$lib/server/smrt-register', () => ({}));
  vi.doMock('@happyvertical/smrt-tenancy', () => import('../../index.js'));

  const modules = new Map<string, RouteModule>();
  const load = async (path: string) => {
    let module = modules.get(path);
    if (!module) {
      module = (await import(
        /* @vite-ignore */ pathToFileURL(
          join(projectRoot, `src/routes/api/${path}/+server.ts`),
        ).href
      )) as RouteModule;
      modules.set(path, module);
    }
    return module;
  };

  return {
    async call(method, path, event = {}) {
      const module = await load(path);
      const handler = module[method];
      if (!handler) throw new Error(`No ${method} handler for ${path}`);
      const params = event.params ?? {};
      const url = new URL(
        `http://localhost/api/${Object.entries(params).reduce(
          (out, [key, value]) => out.replace(`[${key}]`, value),
          path,
        )}`,
      );
      for (const [key, value] of Object.entries(event.query ?? {})) {
        url.searchParams.set(key, value);
      }
      return inRequestScope(() =>
        answerOf(() =>
          handler({
            locals: event.locals ?? {},
            params,
            url,
            request: new Request(url, {
              method,
              headers: {
                'content-type': 'application/json',
                ...event.headers,
              },
              ...(event.body === undefined
                ? {}
                : { body: JSON.stringify(event.body) }),
            }),
          }),
        ),
      );
    },
    dispose() {
      vi.doUnmock('@sveltejs/kit');
      vi.doUnmock('$lib/server/smrt');
      vi.doUnmock('$lib/server/smrt-register');
      vi.doUnmock('@happyvertical/smrt-tenancy');
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

/**
 * A manifest entry for a model's collection class hosting custom collection
 * actions, as the scanner writes one.
 *
 * @param model - Registered item class name or constructor
 * @param methods - Action name to its declared parameter names
 */
export function collectionEntryFor(
  model: string | Function,
  methods: Record<string, string[]>,
): [string, Record<string, unknown>] {
  const key = keyOf(model);
  const info = ObjectRegistry.getClass(key);
  if (!info) throw new Error(`${key} is not registered`);
  const className = `${info.name}Collection`;
  return [
    `${key}Collection`,
    {
      name: className.toLowerCase(),
      className,
      qualifiedName: `${key}Collection`,
      collection: info.collection,
      filePath: '',
      fields: {},
      methods: Object.fromEntries(
        Object.entries(methods).map(([name, parameters]) => [
          name,
          {
            name,
            parameters: parameters.map((parameter) => ({
              name: parameter,
              type: 'any',
              optional: true,
            })),
            returnType: 'Promise<any>',
            isPublic: true,
          },
        ]),
      ),
      decoratorConfig: { api: info.config?.api },
      extends: 'SmrtCollection',
      extendsTypeArg: info.name,
    },
  ];
}

/** Call a runtime REST handler in its own request scope. */
export function restCall(
  handler: (req: Request) => Promise<Response>,
  method: string,
  path: string,
  options: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpAnswer> {
  return inRequestScope(() =>
    answerOf(() =>
      handler(
        new Request(`http://local/api/${path}`, {
          method,
          headers: { 'content-type': 'application/json', ...options.headers },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
        }),
      ),
    ),
  );
}

/** Rows of a list answer, whatever envelope the transport uses. */
export function rowsOf(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body as Array<Record<string, unknown>>;
  const record = (body ?? {}) as Record<string, unknown>;
  const rows = record.items ?? record.data ?? record.result;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

/** The `title` of each row of a list answer, sorted. */
export function titlesOf(body: unknown): string[] {
  return rowsOf(body)
    .map((row) => String(row.title))
    .sort();
}
