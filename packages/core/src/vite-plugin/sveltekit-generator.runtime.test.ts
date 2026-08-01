import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types.js';
import { generateSvelteKitRoutes } from './sveltekit-generator.js';

function createManifest(
  projectRoot: string,
  objectFilePath: string,
): SmartObjectManifest {
  return {
    objects: {
      Widget: {
        className: 'Widget',
        collection: 'widgets',
        decoratorConfig: {
          api: true,
        },
        fields: {},
        filePath: objectFilePath,
        methods: {},
      },
    },
    packageName: '@test/generated-helper-app',
  };
}

function writeWorkspaceCoreShim(projectRoot: string): void {
  const packageDir = join(
    projectRoot,
    'node_modules',
    '@happyvertical',
    'smrt-core',
  );
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(
    join(packageDir, 'package.json'),
    JSON.stringify(
      {
        exports: {
          '.': './index.js',
        },
        name: '@happyvertical/smrt-core',
        type: 'module',
        version: '1.0.0',
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(packageDir, 'index.js'),
    [
      'globalThis.__smrtGeneratedHelperCalls ??= [];',
      'globalThis.__smrtGeneratedHelperRegistrations ??= [];',
      'export const ObjectRegistry = {',
      '  async getCollection(...args) {',
      '    globalThis.__smrtGeneratedHelperCalls.push(args);',
      "    return { marker: 'collection' };",
      '  },',
      '  register(...args) {',
      '    globalThis.__smrtGeneratedHelperRegistrations.push(args);',
      '  },',
      '};',
    ].join('\n'),
  );
}

function isIgnoredByGit(projectRoot: string, relativePath: string): boolean {
  const result = spawnSync(
    'git',
    ['check-ignore', '--no-index', '--quiet', relativePath],
    { cwd: projectRoot },
  );
  if (result.error) throw result.error;
  return result.status === 0;
}

function initializeGitRepository(projectRoot: string): void {
  const result = spawnSync('git', ['init', '--quiet'], { cwd: projectRoot });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git init failed with status ${result.status}`);
  }
}

describe('generated SvelteKit helper runtime', () => {
  const originalScopedDbGetter = globalThis.__smrtGetRequestScopedDatabase;
  let projectRoot = '';

  beforeEach(() => {
    (globalThis as Record<string, unknown>).__smrtGeneratedHelperCalls = [];
    (globalThis as Record<string, unknown>).__smrtGeneratedHelperRegistrations =
      [];
    projectRoot = mkdtempSync(join(tmpdir(), 'smrt-sveltekit-helper-'));
    mkdirSync(join(projectRoot, 'src/lib/objects'), {
      recursive: true,
    });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify(
        {
          name: 'generated-helper-app',
          type: 'module',
          version: '1.0.0',
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(projectRoot, 'src/lib/objects/Widget.ts'),
      'export class Widget {}\n',
    );
    writeWorkspaceCoreShim(projectRoot);
    initializeGitRepository(projectRoot);
  });

  afterEach(() => {
    vi.restoreAllMocks();

    if (originalScopedDbGetter) {
      globalThis.__smrtGetRequestScopedDatabase = originalScopedDbGetter;
    } else {
      delete globalThis.__smrtGetRequestScopedDatabase;
    }

    rmSync(projectRoot, { force: true, recursive: true });
    projectRoot = '';
    delete (globalThis as Record<string, unknown>).__smrtGeneratedHelperCalls;
    delete (globalThis as Record<string, unknown>)
      .__smrtGeneratedHelperRegistrations;
  });

  async function importGeneratedHelper() {
    const objectFilePath = join(projectRoot, 'src/lib/objects/Widget.ts');
    await generateSvelteKitRoutes(
      projectRoot,
      createManifest(projectRoot, objectFilePath),
      {
        configFileName: 'smrt.ts',
        configPath: 'src/lib/server',
        enabled: true,
        objectsDir: 'src/lib/objects',
        routesDir: 'src/routes/api',
      },
    );

    return await import(
      pathToFileURL(join(projectRoot, 'src/lib/server/smrt.ts')).href
    );
  }

  it('prefers the request-scoped database when no explicit db override is provided', async () => {
    const requestScopedDb = {
      type: 'sqlite',
      url: 'request-scoped.db',
    };
    globalThis.__smrtGetRequestScopedDatabase = () => requestScopedDb as never;

    const helper = await importGeneratedHelper();

    await helper.getCollection('Widget');

    expect(
      (globalThis as Record<string, unknown>).__smrtGeneratedHelperCalls,
    ).toEqual([
      [
        'Widget',
        expect.objectContaining({
          db: requestScopedDb,
        }),
      ],
    ]);
  });

  it('keeps explicit db overrides ahead of the request-scoped database', async () => {
    const requestScopedDb = {
      type: 'sqlite',
      url: 'request-scoped.db',
    };
    const explicitDb = {
      type: 'sqlite',
      url: 'explicit.db',
    };
    globalThis.__smrtGetRequestScopedDatabase = () => requestScopedDb as never;

    const helper = await importGeneratedHelper();

    await helper.getCollection('Widget', {
      db: explicitDb,
    });

    expect(
      (globalThis as Record<string, unknown>).__smrtGeneratedHelperCalls,
    ).toEqual([
      [
        'Widget',
        expect.objectContaining({
          db: expect.objectContaining({
            type: 'sqlite',
            url: 'explicit.db',
          }),
        }),
      ],
    ]);
  });

  it('migrates the default route directory without ignoring handwritten handlers', async () => {
    const handwrittenRoute = join(
      projectRoot,
      'src/routes/api/_resources/+server.ts',
    );
    mkdirSync(join(projectRoot, 'src/routes/api/_resources'), {
      recursive: true,
    });
    writeFileSync(
      handwrittenRoute,
      'export const GET = () => new Response("handwritten");\n',
    );
    writeFileSync(
      join(projectRoot, '.gitignore'),
      [
        'node_modules/',
        '# SMRT auto-generated routes (from Vite plugin)',
        'src/routes/api/**/+server.ts',
        '# Application-owned output',
        'coverage/',
        '',
      ].join('\n'),
    );

    const manifest = createManifest(
      projectRoot,
      join(projectRoot, 'src/lib/objects/Widget.ts'),
    );
    const options = {
      configFileName: 'smrt.ts',
      configPath: 'src/lib/server',
      enabled: true,
      objectsDir: 'src/lib/objects',
      routesDir: 'src/routes/api',
    };

    await generateSvelteKitRoutes(projectRoot, manifest, options);
    await generateSvelteKitRoutes(projectRoot, manifest, options);

    const gitignore = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    const generatedCollectionRoute = 'src/routes/api/widgets/+server.ts';
    expect(gitignore).toContain('# Application-owned output');
    expect(gitignore).toContain('coverage/');
    expect(gitignore).toContain(generatedCollectionRoute);
    expect(gitignore).toContain('src/routes/api/widgets/[id]/+server.ts');
    expect(gitignore).not.toContain('src/routes/api/**/+server.ts');
    expect(readFileSync(handwrittenRoute, 'utf-8')).toContain('handwritten');
    expect(
      readFileSync(join(projectRoot, generatedCollectionRoute), 'utf-8'),
    ).toContain('export const GET');
    expect(isIgnoredByGit(projectRoot, generatedCollectionRoute)).toBe(true);
    expect(
      isIgnoredByGit(projectRoot, 'src/routes/api/_resources/+server.ts'),
    ).toBe(false);
  });

  it('uses the configured routesDir for exact generated ignores', async () => {
    const handwrittenRoute = join(
      projectRoot,
      'src/routes/generated-api/manual/+server.ts',
    );
    mkdirSync(join(projectRoot, 'src/routes/generated-api/manual'), {
      recursive: true,
    });
    writeFileSync(
      handwrittenRoute,
      'export const GET = () => new Response("manual");\n',
    );

    await generateSvelteKitRoutes(
      projectRoot,
      createManifest(
        projectRoot,
        join(projectRoot, 'src/lib/objects/Widget.ts'),
      ),
      {
        configFileName: 'smrt.ts',
        configPath: 'src/lib/server',
        enabled: true,
        objectsDir: 'src/lib/objects',
        routesDir: 'src/routes/generated-api',
      },
    );

    const gitignore = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('src/routes/generated-api/widgets/+server.ts');
    expect(gitignore).not.toContain('src/routes/api/**/+server.ts');
    expect(
      isIgnoredByGit(
        projectRoot,
        'src/routes/generated-api/widgets/+server.ts',
      ),
    ).toBe(true);
    expect(
      isIgnoredByGit(projectRoot, 'src/routes/generated-api/manual/+server.ts'),
    ).toBe(false);
  });
});
