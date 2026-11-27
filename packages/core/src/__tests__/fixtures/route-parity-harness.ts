/**
 * Harness for the route-parity test (#5195).
 *
 * The same HTTP request, from the same principal, over the same models and the
 * same in-process SQLite rows, is answered by the two transports that serve a
 * generated API:
 *
 * - the runtime REST handler (`APIGenerator.generateHandler()`), whose caller
 *   comes from the host's `resolvePrincipal`;
 * - the emitted SvelteKit route modules, generated into a temporary project
 *   with the real manifest builder and generator, and imported as written. Its
 *   caller is read from `event.locals`.
 *
 * A {@link ParityPrincipal} carries both spellings of one caller, so a test
 * names the caller once. The harness stands in for SvelteKit and the app only
 * at the module boundary: `@sveltejs/kit` (`error`, `json`, `isHttpError`),
 * the `$lib` aliases and the model package are mocked by the test file with
 * the factories below; the core the routes import is the real one.
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { APIRequestPrincipal } from '../../generators/request-principal.js';
import { type APIConfig, APIGenerator } from '../../generators/rest.js';
import { ManifestBuilder } from '../../manifest/generator.js';
import type { SmartObjectManifest } from '../../scanner/types.js';
import { getTestDatabase } from '../../testing/database.js';
import { generateSvelteKitRoutes } from '../../vite-plugin/sveltekit-generator.js';
import { PARITY_MODELS_SOURCE } from './route-parity-models.js';

/** Package name the fixture models are scanned and registered under. */
export const PARITY_PACKAGE = '@fixture/parity-app';

export const TENANT_A = 'a0000000-0000-4000-8000-00000000000a';
export const TENANT_B = 'b0000000-0000-4000-8000-00000000000b';

/** Rows every case starts from; the same on both transports. */
export const SEED = {
  note: {
    own: 'c0000000-0000-4000-8000-000000000a01',
    other: 'c0000000-0000-4000-8000-000000000b01',
    global: 'c0000000-0000-4000-8000-000000000001',
  },
  bypass: {
    own: 'd0000000-0000-4000-8000-000000000a01',
    other: 'd0000000-0000-4000-8000-000000000b01',
  },
  readable: { row: 'e0000000-0000-4000-8000-000000000001' },
  open: { row: 'f0000000-0000-4000-8000-000000000001' },
  /** A row of the STI base and a row of its private subtype, in tenant A. */
  vehicle: {
    own: 'a1000000-0000-4000-8000-000000000a01',
    truck: 'a1000000-0000-4000-8000-000000000a02',
  },
} as const;

const SHARED_CORE_SLOT = '__parityCore';

const KIT_SHIM = `export class HttpError extends Error {
  constructor(status, body) {
    super(body.message);
    this.status = status;
    this.body = body;
  }
}
// As SvelteKit: a string becomes { message }, an object is the body.
export function error(status, body) {
  throw new HttpError(status, typeof body === 'string' ? { message: body } : body);
}
export function isHttpError(value) {
  return value instanceof HttpError;
}
export function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
}
`;

/**
 * The two packages the emitted source imports by name. They live in the
 * project's own `node_modules`, so what a route imports does not depend on how
 * the test run resolves those names (a built `dist` makes core resolve to
 * itself).
 */
async function installRuntimePackages(root: string): Promise<void> {
  const core = (await import('../../index.js')) as Record<string, unknown>;
  (globalThis as Record<string, unknown>)[SHARED_CORE_SLOT] = core;
  const names = Object.keys(core).filter(
    (name) => /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default',
  );
  const write = (name: string, files: Record<string, string>) => {
    const dir = join(root, 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ name, type: 'module', exports: { '.': './index.js' } }),
    );
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(dir, file), content);
    }
  };
  write('@happyvertical/smrt-core', {
    'index.js': [
      `const shared = globalThis[${JSON.stringify(SHARED_CORE_SLOT)}];`,
      `export const { ${names.join(', ')} } = shared;`,
    ].join('\n'),
  });
  write('@sveltejs/kit', { 'index.js': KIT_SHIM });
  // The feed routes of a project with tenant-scoped models import the tenancy
  // package to enter the caller's tenant. Core cannot import it, and the feed
  // cases decide sign-in and CORS before any tenant is read, so the stub never
  // enters one.
  write('@happyvertical/smrt-tenancy', {
    'index.js':
      'export const hasTenantContext = () => false;\nexport const enterTenantContext = () => undefined;\n',
  });
}

function projectRoot(): string {
  const root = (globalThis as { __parityProjectRoot?: string })
    .__parityProjectRoot;
  if (!root) throw new Error('route-parity fixture is not created');
  return root;
}

/** Import a file of the generated project, with the test file's mocks applied. */
export function importFromProject(file: string): Promise<unknown> {
  return import(
    /* @vite-ignore */ pathToFileURL(join(projectRoot(), file)).href
  );
}

/** One caller, in the two spellings the transports read. */
export interface ParityPrincipal {
  /** What the host's `resolvePrincipal` returns for the REST handler. */
  rest: APIRequestPrincipal;
  /** What the host's `handle` hook puts on `event.locals` for SvelteKit. */
  locals: Record<string, unknown>;
}

export interface ParityRequest {
  method: string;
  /** Path under the API base, no leading slash: `paritynotes/<id>`. */
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** What one transport answered, reduced to what the transports must agree on. */
export interface Outcome {
  status: number;
  /** The error code, from either body shape. */
  code: string | undefined;
  /** The parsed JSON body (text when it is not JSON); `null` for no body. */
  body: unknown;
  /** `Retry-After`, in seconds; `null` when the answer carries none. */
  retryAfter: string | null;
  /** The CORS headers, lower-cased; absent ones are `null`. */
  cors: Record<(typeof CORS_HEADERS)[number], string | null>;
}

export const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-max-age',
  'vary',
] as const;

export interface CorsOptions {
  allowedOrigins: string[];
  allowCredentials?: boolean;
}

interface EmittedRoute {
  file: string;
  /** Path segments; `[id]` marks a parameter. */
  segments: string[];
}

type KitHandler = (
  event: Record<string, unknown>,
) => Promise<Response> | Response;

/** Everything one test file builds once and reuses. */
export class ParityFixture {
  private constructor(
    readonly root: string,
    readonly manifest: SmartObjectManifest,
    readonly routes: EmittedRoute[],
    private readonly cors: CorsOptions | undefined,
  ) {}

  /** Write the project, scan it, and emit its SvelteKit routes. */
  static async create(cors?: CorsOptions): Promise<ParityFixture> {
    const root = mkdtempSync(join(tmpdir(), 'smrt-route-parity-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: PARITY_PACKAGE,
        version: '0.0.1',
        type: 'module',
      }),
    );
    writeFileSync(join(root, 'src', 'objects.ts'), PARITY_MODELS_SOURCE);
    (globalThis as Record<string, unknown>).__parityProjectRoot = root;
    await installRuntimePackages(root);

    // ManifestBuilder resolves everything relative to process.cwd().
    const previousCwd = process.cwd();
    let manifest: SmartObjectManifest;
    try {
      process.chdir(root);
      manifest = (await new ManifestBuilder().generate({
        include: ['src/**/*.ts'],
        loadViteConfig: false,
        outputDir: join(root, 'out'),
        generateTypeStub: false,
      })) as SmartObjectManifest;
    } finally {
      process.chdir(previousCwd);
    }

    await generateSvelteKitRoutes(root, manifest, {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      configPath: 'src/lib/server',
      configFileName: 'smrt.ts',
      ...(cors ? { cors } : {}),
    });

    const routesDir = join(root, 'src', 'routes', 'api');
    const routes = collectRoutes(routesDir);
    return new ParityFixture(root, manifest, routes, cors);
  }

  dispose(): void {
    rmSync(this.root, { recursive: true, force: true });
    delete (globalThis as Record<string, unknown>).__parityProjectRoot;
    delete (globalThis as Record<string, unknown>)[SHARED_CORE_SLOT];
  }

  /** The route segment each model's collection is served under. */
  collectionSegment(className: string): string {
    const entry = Object.values(this.manifest.objects).find(
      (object) => object.className === className,
    );
    if (!entry?.collection) throw new Error(`no manifest entry: ${className}`);
    return entry.collection;
  }

  /** Every route path the generator emitted, as `a/[id]/b`. */
  routePaths(): string[] {
    return this.routes.map((route) => route.segments.join('/')).sort();
  }

  /** Send `request` to one transport over a fresh, identically seeded database. */
  async run(
    transport: 'rest' | 'kit',
    principal: ParityPrincipal,
    request: ParityRequest,
    options: { restConfig?: Partial<APIConfig> } = {},
  ): Promise<Outcome> {
    const db = await seededDatabase();
    const previousGetter = globalThis.__smrtGetRequestScopedDatabase;
    try {
      return transport === 'rest'
        ? await this.runRest(db, principal, request, options.restConfig)
        : await this.runKit(db, principal, request);
    } finally {
      if (previousGetter)
        globalThis.__smrtGetRequestScopedDatabase = previousGetter;
      else delete globalThis.__smrtGetRequestScopedDatabase;
      await db.close?.();
    }
  }

  private async runRest(
    db: DatabaseInterface,
    principal: ParityPrincipal,
    request: ParityRequest,
    extra: Partial<APIConfig> | undefined,
  ): Promise<Outcome> {
    const handler = new APIGenerator(
      {
        basePath: '/api',
        resolvePrincipal: () => principal.rest,
        ...(this.cors
          ? {
              enableCors: true,
              allowedOrigins: this.cors.allowedOrigins,
              allowCredentials: this.cors.allowCredentials === true,
            }
          : {}),
        ...extra,
      },
      { db },
    ).generateHandler();
    return observe(await handler(toRequest(request)));
  }

  private async runKit(
    db: DatabaseInterface,
    principal: ParityPrincipal,
    request: ParityRequest,
  ): Promise<Outcome> {
    globalThis.__smrtGetRequestScopedDatabase = () => db as never;
    const req = toRequest(request);
    const url = new URL(req.url);
    const match = this.match(url.pathname.replace(/^\/api\//, ''));
    if (!match) {
      // SvelteKit answers a path with no route with its own 404.
      return observe(
        new Response(JSON.stringify({ message: 'Not Found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    const module = (await import(
      pathToFileURL(match.route.file).href
    )) as Record<string, KitHandler | undefined>;
    const handler = module[req.method];
    if (typeof handler !== 'function') {
      // A route that exports no handler for the verb is a 405 in SvelteKit.
      return observe(
        new Response(
          JSON.stringify({ message: `${req.method} method not allowed` }),
          {
            status: 405,
            headers: { 'content-type': 'application/json' },
          },
        ),
      );
    }
    const event = {
      request: req,
      url,
      params: match.params,
      // A fresh copy: a handler must not see another case's mutation.
      locals: structuredClone(principal.locals),
      route: { id: `/api/${match.route.segments.join('/')}` },
      platform: undefined,
      cookies: {
        get: () => undefined,
        getAll: () => [],
        set() {},
        delete() {},
      },
      setHeaders() {},
      getClientAddress: () => '127.0.0.1',
      fetch: globalThis.fetch,
      isDataRequest: false,
      isSubRequest: false,
    };
    try {
      return observe(await handler(event));
    } catch (thrown) {
      return observe(kitErrorResponse(thrown));
    }
  }

  private match(
    path: string,
  ): { route: EmittedRoute; params: Record<string, string> } | undefined {
    const parts = path.split('/').filter(Boolean);
    const candidates: Array<{
      route: EmittedRoute;
      params: Record<string, string>;
    }> = [];
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      const ok = route.segments.every((segment, index) => {
        const isParam = /^\[.+\]$/.test(segment);
        if (isParam) {
          params[segment.slice(1, -1)] = decodeURIComponent(parts[index]);
          return true;
        }
        return segment === parts[index];
      });
      if (ok) candidates.push({ route, params });
    }
    // SvelteKit prefers the route with fewer parameters.
    candidates.sort(
      (a, b) => Object.keys(a.params).length - Object.keys(b.params).length,
    );
    return candidates[0];
  }
}

/** How SvelteKit answers a thrown `error()`: its body, as JSON. */
function kitErrorResponse(thrown: unknown): Response {
  const error = thrown as { status?: unknown; body?: unknown } | null;
  if (error && typeof error.status === 'number' && error.body !== undefined) {
    return new Response(JSON.stringify(error.body), {
      status: error.status,
      headers: { 'content-type': 'application/json' },
    });
  }
  const message = thrown instanceof Error ? thrown.message : String(thrown);
  return new Response(
    JSON.stringify({ message: `Internal Error: ${message}` }),
    {
      status: 500,
      headers: { 'content-type': 'application/json' },
    },
  );
}

function toRequest(request: ParityRequest): Request {
  return new Request(`http://local/api/${request.path}`, {
    method: request.method,
    headers: {
      ...(request.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...(request.headers ?? {}),
    },
    ...(request.body === undefined
      ? {}
      : { body: JSON.stringify(request.body) }),
  });
}

async function observe(response: Response): Promise<Outcome> {
  const text = await response.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  const record =
    body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const nested =
    record.error && typeof record.error === 'object'
      ? (record.error as Record<string, unknown>)
      : {};
  const code = (nested.code ?? record.code) as string | undefined;
  const cors = {} as Outcome['cors'];
  for (const name of CORS_HEADERS) cors[name] = response.headers.get(name);
  return {
    status: response.status,
    code,
    body,
    retryAfter: response.headers.get('retry-after'),
    cors,
  };
}

function collectRoutes(routesDir: string): EmittedRoute[] {
  const out: EmittedRoute[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === '+server.ts') {
        const rel = relative(routesDir, dir);
        out.push({ file: full, segments: rel === '' ? [] : rel.split(sep) });
      }
    }
  };
  walk(routesDir);
  return out;
}

/** A fresh in-memory SQLite database with the fixture rows. */
async function seededDatabase(): Promise<DatabaseInterface> {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: [
      'ParityNote',
      'ParityBypass',
      'ParityReadable',
      'ParityOpen',
      'ParityVehicle',
      'ParityTruck',
    ],
  });
  const models = (await import(
    pathToFileURL(join(projectRoot(), 'src', 'objects.ts')).href
  )) as Record<
    string,
    {
      create(options: {
        db: unknown;
      }): Promise<{ create(data: object): Promise<unknown> }>;
    }
  >;
  const notes = await models.ParityNoteCollection.create({ db });
  await notes.create({
    id: SEED.note.own,
    title: 'alpha',
    secret: 's-own',
    tenantId: TENANT_A,
  });
  await notes.create({
    id: SEED.note.other,
    title: 'beta',
    secret: 's-other',
    tenantId: TENANT_B,
  });
  await notes.create({
    id: SEED.note.global,
    title: 'global',
    secret: 's-global',
    tenantId: null,
  });
  const bypass = await models.ParityBypassCollection.create({ db });
  await bypass.create({
    id: SEED.bypass.own,
    title: 'alpha',
    tenantId: TENANT_A,
  });
  await bypass.create({
    id: SEED.bypass.other,
    title: 'beta',
    tenantId: TENANT_B,
  });
  const readable = await models.ParityReadableCollection.create({ db });
  await readable.create({ id: SEED.readable.row, title: 'readable' });
  const open = await models.ParityOpenCollection.create({ db });
  await open.create({ id: SEED.open.row, title: 'open' });
  const vehicles = await models.ParityVehicleCollection.create({ db });
  await vehicles.create({
    id: SEED.vehicle.own,
    title: 'car',
    tenantId: TENANT_A,
  });
  const trucks = await models.ParityTruckCollection.create({ db });
  await trucks.create({
    id: SEED.vehicle.truck,
    title: 'truck',
    payload: 'gravel',
    tenantId: TENANT_A,
  });
  return db;
}
