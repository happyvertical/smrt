/**
 * Route generation never replaces or shadows an application route file
 * (#5437). Every test drives the real generator against a real temporary
 * project tree: a direct `generateSvelteKitRoutes()` call, or the producer
 * plugin's direct path (`configResolved` with no config hook).
 *
 * A route file counts as generated only when it is a regular `+server.ts`
 * whose first bytes are the generated-route header (after at most one
 * byte-order mark). Anything else at a planned route path is application
 * code: generation refuses before it changes any file of the invocation.
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  MethodDefinition,
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';
import { smrtPlugin } from './index.js';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import {
  generateSvelteKitRoutes,
  type SvelteKitGenerationHooks,
  type SvelteKitOptions,
} from './sveltekit-generator.js';

const PACKAGE = '@fixture/route-ownership';
const OWNERSHIP_CODE = 'SMRT_ROUTE_OWNERSHIP_CONFLICT';
const APPLICATION_HANDLER =
  "export const GET = () => new Response('application handler');\n";

let projectRoot: string;
let outsideRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'smrt-route-ownership-'));
  outsideRoot = mkdtempSync(join(tmpdir(), 'smrt-route-ownership-outside-'));
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: PACKAGE, type: 'module' }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(outsideRoot, { recursive: true, force: true });
});

function baseOptions(overrides: Partial<SvelteKitOptions> = {}) {
  return {
    enabled: true,
    routesDir: 'src/routes/api',
    objectsDir: 'src/lib/objects',
    configPath: 'src/lib/server',
    configFileName: 'smrt.ts',
    resourcesRoute: { enabled: false },
    knowledge: { api: { enabled: true } },
    ...overrides,
  } as SvelteKitOptions;
}

function method(name: string): MethodDefinition {
  return {
    name,
    async: true,
    parameters: [],
    returnType: 'Promise<boolean>',
    isStatic: false,
    isPublic: true,
  } as MethodDefinition;
}

function definition(
  className: string,
  collection: string,
  overrides: Partial<SmartObjectDefinition> = {},
): SmartObjectDefinition {
  return {
    qualifiedName: `${PACKAGE}:${className}`,
    className,
    collection,
    packageName: PACKAGE,
    filePath: join(projectRoot, 'src/lib/objects', `${className}.ts`),
    fields: { name: { type: 'text' } },
    methods: {},
    decoratorConfig: { api: true },
    ...overrides,
  } as SmartObjectDefinition;
}

function manifest(
  ...definitions: SmartObjectDefinition[]
): SmartObjectManifest {
  return {
    version: '1',
    timestamp: 0,
    packageName: PACKAGE,
    objects: Object.fromEntries(
      definitions.map((objectDef) => [objectDef.qualifiedName, objectDef]),
    ),
  } as SmartObjectManifest;
}

const lantern = () =>
  definition('Lantern', 'lanterns', { methods: { light: method('light') } });
const kite = () => definition('Kite', 'kites');

async function generate(
  routeManifest = manifest(lantern(), kite()),
  options = baseOptions(),
  hooks: SvelteKitGenerationHooks = {},
): Promise<void> {
  await generateSvelteKitRoutes(
    projectRoot,
    routeManifest,
    options,
    routeManifest,
    undefined,
    routeManifest,
    hooks,
  );
}

const api = (...segments: string[]) =>
  join(projectRoot, 'src/routes/api', ...segments);
const knowledgeRoute = () =>
  join(projectRoot, 'src/routes/__smrt/knowledge/+server.ts');

/** Every path below the project with its type and content digest. */
function inventory(root = projectRoot): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const key = relative(root, path);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) {
        entries[key] = `link:${readlinkSync(path)}`;
      } else if (stats.isDirectory()) {
        entries[key] = 'dir';
        walk(path);
      } else {
        entries[key] = `file:${createHash('sha256')
          .update(readFileSync(path))
          .digest('hex')}`;
      }
    }
  };
  walk(root);
  return entries;
}

function writeFile(path: string, content: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function isGeneratedText(path: string): boolean {
  return readFileSync(path, 'utf-8').startsWith(AUTO_GENERATED_ROUTE_HEADER);
}

async function expectOwnershipRefusal(
  run: Promise<unknown>,
  files: string[],
  phase: 'preflight' | 'commit' = 'preflight',
): Promise<Error & { files: string[]; routes: string[] }> {
  const error = await run.then(
    () => {
      throw new Error('expected generation to refuse an application route');
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(Error);
  expect(error).toMatchObject({
    name: 'ApplicationRouteConflictError',
    code: OWNERSHIP_CODE,
    phase,
  });
  const refusal = error as Error & { files: string[]; routes: string[] };
  for (const file of files) {
    expect(refusal.files).toContain(file);
    expect(refusal.message).toContain(file);
  }
  expect(Array.isArray(refusal.routes)).toBe(true);
  return refusal;
}

describe('the generated-route predicate at planned paths', () => {
  it('a hand-edited route that keeps the header is regenerated', async () => {
    await generate();
    const generated = readFileSync(api('lanterns', '+server.ts'), 'utf-8');
    writeFileSync(
      api('lanterns', '+server.ts'),
      `${generated}\n// local tweak\n`,
    );

    await generate();

    expect(readFileSync(api('lanterns', '+server.ts'), 'utf-8')).toBe(
      generated,
    );
  });

  it('removing the header line makes a route application code and generation refuses', async () => {
    await generate();
    const file = api('lanterns', '+server.ts');
    const edited = readFileSync(file, 'utf-8').split('\n').slice(1).join('\n');
    writeFileSync(file, edited);
    const before = inventory();

    await expectOwnershipRefusal(generate(), [file]);

    expect(inventory()).toEqual(before);
    expect(readFileSync(file, 'utf-8')).toBe(edited);
  });

  it('an empty or unreadable route file is application code', async () => {
    await generate();
    const planned = api('lanterns', '[id]', '+server.ts');
    const unplanned = api('lanterns', 'notes', '+server.ts');
    writeFileSync(planned, '');
    writeFile(unplanned, '');
    const before = inventory();

    await expectOwnershipRefusal(generate(), [planned]);

    expect(inventory()).toEqual(before);

    unlinkSync(planned);
    await generate();
    expect(isGeneratedText(planned)).toBe(true);
    expect(readFileSync(unplanned, 'utf-8')).toBe('');
  });

  it.each([
    ['a header-bearing file outside the tree', true],
    ['a missing target', false],
  ])('a symlinked route file is application code and is never written through (link to %s)', async (_label, targetExists) => {
    await generate();
    const link = api('lanterns', '+server.ts');
    const target = join(outsideRoot, 'linked-handler.ts');
    const targetContent = `${AUTO_GENERATED_ROUTE_HEADER}\n// outside the routes tree\n`;
    if (targetExists) writeFileSync(target, targetContent);
    unlinkSync(link);
    symlinkSync(target, link);
    const before = inventory();
    const outsideBefore = inventory(outsideRoot);

    await expectOwnershipRefusal(generate(), [link]);

    expect(inventory()).toEqual(before);
    expect(inventory(outsideRoot)).toEqual(outsideBefore);
    if (targetExists) {
      expect(readFileSync(target, 'utf-8')).toBe(targetContent);
    } else {
      expect(existsSync(target)).toBe(false);
    }

    // A regular generated file at the same path is regenerated.
    unlinkSync(link);
    writeFileSync(link, `${AUTO_GENERATED_ROUTE_HEADER}\n// stale\n`);
    await generate();
    expect(readFileSync(link, 'utf-8')).not.toContain('// stale');
    expect(isGeneratedText(link)).toBe(true);
  });

  it('a directory named +server.ts is application code', async () => {
    await generate();
    const file = api('lanterns', '+server.ts');
    unlinkSync(file);
    mkdirSync(file);
    writeFileSync(join(file, 'notes.txt'), 'kept\n');
    const before = inventory();

    await expectOwnershipRefusal(generate(), [file]);

    expect(inventory()).toEqual(before);
  });

  it('any +server.js is application code, even with the header', async () => {
    await generate();
    const generatedTs = api('kites', '+server.ts');
    const js = api('kites', '+server.js');
    unlinkSync(generatedTs);
    writeFileSync(
      js,
      `${AUTO_GENERATED_ROUTE_HEADER}\nexport const GET = 1;\n`,
    );
    const before = inventory();

    await expectOwnershipRefusal(generate(), [js]);

    expect(inventory()).toEqual(before);
    expect(existsSync(generatedTs)).toBe(false);
  });

  it('a route directory that cannot be inspected refuses before anything changes', async () => {
    await generate();
    const directory = api('lanterns');
    rmSync(directory, { recursive: true });
    writeFileSync(directory, '// a file where the route directory goes\n');
    const before = inventory();

    await expectOwnershipRefusal(generate(), [directory]);

    expect(inventory()).toEqual(before);

    // A genuinely missing route directory is created at commit.
    unlinkSync(directory);
    await generate();
    expect(isGeneratedText(api('lanterns', '+server.ts'))).toBe(true);
  });

  it('a dangling directory link under the routes root refuses before anything changes', async () => {
    await generate();
    const kiteRoute = api('kites', '+server.ts');
    const kiteBytes = readFileSync(kiteRoute);
    const link = api('lanterns');
    rmSync(link, { recursive: true });
    symlinkSync(join(outsideRoot, 'missing-directory'), link);
    const beforeCleanup = vi.fn();
    const before = inventory();

    await expectOwnershipRefusal(
      generate(undefined, undefined, { beforeCleanup }),
      [link],
    );

    expect(beforeCleanup).not.toHaveBeenCalled();
    expect(readFileSync(kiteRoute)).toEqual(kiteBytes);
    expect(inventory()).toEqual(before);
    expect(existsSync(join(outsideRoot, 'missing-directory'))).toBe(false);

    // A genuinely missing directory (no link) is created.
    unlinkSync(link);
    await generate(undefined, undefined, { beforeCleanup });
    expect(beforeCleanup).toHaveBeenCalledTimes(1);
    expect(isGeneratedText(api('lanterns', '+server.ts'))).toBe(true);
  });
});

describe('a knowledge route outside the routes root', () => {
  it('a dangling ancestor of a knowledge route outside the routes root refuses before anything changes', async () => {
    const options = baseOptions({
      knowledge: { api: { enabled: true, basePath: '../shared/knowledge' } },
    });
    await generate(undefined, options);
    const knowledge = join(projectRoot, 'src/shared/knowledge/+server.ts');
    expect(isGeneratedText(knowledge)).toBe(true);
    const link = join(projectRoot, 'src/shared');
    rmSync(link, { recursive: true });
    symlinkSync(join(outsideRoot, 'missing-shared'), link);
    const beforeCleanup = vi.fn();
    const before = inventory();

    await expectOwnershipRefusal(
      generate(undefined, options, { beforeCleanup }),
      [link],
    );

    expect(beforeCleanup).not.toHaveBeenCalled();
    expect(inventory()).toEqual(before);
    expect(existsSync(join(outsideRoot, 'missing-shared'))).toBe(false);

    // A genuinely missing ancestor is created at commit.
    unlinkSync(link);
    await generate(undefined, options, { beforeCleanup });
    expect(beforeCleanup).toHaveBeenCalledTimes(1);
    expect(isGeneratedText(knowledge)).toBe(true);
  });
});

describe('refuse writers', () => {
  const writers: Array<[string, () => string]> = [
    ['collection', () => api('lanterns', '+server.ts')],
    ['item', () => api('lanterns', '[id]', '+server.ts')],
    ['custom action', () => api('lanterns', '[id]', 'light', '+server.ts')],
    ['knowledge', () => knowledgeRoute()],
    ['_changes', () => api('_changes', '+server.ts')],
    ['_events', () => api('_events', '+server.ts')],
  ];

  describe.each(writers)('the %s writer', (_label, routeFile) => {
    it.each([
      ['.ts', '+server.ts'],
      ['.js', '+server.js'],
    ])('generation refuses an application endpoint at every refuse writer (%s)', async (_extension, fileName) => {
      await generate();
      const generated = routeFile();
      expect(isGeneratedText(generated)).toBe(true);
      const application = join(generated, '..', fileName);
      unlinkSync(generated);
      writeFileSync(application, APPLICATION_HANDLER);
      const before = inventory();

      await expectOwnershipRefusal(generate(), [application]);

      expect(inventory()).toEqual(before);
    });
  });

  it('generation refuses an application endpoint at every refuse writer (negative: a clean tree regenerates)', async () => {
    await generate();
    const before = inventory();
    await generate();
    expect(inventory()).toEqual(before);
    for (const [, routeFile] of writers) {
      expect(isGeneratedText(routeFile())).toBe(true);
    }
  });

  it('a stale generated route beside a new application .js is left for the user', async () => {
    await generate();
    const stale = api('lanterns', '+server.ts');
    const staleBytes = readFileSync(stale);
    const js = api('lanterns', '+server.js');
    writeFileSync(js, APPLICATION_HANDLER);
    const before = inventory();

    await expectOwnershipRefusal(generate(), [js]);

    expect(inventory()).toEqual(before);
    expect(readFileSync(stale)).toEqual(staleBytes);
  });

  it('a differently cased endpoint on a case-insensitive file system refuses', async (context) => {
    const probe = join(projectRoot, 'case-probe');
    writeFileSync(probe, '');
    const caseInsensitive = existsSync(join(projectRoot, 'CASE-PROBE'));
    unlinkSync(probe);
    if (!caseInsensitive) {
      context.skip(
        'the temporary file system is case-sensitive; +SERVER.ts is a separate file here',
      );
      return;
    }
    await generate();
    const generated = api('lanterns', '+server.ts');
    unlinkSync(generated);
    writeFileSync(api('lanterns', '+SERVER.ts'), APPLICATION_HANDLER);
    const before = inventory();

    await expect(generate()).rejects.toMatchObject({ code: OWNERSHIP_CODE });

    expect(inventory()).toEqual(before);
  });

  it('both application endpoints in one directory are named in one error', async () => {
    await generate();
    const ts = api('lanterns', '+server.ts');
    const js = api('lanterns', '+server.js');
    writeFileSync(ts, APPLICATION_HANDLER);
    writeFileSync(js, APPLICATION_HANDLER);
    const before = inventory();

    await expectOwnershipRefusal(generate(), [ts, js]);

    expect(inventory()).toEqual(before);
  });

  it('an endpoint with a non-default extension is outside the guarantee', async () => {
    writeFile(api('lanterns', '+server.mts'), APPLICATION_HANDLER);

    await generate();

    expect(isGeneratedText(api('lanterns', '+server.ts'))).toBe(true);
    expect(readFileSync(api('lanterns', '+server.mts'), 'utf-8')).toBe(
      APPLICATION_HANDLER,
    );
  });
});

describe('a refused generation changes nothing', () => {
  it('a refused generation leaves its outputs untouched and runs no hooks', async () => {
    const beforeCleanup = vi.fn();
    await generate(undefined, undefined, { beforeCleanup });
    expect(beforeCleanup).toHaveBeenCalledTimes(1);
    beforeCleanup.mockClear();
    const file = api('kites', '[id]', '+server.ts');
    writeFileSync(file, APPLICATION_HANDLER);
    const before = inventory();

    await expectOwnershipRefusal(
      generate(undefined, undefined, { beforeCleanup }),
      [file],
    );

    expect(beforeCleanup).not.toHaveBeenCalled();
    expect(inventory()).toEqual(before);
  });

  it('every conflict is reported in one error', async () => {
    await generate();
    const collection = api('lanterns', '+server.ts');
    const itemJs = api('kites', '[id]', '+server.js');
    writeFileSync(collection, APPLICATION_HANDLER);
    unlinkSync(api('kites', '[id]', '+server.ts'));
    writeFileSync(itemJs, APPLICATION_HANDLER);
    writeFileSync(knowledgeRoute(), APPLICATION_HANDLER);
    const before = inventory();

    const refusal = await expectOwnershipRefusal(generate(), [
      collection,
      itemJs,
      knowledgeRoute(),
    ]);

    expect(refusal.files).toHaveLength(3);
    expect(inventory()).toEqual(before);
  });

  it('a route definition error is reported before an ownership conflict', async () => {
    writeFile(api('lanterns', '+server.ts'), APPLICATION_HANDLER);
    const duplicate = definition('Lantern', 'lanterns', {
      methods: { light: method('light'), ignite: method('ignite') },
      decoratorConfig: {
        api: {
          routes: {
            light: { method: 'POST', path: 'glow' },
            ignite: { method: 'POST', path: 'glow' },
          },
        },
      },
    } as Partial<SmartObjectDefinition>);
    const before = inventory();

    await expect(generate(manifest(duplicate))).rejects.toThrow(
      /Duplicate custom API route handler/,
    );

    expect(inventory()).toEqual(before);
  });

  it('a refusal on a project with no routes directory creates no directory', async () => {
    writeFile(knowledgeRoute(), APPLICATION_HANDLER);
    const before = inventory();

    await expectOwnershipRefusal(generate(), [knowledgeRoute()]);

    expect(inventory()).toEqual(before);
    expect(existsSync(api())).toBe(false);

    unlinkSync(knowledgeRoute());
    await generate();
    expect(existsSync(api('lanterns', '+server.ts'))).toBe(true);
    expect(isGeneratedText(knowledgeRoute())).toBe(true);
  });
});

describe('yield routes (sync/apply and _resources)', () => {
  function installSmrtUsers(): void {
    const location = join(
      projectRoot,
      'node_modules',
      '@happyvertical',
      'smrt-users',
    );
    mkdirSync(location, { recursive: true });
    writeFileSync(
      join(location, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-users',
        type: 'module',
        version: '1.0.0',
        exports: {
          './sveltekit': {
            types: './sveltekit.d.ts',
            import: './sveltekit.js',
          },
        },
      }),
    );
    writeFileSync(
      join(location, 'sveltekit.js'),
      'export function createResourceListHandler() {}\n',
    );
    writeFileSync(
      join(location, 'sveltekit.d.ts'),
      'export declare function createResourceListHandler(): unknown;\n',
    );
  }
  const resourcesOptions = () =>
    baseOptions({ resourcesRoute: { enabled: true } });

  it.each([
    ['sync/apply', '+server.ts'],
    ['sync/apply', '+server.js'],
    ['_resources', '+server.ts'],
    ['_resources', '+server.js'],
  ])('a hand-written sync/apply or _resources handler is left in place without a sibling (%s %s)', async (route, fileName) => {
    installSmrtUsers();
    const handler = api(...route.split('/'), fileName);
    writeFile(handler, APPLICATION_HANDLER);

    await generate(undefined, resourcesOptions());

    expect(readFileSync(handler, 'utf-8')).toBe(APPLICATION_HANDLER);
    expect(readdirSync(join(handler, '..')).sort()).toEqual([fileName]);
    expect(isGeneratedText(api('lanterns', '+server.ts'))).toBe(true);
  });

  it.each([
    ['sync/apply', 'LF', '\n'],
    ['_resources', 'LF', '\n'],
    ['sync/apply', 'CR', '\r'],
    ['_resources', 'CR', '\r'],
    ['sync/apply', 'LINE SEPARATOR', ' '],
    ['_resources', 'PARAGRAPH SEPARATOR', ' '],
  ])('a banner-prefixed generated handler at a yield route refuses (%s, banner ended by %s)', async (route, _terminator, lineEnd) => {
    installSmrtUsers();
    await generate(undefined, resourcesOptions());
    const file = api(...route.split('/'), '+server.ts');
    const generated = readFileSync(file, 'utf-8');
    writeFileSync(file, `// project banner${lineEnd}${generated}`);
    const before = inventory();

    await expectOwnershipRefusal(generate(undefined, resourcesOptions()), [
      file,
    ]);

    expect(inventory()).toEqual(before);
  });

  it('an earlier route at the _resources path keeps its content', async () => {
    installSmrtUsers();
    const resourcesModel = definition('ResourceIndex', '_resources');

    await generate(manifest(resourcesModel), resourcesOptions());

    const content = readFileSync(api('_resources', '+server.ts'), 'utf-8');
    expect(content.startsWith(AUTO_GENERATED_ROUTE_HEADER)).toBe(true);
    expect(content).not.toContain('createResourceListHandler');
  });

  it('_resources as sole claimant yields to an application handler', async () => {
    installSmrtUsers();
    const handler = api('_resources', '+server.ts');
    writeFile(handler, APPLICATION_HANDLER);

    await generate(undefined, resourcesOptions());

    expect(readFileSync(handler, 'utf-8')).toBe(APPLICATION_HANDLER);
  });

  it('a refuse claim at the _resources path still refuses an application handler', async () => {
    installSmrtUsers();
    const handler = api('_resources', '+server.ts');
    writeFile(handler, APPLICATION_HANDLER);
    const before = inventory();

    await expectOwnershipRefusal(
      generate(
        manifest(lantern(), definition('ResourceIndex', '_resources')),
        resourcesOptions(),
      ),
      [handler],
    );

    expect(inventory()).toEqual(before);
  });

  it('a model route at the sync/apply path conflicts with the sync-apply route', async () => {
    const syncModel = definition('Ledger', 'sync', {
      methods: { apply: { ...method('apply'), isStatic: true } },
      decoratorConfig: {
        api: { routes: { apply: { scope: 'collection', method: 'POST' } } },
      },
    } as Partial<SmartObjectDefinition>);
    const before = inventory();

    await expect(generate(manifest(syncModel))).rejects.toThrow(
      /Conflicting SvelteKit route/,
    );

    expect(inventory()).toEqual(before);
  });

  it('a model route differing from the sync-apply route only by case conflicts on a case-insensitive volume', async (context) => {
    const probe = join(projectRoot, 'case-probe');
    writeFileSync(probe, '');
    const caseInsensitive = existsSync(join(projectRoot, 'CASE-PROBE'));
    unlinkSync(probe);
    if (!caseInsensitive) {
      context.skip(
        'the temporary file system is case-sensitive; Sync/apply and sync/apply are separate paths here (unit test covers the case-folded key)',
      );
      return;
    }
    const syncModel = definition('Ledger', 'Sync', {
      methods: { apply: { ...method('apply'), isStatic: true } },
      decoratorConfig: {
        api: { routes: { apply: { scope: 'collection', method: 'POST' } } },
      },
    } as Partial<SmartObjectDefinition>);
    const before = inventory();

    await expect(generate(manifest(syncModel))).rejects.toThrow(
      /Conflicting SvelteKit route/,
    );

    expect(inventory()).toEqual(before);
  });

  it('a hand-written sole-claimant handler that mentions the header on its first line yields', async () => {
    const handler = api('sync', 'apply', '+server.ts');
    const source = `const marker = '${AUTO_GENERATED_ROUTE_HEADER}';\n${APPLICATION_HANDLER}`;
    writeFile(handler, source);

    await generate();

    expect(readFileSync(handler, 'utf-8')).toBe(source);
    expect(isGeneratedText(api('lanterns', '+server.ts'))).toBe(true);
  });

  it.each([
    ['sync/apply', 'empty', ''],
    ['sync/apply', 'partial-header', AUTO_GENERATED_ROUTE_HEADER.slice(0, 12)],
    ['_resources', 'empty', ''],
    ['_resources', 'partial-header', AUTO_GENERATED_ROUTE_HEADER.slice(0, 20)],
  ])('an interrupted generated write at a yield route refuses (%s, %s)', async (route, _label, content) => {
    installSmrtUsers();
    await generate(undefined, resourcesOptions());
    const file = api(...route.split('/'), '+server.ts');
    writeFileSync(file, content);
    const before = inventory();

    await expectOwnershipRefusal(generate(undefined, resourcesOptions()), [
      file,
    ]);

    expect(inventory()).toEqual(before);
  });

  it('a yield route names the application file it leaves in place', async () => {
    const handler = api('sync', 'apply', '+server.js');
    writeFile(handler, APPLICATION_HANDLER);

    await generate();

    expect(
      vi
        .mocked(console.warn)
        .mock.calls.some(([message]) =>
          String(message).includes(
            `Skipping sync-apply route - ${handler} exists`,
          ),
        ),
    ).toBe(true);
    expect(existsSync(api('sync', 'apply', '+server.ts'))).toBe(false);
  });
});

describe('case-only route paths', () => {
  it('two CRUD owners whose collections differ only by case fail before cleanup when case behaviour is undetermined', async () => {
    // An empty routes directory gives the read-only case probe nothing to
    // test, so `Books` and `books` may be one handler.
    mkdirSync(api(), { recursive: true });
    const beforeCleanup = vi.fn();
    const before = inventory();

    await expect(
      generate(
        manifest(definition('Book', 'Books'), definition('Booklet', 'books')),
        baseOptions({ rejectRouteCollisions: true }),
        { beforeCleanup },
      ),
    ).rejects.toThrow(/Conflicting SvelteKit route/);

    expect(beforeCleanup).not.toHaveBeenCalled();
    expect(inventory()).toEqual(before);

    // Distinct collection paths generate both endpoints.
    await generate(
      manifest(definition('Book', 'Books'), definition('Booklet', 'booklets')),
      baseOptions({ rejectRouteCollisions: true }),
    );
    expect(isGeneratedText(api('Books', '+server.ts'))).toBe(true);
    expect(isGeneratedText(api('booklets', '+server.ts'))).toBe(true);
  });
});

describe('writers and callers', () => {
  it('a direct generateSvelteKitRoutes caller gets the same refusal', async () => {
    await generate();
    const file = api('lanterns', '+server.ts');
    writeFileSync(file, APPLICATION_HANDLER);

    const refusal = await expectOwnershipRefusal(generate(), [file]);

    expect(refusal.files).toEqual([file]);
    expect(refusal.routes.length).toBeGreaterThan(0);
    expect(refusal.message).toMatch(/Move or rename/);
  });

  it('application files at paths the generator does not write are untouched', async () => {
    const health = api('health', '+server.ts');
    const nested = api('lanterns', 'reports', '+server.js');
    writeFile(health, APPLICATION_HANDLER);
    writeFile(nested, APPLICATION_HANDLER);

    await generate();

    expect(readFileSync(health, 'utf-8')).toBe(APPLICATION_HANDLER);
    expect(readFileSync(nested, 'utf-8')).toBe(APPLICATION_HANDLER);
  });

  it('a byte-order-marked generated route at an obsolete path is swept', async () => {
    const bom = api('obsolete', '+server.ts');
    const banner = api('retired', '+server.ts');
    writeFile(bom, `﻿${AUTO_GENERATED_ROUTE_HEADER}\n// obsolete\n`);
    writeFile(
      banner,
      `// banner\n${AUTO_GENERATED_ROUTE_HEADER}\n// obsolete with banner\n`,
    );

    await generate();

    expect(existsSync(bom)).toBe(false);
    expect(readFileSync(banner, 'utf-8')).toContain('obsolete with banner');
  });

  it('STI siblings sharing a collection still generate', async () => {
    const parent = definition('Kite', 'kites', {
      extends: 'SmrtObject',
      decoratorConfig: { api: true, tableStrategy: 'sti', tableName: 'kites' },
    } as Partial<SmartObjectDefinition>);
    const child = definition('BoxKite', 'kites', {
      extends: 'Kite',
      extendsQualified: `${PACKAGE}:Kite`,
      decoratorConfig: { api: true, tableStrategy: 'sti', tableName: 'kites' },
    } as Partial<SmartObjectDefinition>);

    await generate(manifest(parent, child));

    expect(isGeneratedText(api('kites', '+server.ts'))).toBe(true);
    await generate(manifest(parent, child));
    expect(isGeneratedText(api('kites', '+server.ts'))).toBe(true);
  });

  it.each([
    ['collection to item', ['lanterns'], ['lanterns', '[id]']],
    ['item to collection', ['lanterns', '[id]'], ['lanterns']],
  ])('a route file linked to another planned destination is refused in either order (%s)', async (_label, linkSegments, targetSegments) => {
    await generate();
    const link = api(...linkSegments, '+server.ts');
    const target = api(...targetSegments, '+server.ts');
    unlinkSync(link);
    symlinkSync(target, link);
    const before = inventory();

    await expectOwnershipRefusal(generate(), [link]);

    expect(inventory()).toEqual(before);
  });

  it('a directory alias is checked under both spellings', async () => {
    const realDirectory = api('lantern-archive');
    const handler = join(realDirectory, '+server.ts');
    writeFile(handler, APPLICATION_HANDLER);
    mkdirSync(api(), { recursive: true });
    symlinkSync(realDirectory, api('lanterns'));
    const before = inventory();

    await expectOwnershipRefusal(generate(), [api('lanterns', '+server.ts')]);

    expect(inventory()).toEqual(before);
    expect(readFileSync(handler, 'utf-8')).toBe(APPLICATION_HANDLER);

    // The real spelling refuses as well.
    const archive = definition('LanternArchive', 'lantern-archive');
    await expectOwnershipRefusal(generate(manifest(archive)), [handler]);
    expect(readFileSync(handler, 'utf-8')).toBe(APPLICATION_HANDLER);
  });

  it('the dev-plane route follows the ownership rule when it is enabled', async () => {
    const location = join(
      projectRoot,
      'node_modules',
      '@happyvertical',
      'smrt-dev-mcp',
    );
    mkdirSync(join(location, 'dist'), { recursive: true });
    writeFileSync(
      join(location, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-dev-mcp',
        type: 'module',
        version: '1.0.0',
        exports: {
          './dev-plane': {
            types: './dist/dev-plane.d.ts',
            import: './dist/dev-plane.js',
          },
        },
      }),
    );
    writeFileSync(
      join(location, 'dist/dev-plane.js'),
      'export function createDevPlane() {}\n',
    );
    writeFileSync(
      join(location, 'dist/dev-plane.d.ts'),
      'export declare function createDevPlane(): unknown;\n',
    );
    const options = baseOptions({ devPlaneRoute: { enabled: true } });
    await generate(undefined, options);
    const route = api('_dev', '[...tool]', '+server.ts');
    expect(isGeneratedText(route)).toBe(true);

    writeFileSync(route, APPLICATION_HANDLER);
    const before = inventory();

    await expectOwnershipRefusal(generate(undefined, options), [route]);

    expect(inventory()).toEqual(before);
  });
});

describe('the config module name', () => {
  it.each([
    '+server.js',
    '+server.js/.',
    'nested/../+server.js',
  ])('a config file name with the route-file prefix is rejected before anything changes (%s)', async (configFileName) => {
    await generate();
    const before = inventory();

    await expect(
      generate(
        undefined,
        baseOptions({ configPath: 'src/routes/api/lanterns', configFileName }),
      ),
    ).rejects.toThrow(/configFileName '.*' is reserved/);

    expect(inventory()).toEqual(before);
    expect(existsSync(api('lanterns', '+server.js'))).toBe(false);

    // Negative control: an ordinary config module name generates.
    await generate(undefined, baseOptions({ configFileName: 'smrt.ts' }));
    expect(existsSync(join(projectRoot, 'src/lib/server/smrt.ts'))).toBe(true);
  });
});

describe('rollback and rebuild', () => {
  it('ownership is re-read on every generation', async () => {
    await generate();
    const file = api('lanterns', '[id]', 'light', '+server.ts');
    writeFileSync(file, APPLICATION_HANDLER);
    await expectOwnershipRefusal(generate(), [file]);

    unlinkSync(file);
    await generate();
    expect(isGeneratedText(file)).toBe(true);

    writeFileSync(file, APPLICATION_HANDLER);
    await expectOwnershipRefusal(generate(), [file]);
    expect(readFileSync(file, 'utf-8')).toBe(APPLICATION_HANDLER);
  });

  it('a clean build is unchanged', async () => {
    await generate();
    const first = inventory();
    await generate();
    expect(inventory()).toEqual(first);
  });
});

describe('the direct producer path', () => {
  const MODEL = `import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ api: { routes: { light: { method: 'POST' } } } })
export class Lantern extends SmrtObject {
  name = '';

  async light(): Promise<boolean> {
    return true;
  }
}
`;

  async function generateDirect(): Promise<void> {
    const plugin = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
      svelteKit: {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      },
    });
    await (plugin as any).configResolved({
      root: projectRoot,
      build: {},
      plugins: [],
    });
  }

  it.each([
    ['collection', () => api('lanterns', '+server.ts')],
    ['item', () => api('lanterns', '[id]', '+server.ts')],
    ['custom action', () => api('lanterns', '[id]', 'light', '+server.ts')],
    ['knowledge', () => knowledgeRoute()],
    ['_changes', () => api('_changes', '+server.ts')],
    ['_events', () => api('_events', '+server.ts')],
  ])('the direct producer path enforces ownership for every writer it can enable (%s)', async (_label, routeFile) => {
    writeFile(join(projectRoot, 'src/lib/objects/Lantern.ts'), MODEL);
    mkdirSync(join(projectRoot, 'src/lib/server'), { recursive: true });
    writeFileSync(
      join(projectRoot, 'smrt.config.json'),
      JSON.stringify({ knowledge: { api: { enabled: true } } }),
    );
    await generateDirect();
    const file = routeFile();
    expect(isGeneratedText(file)).toBe(true);
    writeFileSync(file, APPLICATION_HANDLER);

    await expectOwnershipRefusal(generateDirect(), [file]);

    expect(readFileSync(file, 'utf-8')).toBe(APPLICATION_HANDLER);
  });
});
