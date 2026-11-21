/**
 * Run the emitted transports against the real framework, in this process.
 *
 * The generators write source: SvelteKit route files, a sync-apply route and
 * two MCP servers (single-file and modular). A test that wants to know what a
 * request does to a row has to execute that source, and it has to execute it
 * over the real registry, collections and database, with the real fixture
 * models. This harness does that:
 *
 * - `@happyvertical/smrt-core` resolves to a module that re-exports the core
 *   already loaded by the test (the same module instances, so the fixture
 *   classes the test registered are the ones the emitted code reaches);
 * - SvelteKit and the MCP SDK resolve to a few lines that record handlers;
 * - collections open the database the test prepared.
 *
 * Nothing about the emitted source is rewritten. The same approach is used by
 * the #4320 case in `sveltekit-generator.runtime.test.ts`.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { DatabaseInterface } from '@happyvertical/sql';
import { build } from 'esbuild';
import { MCPGenerator } from '../../generators/mcp.js';
import { getRuntimeManifest } from '../../generators/rest.js';
import type { RegisteredClass } from '../../registry/types.js';
import { ObjectRegistry } from '../../registry.js';
import type { SmartObjectManifest } from '../../scanner/types.js';
import { generateSvelteKitRoutes } from '../../vite-plugin/sveltekit-generator.js';

const shared = globalThis as Record<string, unknown>;

/** Result of calling an emitted HTTP handler: thrown `error()`s included. */
export interface EmittedHttpResult {
  status: number;
  body: unknown;
}

/** A tool call result as the MCP SDK would send it. */
export interface EmittedToolResult {
  isError?: boolean;
  content?: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
}

type RouteHandler = (event: Record<string, unknown>) => Promise<Response>;

/** One temporary project holding emitted source for a set of fixture models. */
export interface EmittedProject {
  root: string;
  /** Registry keys of the fixture models, in the order given. */
  models: string[];
  /** Import an emitted route module, e.g. `'widgets/[id]/+server.ts'`. */
  route(path: string): Promise<Record<string, RouteHandler>>;
  /** Call one handler of a route and read the answer. */
  http(
    path: string,
    method: string,
    event: {
      url?: string;
      body?: unknown;
      params?: Record<string, string>;
      locals?: Record<string, unknown>;
      headers?: Record<string, string>;
    },
  ): Promise<EmittedHttpResult>;
  /** Start an emitted MCP server and return a function that calls its tools. */
  mcp(options: {
    modular: boolean;
    env?: Record<string, string | undefined>;
  }): Promise<{
    call(name: string, args: unknown): Promise<EmittedToolResult>;
    tools(): Promise<Array<{ name: string; inputSchema?: unknown }>>;
  }>;
  dispose(): void;
}

function identifier(name: string): boolean {
  return /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default';
}

/** Write a package that re-exports a module this process already loaded. */
function writeSharedModule(
  file: string,
  slot: string,
  module: Record<string, unknown>,
  replace: Record<string, string> = {},
): void {
  const names = Object.keys(module).filter(
    (name) => identifier(name) && !Object.hasOwn(replace, name),
  );
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    [
      `const shared = globalThis[${JSON.stringify(slot)}];`,
      `export const { ${names.join(', ')} } = shared;`,
      ...Object.values(replace),
    ].join('\n'),
  );
}

async function installRuntime(directory: string): Promise<void> {
  const core = (await import('../../index.js')) as Record<string, unknown>;
  const cookbookTools = (await import('../../cookbook/tools.js')) as Record<
    string,
    unknown
  >;
  shared.__smrtEmittedCore = core;
  shared.__smrtEmittedCookbookTools = cookbookTools;

  const modules = join(directory, 'node_modules');
  const corePackage = join(modules, '@happyvertical', 'smrt-core');
  mkdirSync(corePackage, { recursive: true });
  writeFileSync(
    join(corePackage, 'package.json'),
    JSON.stringify({
      name: '@happyvertical/smrt-core',
      type: 'module',
      exports: { '.': './index.js', './cookbook/tools': './cookbook-tools.js' },
    }),
  );
  writeSharedModule(join(corePackage, 'index.js'), '__smrtEmittedCore', core, {
    // An emitted server loads its application's manifest from the working
    // directory at start. The fixture models are registered already, and the
    // working directory here is this package, so that one call does nothing.
    ObjectRegistry: [
      'export const ObjectRegistry = new Proxy(shared.ObjectRegistry, {',
      '  get: (target, key) =>',
      "    key === 'loadAllManifests' ? () => {} : Reflect.get(target, key, target),",
      '});',
    ].join('\n'),
  });
  writeSharedModule(
    join(corePackage, 'cookbook-tools.js'),
    '__smrtEmittedCookbookTools',
    cookbookTools,
  );

  const packages: Record<string, Record<string, string>> = {
    '@happyvertical/smrt-config': {
      'package.json': JSON.stringify({
        type: 'module',
        exports: { '.': './index.js' },
      }),
      'index.js': 'export async function loadConfig() { return {}; }\n',
    },
    '@modelcontextprotocol/server': {
      'package.json': JSON.stringify({
        type: 'module',
        exports: { '.': './index.js', './stdio': './stdio.js' },
      }),
      'index.js':
        'export class Server { handlers = new Map(); setRequestHandler(name, handler) { this.handlers.set(name, handler); } async sendToolListChanged() {} }\n',
      'stdio.js':
        'export function serveStdio() { return { close: async () => {} }; }\n',
    },
  };
  for (const [name, files] of Object.entries(packages)) {
    const path = join(modules, name);
    mkdirSync(path, { recursive: true });
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(join(path, file), content);
    }
  }
}

function manifestFor(root: string, models: string[]): SmartObjectManifest {
  const entries: Array<[string, RegisteredClass]> = [];
  for (const [key, info] of ObjectRegistry.getAllClasses()) {
    if (models.includes(info.qualifiedName || key)) entries.push([key, info]);
  }
  const manifest = getRuntimeManifest(entries);
  const objectFile = join(root, 'src/lib/objects/Fixtures.ts');
  for (const definition of Object.values(manifest.objects)) {
    definition.filePath = objectFile;
  }
  return { ...manifest, packageName: '@fixture/emitted' };
}

/**
 * Emit the SvelteKit routes and prepare the runtime for a set of registered
 * fixture models.
 *
 * @param names - Registered class names (simple or qualified) of the models
 * @param options.db - The database the emitted routes' collections use
 * @param options.dbUrl - File URL of that database; emitted MCP servers open
 *   their own connection from `DATABASE_URL`
 * @param options.aliases - Extra module specifiers the emitted routes import,
 *   mapped to a `globalThis` slot holding the module to share (for example
 *   the tenancy package under test)
 */
export async function emitTransports(
  names: string[],
  options: {
    db: DatabaseInterface;
    dbUrl: string;
    aliases?: Record<string, { slot: string; module: Record<string, unknown> }>;
  },
): Promise<EmittedProject> {
  const { db, dbUrl, aliases = {} } = options;
  const root = mkdtempSync(join(tmpdir(), 'smrt-emitted-'));
  const models = names.map((name) => {
    const registered = ObjectRegistry.getClass(name);
    if (!registered)
      throw new Error(`Fixture model is not registered: ${name}`);
    return registered.qualifiedName || registered.name;
  });

  mkdirSync(join(root, 'src/lib/objects'), { recursive: true });
  writeFileSync(join(root, 'src/lib/objects/Fixtures.ts'), 'export {};\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'emitted-fixture-app', type: 'module' }),
  );
  await installRuntime(root);

  // The application's config module: collections over the test's database.
  shared.__smrtEmittedDb = db;
  const harness = join(root, 'harness');
  mkdirSync(harness, { recursive: true });
  writeFileSync(
    join(harness, 'smrt.ts'),
    [
      "import { ObjectRegistry } from '@happyvertical/smrt-core';",
      'export async function getCollection(className: string, overrides: Record<string, unknown> = {}) {',
      '  return ObjectRegistry.getCollection(className, {',
      '    db: (globalThis as any).__smrtEmittedDb,',
      '    ...overrides,',
      '  } as never);',
      '}',
    ].join('\n'),
  );
  writeFileSync(join(harness, 'register.ts'), 'export {};\n');
  writeFileSync(
    join(harness, 'kit.ts'),
    [
      'export function error(status: number, message: string): never {',
      '  throw Object.assign(new Error(message), { status, body: { message } });',
      '}',
      'export function json(body: unknown, init: ResponseInit = {}): Response {',
      "  return new Response(JSON.stringify(body), { ...init, headers: { 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } });",
      '}',
    ].join('\n'),
  );
  for (const [specifier, { slot, module }] of Object.entries(aliases)) {
    shared[slot] = module;
    writeSharedModule(
      join(harness, `${specifier.replace(/[^\w]+/g, '_')}.js`),
      slot,
      module,
    );
  }

  const log = console.log;
  console.log = () => {};
  try {
    await generateSvelteKitRoutes(root, manifestFor(root, models), {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      configPath: 'src/lib/server',
      configFileName: 'smrt.ts',
    });
  } finally {
    console.log = log;
  }

  let bundles = 0;
  const route = async (path: string) => {
    const bundled = await build({
      bundle: true,
      entryPoints: [join(root, 'src/routes/api', path)],
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [
        {
          name: 'emitted-route-aliases',
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^@sveltejs\/kit$/ }, () => ({
              path: join(harness, 'kit.ts'),
            }));
            pluginBuild.onResolve(
              { filter: /^\$lib\/server\/smrt-register$/ },
              () => ({ path: join(harness, 'register.ts') }),
            );
            pluginBuild.onResolve({ filter: /^\$lib\/server\/smrt$/ }, () => ({
              path: join(harness, 'smrt.ts'),
            }));
            for (const specifier of Object.keys(aliases)) {
              pluginBuild.onResolve(
                {
                  filter: new RegExp(
                    `^${specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`,
                  ),
                },
                () => ({
                  path: join(
                    harness,
                    `${specifier.replace(/[^\w]+/g, '_')}.js`,
                  ),
                }),
              );
            }
          },
        },
      ],
    });
    const output = join(root, `route-${++bundles}.mjs`);
    writeFileSync(output, bundled.outputFiles[0].text);
    return (await import(pathToFileURL(output).href)) as Record<
      string,
      RouteHandler
    >;
  };

  const http: EmittedProject['http'] = async (path, method, event) => {
    const handlers = await route(path);
    const handler = handlers[method];
    if (!handler) throw new Error(`No ${method} handler emitted for ${path}`);
    const url = new URL(event.url ?? 'http://emitted.local/api/');
    const request = new Request(url, {
      method,
      headers: { 'content-type': 'application/json', ...event.headers },
      ...(event.body === undefined ? {} : { body: JSON.stringify(event.body) }),
    });
    try {
      const response = await handler({
        locals: event.locals ?? {},
        params: event.params ?? {},
        request,
        url,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    } catch (cause) {
      // SvelteKit `error(status, message)` is a throw.
      const thrown = cause as { status?: unknown; body?: unknown };
      if (typeof thrown?.status === 'number') {
        return { status: thrown.status, body: thrown.body ?? null };
      }
      throw cause;
    }
  };

  let servers = 0;
  const mcp: EmittedProject['mcp'] = async ({ modular, env = {} }) => {
    const directory = join(root, `mcp-${++servers}`);
    await new MCPGenerator({ classNames: models }).generateServer({
      outputPath: join(directory, 'index.mjs'),
      modular,
      generateClaudeConfigFile: false,
      generateReadme: false,
    });
    await installRuntime(directory);
    const settings: Record<string, string | undefined> = {
      DATABASE_TYPE: 'sqlite',
      DATABASE_URL: dbUrl,
      SMRT_MCP_REGISTER_PATH: join(directory, 'no-register.js'),
      ...env,
    };
    const withEnv = async <T>(run: () => Promise<T>): Promise<T> => {
      const previous: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(settings)) {
        previous[name] = process.env[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      try {
        return await run();
      } finally {
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    };
    return withEnv(async () => {
      const module = (await import(
        pathToFileURL(join(directory, 'index.mjs')).href
      )) as {
        createServer(): Promise<{
          handlers: Map<string, (request: unknown) => Promise<unknown>>;
        }>;
      };
      const server = await module.createServer();
      return {
        call: (name, args) =>
          withEnv(
            () =>
              server.handlers.get('tools/call')?.({
                params: { name, arguments: args },
              }) as Promise<EmittedToolResult>,
          ),
        tools: () =>
          withEnv(async () => {
            const listed = (await server.handlers.get('tools/list')?.({})) as {
              tools: Array<{ name: string; inputSchema?: unknown }>;
            };
            return listed.tools;
          }),
      };
    });
  };

  return {
    root,
    models,
    route,
    http,
    mcp,
    dispose() {
      rmSync(root, { recursive: true, force: true });
      delete shared.__smrtEmittedDb;
    },
  };
}
