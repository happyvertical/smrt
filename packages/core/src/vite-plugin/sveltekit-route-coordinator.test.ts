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
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  publishArtifactFiles,
  setArtifactFilesystemForTesting,
} from '../consumer-plugin/artifact-publication.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import {
  nodeRouteFileSystem,
  setRouteFileSystemForTesting,
} from './generated-route-files.js';
import {
  clearGeneratedSvelteKitRouteFiles,
  type SvelteKitOptions,
} from './sveltekit-generator.js';
import { canonicalSvelteKitPath } from './sveltekit-path.js';
import {
  assertSvelteKitRouteCoordinationComplete,
  contributeSvelteKitRoutes,
  expectedSvelteKitRouteOwners,
  markSvelteKitRouteParticipant,
  producerKnowledgeRoutePaths,
  revokeSvelteKitRoutes,
  type SvelteKitCoordinatorPausePoint,
  type SvelteKitRouteOwner,
  type SvelteKitSubmissionOutcome,
  setSvelteKitCoordinatorPauseHookForTesting,
  svelteKitLifecycleLock,
} from './sveltekit-route-coordinator.js';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryProject(): string {
  const root = mkdtempSync(join(tmpdir(), 'smrt-sveltekit-coordinator-'));
  temporaryRoots.push(root);
  return root;
}

function routeOptions(
  overrides: Partial<SvelteKitOptions> = {},
): SvelteKitOptions {
  return {
    enabled: true,
    routesDir: 'src/routes/api',
    objectsDir: 'src/lib/objects',
    configPath: 'src/lib/server',
    configFileName: 'smrt.ts',
    changesRoute: { enabled: false },
    eventsRoute: { enabled: false },
    resourcesRoute: { enabled: false },
    rejectRouteCollisions: true,
    ...overrides,
  };
}

function manifest(
  key: string,
  className: string,
  collection: string,
  packageName: string,
  filePath = join('/virtual/node_modules', packageName, `${className}.ts`),
): SmartObjectManifest {
  return {
    version: '1',
    timestamp: 0,
    packageName,
    objects: {
      [key]: {
        qualifiedName: key.includes(':') ? key : `${packageName}:${className}`,
        className,
        collection,
        packageName,
        filePath,
        fields: {},
        methods: {},
        decoratorConfig: { api: true },
      },
    },
  } as SmartObjectManifest;
}

function routeFile(root: string, collection: string): string {
  return join(root, 'src/routes/api', collection, '+server.ts');
}

async function contribute(
  lifecycle: object,
  expectedOwners: Iterable<SvelteKitRouteOwner>,
  root: string,
  owner: SvelteKitRouteOwner,
  routeManifest: SmartObjectManifest,
  options = routeOptions(),
  semanticManifest = routeManifest,
  reservedRoutePaths?: ReadonlySet<string>,
): Promise<void> {
  await contributeSvelteKitRoutes(lifecycle, expectedOwners, root, {
    owner,
    routeManifest,
    semanticManifest,
    options,
    reservedRoutePaths,
  });
}

describe('SvelteKit route participant targets', () => {
  it('waits only for participants with the same routesDir', async () => {
    const producer = { name: 'smrt-auto-service' } as Plugin;
    const consumer = { name: 'smrt-consumer' } as Plugin;
    markSvelteKitRouteParticipant(producer, 'producer', true, 'src/routes/api');
    markSvelteKitRouteParticipant(
      consumer,
      'consumer',
      true,
      'src/routes/external',
    );
    const config = {
      plugins: [false, Promise.resolve([producer, [null, consumer]])],
    };

    await expect(
      expectedSvelteKitRouteOwners(config, '/project', 'src/routes/api'),
    ).resolves.toEqual(['producer']);
    await expect(
      expectedSvelteKitRouteOwners(config, '/project', 'src/routes/external'),
    ).resolves.toEqual(['consumer']);
    const aliasedProducer = { name: 'smrt-auto-service' } as Plugin;
    const aliasedConsumer = { name: 'smrt-consumer' } as Plugin;
    markSvelteKitRouteParticipant(
      aliasedProducer,
      'producer',
      true,
      'src/routes/api/',
    );
    markSvelteKitRouteParticipant(
      aliasedConsumer,
      'consumer',
      true,
      './src/routes/api',
    );
    await expect(
      expectedSvelteKitRouteOwners(
        { plugins: [aliasedProducer, aliasedConsumer] },
        '/project',
        'src/routes/api',
      ),
    ).resolves.toEqual(['producer', 'consumer']);
  });

  it('matches Vite apply filtering and each marker’s artifact root', async () => {
    const producer = { name: 'smrt-auto-service', apply: 'build' } as Plugin;
    const consumer = { name: 'smrt-consumer', apply: 'serve' } as Plugin;
    const callback = {
      name: 'smrt-callback',
      apply: (config: { mode?: string }, env: { command: string }) =>
        config.mode === 'development' && env.command === 'serve',
    } as Plugin;
    markSvelteKitRouteParticipant(
      producer,
      'producer',
      true,
      'src/routes/api',
      undefined,
      () => '/producer-root',
    );
    markSvelteKitRouteParticipant(
      consumer,
      'consumer',
      true,
      'src/routes/api',
      undefined,
      () => '/consumer-root',
    );
    markSvelteKitRouteParticipant(
      callback,
      'producer',
      true,
      'src/routes/callback',
      undefined,
      () => '/callback-root',
    );
    const config = {
      plugins: [false, Promise.resolve([producer, [null, consumer, callback]])],
    };

    await expect(
      expectedSvelteKitRouteOwners(config, '/consumer-root', 'src/routes/api', {
        command: 'serve',
        mode: 'development',
      } as any),
    ).resolves.toEqual(['consumer']);
    await expect(
      expectedSvelteKitRouteOwners(config, '/producer-root', 'src/routes/api', {
        command: 'build',
        mode: 'production',
      } as any),
    ).resolves.toEqual(['producer']);
    await expect(
      expectedSvelteKitRouteOwners(
        config,
        '/callback-root',
        'src/routes/callback',
        { command: 'serve', mode: 'development' } as any,
      ),
    ).resolves.toEqual(['producer']);
    await expect(
      expectedSvelteKitRouteOwners(
        config,
        '/callback-root',
        'src/routes/callback',
        { command: 'build', mode: 'production' } as any,
      ),
    ).resolves.toEqual([]);
  });

  it('coordinates physical route targets across different artifact roots', async () => {
    const producer = { name: 'smrt-auto-service' } as Plugin;
    const consumer = { name: 'smrt-consumer' } as Plugin;
    markSvelteKitRouteParticipant(
      producer,
      'producer',
      true,
      'src/routes/api',
      undefined,
      () => '/repo/app',
    );
    markSvelteKitRouteParticipant(
      consumer,
      'consumer',
      true,
      'app/src/routes/api',
      undefined,
      () => '/repo',
    );
    const config = { plugins: [producer, consumer] };

    await expect(
      expectedSvelteKitRouteOwners(config, '/repo/app', 'src/routes/api'),
    ).resolves.toEqual(['producer', 'consumer']);
    await expect(
      expectedSvelteKitRouteOwners(config, '/repo', 'app/src/routes/api'),
    ).resolves.toEqual(['producer', 'consumer']);
  });

  it('rejects physical nested route targets across different artifact roots', async () => {
    const producer = { name: 'smrt-auto-service' } as Plugin;
    const consumer = { name: 'smrt-consumer' } as Plugin;
    markSvelteKitRouteParticipant(
      producer,
      'producer',
      true,
      'src/routes/api',
      undefined,
      () => '/repo/app',
    );
    markSvelteKitRouteParticipant(
      consumer,
      'consumer',
      true,
      'app/src/routes/api/external',
      undefined,
      () => '/repo',
    );
    const config = { plugins: [producer, consumer] };

    await expect(
      expectedSvelteKitRouteOwners(config, '/repo/app', 'src/routes/api'),
    ).rejects.toThrow('Incompatible nested SvelteKit routesDir ownership');
  });

  it.each([
    ['producer first', ['producer', 'consumer']],
    ['consumer first', ['consumer', 'producer']],
  ] as const)('rejects nested active route roots before cleanup when %s', async (_name, order) => {
    const root = temporaryProject();
    await contribute(
      {},
      ['consumer'],
      root,
      'consumer',
      manifest(
        '@acme/widgets:RemoteWidget',
        'RemoteWidget',
        'external/widgets',
        '@acme/widgets',
      ),
      routeOptions({ routesDir: 'src/routes/api/external' }),
    );
    const previousPath = join(
      root,
      'src/routes/api/external/external/widgets/+server.ts',
    );
    const previousBytes = readFileSync(previousPath, 'utf8');
    const producer = { name: 'smrt-auto-service' } as Plugin;
    const consumer = { name: 'smrt-consumer' } as Plugin;
    markSvelteKitRouteParticipant(producer, 'producer', true, 'src/routes/api');
    markSvelteKitRouteParticipant(
      consumer,
      'consumer',
      true,
      'src/routes/api/external',
    );
    const plugins = order.map((owner) =>
      owner === 'producer' ? producer : consumer,
    );
    const config = { plugins: [false, Promise.resolve([plugins])] };

    await expect(
      expectedSvelteKitRouteOwners(config, root, ownerRouteDir(order[0])),
    ).rejects.toThrow('Incompatible nested SvelteKit routesDir ownership');
    // A watcher repeats the same preflight rather than deleting the child
    // surface through a parent-root sweep.
    await expect(
      expectedSvelteKitRouteOwners(config, root, ownerRouteDir(order[1])),
    ).rejects.toThrow('Incompatible nested SvelteKit routesDir ownership');
    expect(readFileSync(previousPath, 'utf8')).toBe(previousBytes);
  });
});

function ownerRouteDir(owner: SvelteKitRouteOwner): string {
  return owner === 'producer' ? 'src/routes/api' : 'src/routes/api/external';
}

describe('contributeSvelteKitRoutes', () => {
  it('fails closed at config resolution when an active shared participant never contributed', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'producer',
      manifest(
        '@acme/local:LocalWidget',
        'LocalWidget',
        'localwidgets',
        '@acme/local',
      ),
    );

    expect(() => assertSvelteKitRouteCoordinationComplete(lifecycle)).toThrow(
      'Incomplete SvelteKit route coordination',
    );
    expect(existsSync(routeFile(root, 'localwidgets'))).toBe(false);
  });

  it.each([
    ['producer first', ['producer', 'consumer']],
    ['consumer first', ['consumer', 'producer']],
  ] as const)('keeps both route surfaces when %s', async (_name, order) => {
    const root = temporaryProject();
    const lifecycle = {};
    const producerManifest = manifest(
      'LocalWidget',
      'LocalWidget',
      'local-widgets',
      '@app/local',
    );
    const consumerManifest = manifest(
      '@acme/widgets:RemoteWidget',
      'RemoteWidget',
      'remote-widgets',
      '@acme/widgets',
    );

    for (const owner of order) {
      await contribute(
        lifecycle,
        ['producer', 'consumer'],
        root,
        owner,
        owner === 'producer' ? producerManifest : consumerManifest,
      );
    }

    expect(existsSync(routeFile(root, 'local-widgets'))).toBe(true);
    expect(existsSync(routeFile(root, 'remote-widgets'))).toBe(true);
  });

  it('rejects differing config file names for one physical route target before cleanup', async () => {
    const root = temporaryProject();
    const existing = join(root, 'src/routes/api/existing/+server.ts');
    await contribute(
      {},
      ['producer'],
      root,
      'producer',
      manifest('Existing', 'Existing', 'existing', '@app/local'),
    );
    const previous = readFileSync(existing, 'utf8');
    const lifecycle = {};
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'producer',
      manifest('LocalWidget', 'LocalWidget', 'local-widgets', '@app/local'),
    );
    await expect(
      contribute(
        lifecycle,
        ['producer', 'consumer'],
        root,
        'consumer',
        manifest(
          '@acme/widgets:RemoteWidget',
          'RemoteWidget',
          'remote-widgets',
          '@acme/widgets',
        ),
        routeOptions({ configFileName: 'external.ts' }),
      ),
    ).rejects.toThrow('Incompatible SvelteKit route settings');
    expect(readFileSync(existing, 'utf8')).toBe(previous);
  });

  it('coordinates equivalent route directory spellings as one physical target', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'producer',
      manifest('LocalWidget', 'LocalWidget', 'local-widgets', '@app/local'),
      routeOptions({ routesDir: 'src/routes/api/' }),
    );
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'consumer',
      manifest(
        '@acme/widgets:RemoteWidget',
        'RemoteWidget',
        'remote-widgets',
        '@acme/widgets',
      ),
      routeOptions({ routesDir: './src/routes/api' }),
    );

    expect(existsSync(routeFile(root, 'local-widgets'))).toBe(true);
    expect(existsSync(routeFile(root, 'remote-widgets'))).toBe(true);
  });

  it('preserves the consumer collision preflight when producer defaults omit it', async () => {
    const root = temporaryProject();
    const establishedLifecycle = {};
    await contribute(
      establishedLifecycle,
      ['producer'],
      root,
      'producer',
      manifest('Previous', 'Previous', 'previous', '@app/local'),
    );
    const previousPath = routeFile(root, 'previous');
    const previousBytes = readFileSync(previousPath, 'utf8');

    const lifecycle = {};
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'producer',
      manifest('LocalWidget', 'LocalWidget', 'widgets', '@app/local'),
      routeOptions({ rejectRouteCollisions: undefined }),
    );
    await expect(
      contribute(
        lifecycle,
        ['producer', 'consumer'],
        root,
        'consumer',
        manifest(
          '@acme/widgets:RemoteWidget',
          'RemoteWidget',
          'widgets',
          '@acme/widgets',
        ),
        routeOptions({ rejectRouteCollisions: true }),
      ),
    ).rejects.toThrow('Conflicting SvelteKit route');

    expect(readFileSync(previousPath, 'utf8')).toBe(previousBytes);
    expect(existsSync(routeFile(root, 'widgets'))).toBe(false);
  });

  it('replaces one owner contribution without deleting the other owner routes', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    const consumerManifest = manifest(
      '@acme/widgets:RemoteWidget',
      'RemoteWidget',
      'remote-widgets',
      '@acme/widgets',
    );

    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'producer',
      manifest('OldLocal', 'OldLocal', 'old-locals', '@app/local'),
    );
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'consumer',
      consumerManifest,
    );
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'producer',
      manifest('NewLocal', 'NewLocal', 'new-locals', '@app/local'),
    );

    expect(existsSync(routeFile(root, 'old-locals'))).toBe(false);
    expect(existsSync(routeFile(root, 'new-locals'))).toBe(true);
    expect(existsSync(routeFile(root, 'remote-widgets'))).toBe(true);
  });

  it.each([
    ['producer first', ['producer', 'consumer']],
    ['consumer first', ['consumer', 'producer']],
  ] as const)('reconciles a revoked shared consumer root without deleting producer routes when %s', async (_name, order) => {
    const root = temporaryProject();
    await contribute(
      {},
      ['consumer'],
      root,
      'consumer',
      manifest(
        '@acme/widgets:RemoteWidget',
        'RemoteWidget',
        'remote-widgets',
        '@acme/widgets',
      ),
    );
    const lifecycle = {};
    for (const owner of order) {
      if (owner === 'producer') {
        await contribute(
          lifecycle,
          ['producer'],
          root,
          'producer',
          manifest('LocalWidget', 'LocalWidget', 'local-widgets', '@app/local'),
        );
      } else {
        await revokeSvelteKitRoutes(
          lifecycle,
          ['producer'],
          root,
          'src/routes/api',
        );
      }
    }

    expect(existsSync(routeFile(root, 'local-widgets'))).toBe(true);
    expect(existsSync(routeFile(root, 'remote-widgets'))).toBe(false);
  });

  it('does not retain a removed consumer contribution in a fresh lifecycle', async () => {
    const root = temporaryProject();
    const firstLifecycle = {};
    const localManifest = manifest(
      'LocalWidget',
      'LocalWidget',
      'local-widgets',
      '@app/local',
    );

    await contribute(
      firstLifecycle,
      ['producer', 'consumer'],
      root,
      'producer',
      localManifest,
    );
    await contribute(
      firstLifecycle,
      ['producer', 'consumer'],
      root,
      'consumer',
      manifest(
        '@acme/widgets:RemoteWidget',
        'RemoteWidget',
        'remote-widgets',
        '@acme/widgets',
      ),
    );

    await contribute(
      {},
      ['producer'],
      root,
      'producer',
      manifest('NewLocal', 'NewLocal', 'new-locals', '@app/local'),
    );

    expect(existsSync(routeFile(root, 'new-locals'))).toBe(true);
    expect(existsSync(routeFile(root, 'local-widgets'))).toBe(false);
    expect(existsSync(routeFile(root, 'remote-widgets'))).toBe(false);
  });

  it('does not clear the previous generated surface until every expected participant validates and contributes', async () => {
    const root = temporaryProject();
    const establishedLifecycle = {};
    const previousManifest = manifest(
      'PreviousLocal',
      'PreviousLocal',
      'previous-locals',
      '@app/local',
    );

    await contribute(
      establishedLifecycle,
      ['producer'],
      root,
      'producer',
      previousManifest,
    );
    const previousPath = routeFile(root, 'previous-locals');
    const previousBytes = readFileSync(previousPath, 'utf8');

    // A consumer whose selected-object validation fails never publishes a
    // contribution. The producer must therefore leave this prior surface
    // intact instead of clearing it during its earlier config hook.
    await contribute(
      {},
      ['producer', 'consumer'],
      root,
      'producer',
      manifest(
        'ReplacementLocal',
        'ReplacementLocal',
        'replacements',
        '@app/local',
      ),
    );

    expect(readFileSync(previousPath, 'utf8')).toBe(previousBytes);
    expect(existsSync(routeFile(root, 'replacements'))).toBe(false);
  });

  it('keeps the producer default change-feed owner scoped to producer metadata', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    const producerManifest = manifest(
      'LocalWidget',
      'LocalWidget',
      'local-widgets',
      '@app/local',
    );
    const consumerManifest = manifest(
      '@acme/widgets:RemoteWidget',
      'RemoteWidget',
      'remote-widgets',
      '@acme/widgets',
    );

    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'producer',
      producerManifest,
      routeOptions({ changesRoute: undefined }),
    );
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'consumer',
      consumerManifest,
      routeOptions({ changesRoute: { enabled: false } }),
    );

    const changesRoute = readFileSync(
      join(root, 'src/routes/api/_changes/+server.ts'),
      'utf8',
    );
    expect(changesRoute).toContain("getCollection('LocalWidget')");
    expect(changesRoute).not.toContain('RemoteWidget');
  });

  it('rejects explicit competing utility owners before replacing prior routes', async () => {
    const root = temporaryProject();
    const establishedLifecycle = {};
    const previousManifest = manifest(
      'PreviousLocal',
      'PreviousLocal',
      'previous-locals',
      '@app/local',
    );
    await contribute(
      establishedLifecycle,
      ['producer'],
      root,
      'producer',
      previousManifest,
    );
    const previousPath = routeFile(root, 'previous-locals');
    const previousBytes = readFileSync(previousPath, 'utf8');

    const lifecycle = {};
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'producer',
      manifest('LocalWidget', 'LocalWidget', 'local-widgets', '@app/local'),
      routeOptions({ changesRoute: undefined }),
    );

    await expect(
      contribute(
        lifecycle,
        ['producer', 'consumer'],
        root,
        'consumer',
        manifest(
          '@acme/widgets:RemoteWidget',
          'RemoteWidget',
          'remote-widgets',
          '@acme/widgets',
        ),
        routeOptions({ changesRoute: { enabled: true } }),
      ),
    ).rejects.toThrow(
      'Conflicting SvelteKit utility route owner for changesRoute',
    );

    expect(readFileSync(previousPath, 'utf8')).toBe(previousBytes);
    expect(existsSync(routeFile(root, 'local-widgets'))).toBe(false);
    expect(existsSync(routeFile(root, 'remote-widgets'))).toBe(false);
  });

  it('emits independent route roots while composing their shared registration helper', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    await contribute(
      lifecycle,
      ['producer'],
      root,
      'producer',
      manifest(
        'LocalWidget',
        'LocalWidget',
        'local-widgets',
        '@app/local',
        join(root, 'src/lib/objects/LocalWidget.ts'),
      ),
      routeOptions(),
    );
    await contribute(
      lifecycle,
      ['consumer'],
      root,
      'consumer',
      manifest(
        '@acme/widgets:RemoteWidget',
        'RemoteWidget',
        'remote-widgets',
        '@acme/widgets',
      ),
      routeOptions({ routesDir: 'src/routes/external' }),
    );

    expect(existsSync(routeFile(root, 'local-widgets'))).toBe(true);
    expect(
      existsSync(join(root, 'src/routes/external/remote-widgets/+server.ts')),
    ).toBe(true);
    const registration = readFileSync(
      join(root, 'src/lib/server/smrt-register.ts'),
      'utf8',
    );
    expect(registration).toContain('LocalWidget');
    expect(registration).not.toContain('RemoteWidget');
    expect(registration).toContain("import '../../../.smrt/register.js';");
    const gitignore = readFileSync(join(root, '.gitignore'), 'utf8');
    expect(gitignore).toContain('src/routes/api/local-widgets/+server.ts');
    expect(gitignore).toContain(
      'src/routes/external/remote-widgets/+server.ts',
    );
  });

  it.each([
    ['producer first', ['producer', 'consumer']],
    ['consumer first', ['consumer', 'producer']],
  ] as const)('retains the producer knowledge endpoint across independent route roots when %s', async (_name, order) => {
    const root = temporaryProject();
    const lifecycle = {};
    const producerOptions = routeOptions({
      knowledge: { api: { enabled: true } },
    });
    const consumerOptions = routeOptions({
      routesDir: 'src/routes/external',
    });

    for (const owner of order) {
      await contribute(
        lifecycle,
        [owner],
        root,
        owner,
        owner === 'producer'
          ? manifest(
              'LocalWidget',
              'LocalWidget',
              'local-widgets',
              '@app/local',
            )
          : manifest(
              '@acme/widgets:RemoteWidget',
              'RemoteWidget',
              'remote-widgets',
              '@acme/widgets',
            ),
        owner === 'producer' ? producerOptions : consumerOptions,
      );
    }

    expect(
      existsSync(join(root, 'src/routes/__smrt/knowledge/+server.ts')),
    ).toBe(true);
    expect(existsSync(routeFile(root, 'local-widgets'))).toBe(true);
    expect(
      existsSync(join(root, 'src/routes/external/remote-widgets/+server.ts')),
    ).toBe(true);
  });

  it.each([
    ['producer first', ['producer', 'consumer']],
    ['consumer first', ['consumer', 'producer']],
  ] as const)('retains foreign producer knowledge below an active consumer root when %s', async (_name, order) => {
    const root = temporaryProject();
    const lifecycle = {};
    for (const owner of order) {
      await contribute(
        lifecycle,
        [owner],
        root,
        owner,
        owner === 'producer'
          ? manifest(
              'LocalWidget',
              'LocalWidget',
              'local-widgets',
              '@app/local',
            )
          : manifest(
              '@acme/widgets:RemoteWidget',
              'RemoteWidget',
              'remote-widgets',
              '@acme/widgets',
            ),
        routeOptions(
          owner === 'producer'
            ? {
                knowledge: {
                  api: { enabled: true, basePath: '/external/knowledge' },
                },
              }
            : { routesDir: 'src/routes/external' },
        ),
      );
    }

    expect(
      existsSync(join(root, 'src/routes/external/knowledge/+server.ts')),
    ).toBe(true);
    expect(
      existsSync(join(root, 'src/routes/external/remote-widgets/+server.ts')),
    ).toBe(true);
  });

  it.each([
    ['producer first', ['producer', 'consumer']],
    ['consumer first', ['consumer', 'producer']],
  ] as const)('rejects a selected route that would overwrite reserved producer knowledge before consumer output when %s', async (_name, order) => {
    const root = temporaryProject();
    const lifecycle = {};
    const knowledgePath = join(
      root,
      'src/routes/external/knowledge/+server.ts',
    );
    const knowledgeConsumer = manifest(
      '@acme/widgets:Knowledge',
      'Knowledge',
      'knowledge',
      '@acme/widgets',
    );
    let producerBytes: string | undefined;

    for (const owner of order) {
      const generation = contribute(
        lifecycle,
        [owner],
        root,
        owner,
        owner === 'producer'
          ? manifest(
              'LocalWidget',
              'LocalWidget',
              'local-widgets',
              '@app/local',
            )
          : knowledgeConsumer,
        routeOptions(
          owner === 'producer'
            ? {
                knowledge: {
                  api: { enabled: true, basePath: '/external/knowledge' },
                },
              }
            : { routesDir: 'src/routes/external' },
        ),
        undefined,
        owner === 'consumer' ? new Set([knowledgePath]) : undefined,
      );
      if (owner === 'producer') {
        await generation;
        producerBytes = readFileSync(knowledgePath, 'utf8');
        continue;
      }

      await expect(generation).rejects.toThrow('Conflicting SvelteKit route');
      if (producerBytes) {
        expect(readFileSync(knowledgePath, 'utf8')).toBe(producerBytes);
      } else {
        expect(existsSync(knowledgePath)).toBe(false);
      }
      break;
    }
  });
});

const OWNERSHIP_CODE = 'SMRT_ROUTE_OWNERSHIP_CONFLICT';
const APPLICATION_HANDLER =
  "export const GET = () => new Response('application handler');\n";

/** Every path below `root` with its type and content digest. */
function treeInventory(root: string): Record<string, string> {
  const entries: Record<string, string> = {};
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stats = lstatSync(path);
      const key = relative(root, path);
      if (stats.isSymbolicLink()) entries[key] = `link:${readlinkSync(path)}`;
      else if (stats.isDirectory()) {
        entries[key] = 'dir';
        walk(path);
      } else {
        entries[key] = createHash('sha256')
          .update(readFileSync(path))
          .digest('hex');
      }
    }
  };
  walk(root);
  return entries;
}

describe('coordinated generation never replaces an application route file', () => {
  const local = () =>
    manifest('LocalWidget', 'LocalWidget', 'local-widgets', '@app/local');
  const remote = () =>
    manifest(
      '@acme/widgets:RemoteWidget',
      'RemoteWidget',
      'remote-widgets',
      '@acme/widgets',
    );

  it('coordinated producer and consumer generation enforces ownership', async () => {
    const root = temporaryProject();
    const first = {};
    await contribute(
      first,
      ['producer', 'consumer'],
      root,
      'producer',
      local(),
    );
    await contribute(
      first,
      ['producer', 'consumer'],
      root,
      'consumer',
      remote(),
    );
    const producerFile = routeFile(root, 'local-widgets');
    const consumerFile = join(
      root,
      'src/routes/api/remote-widgets/[id]/+server.ts',
    );
    writeFileSync(producerFile, APPLICATION_HANDLER);
    writeFileSync(consumerFile, APPLICATION_HANDLER);
    const before = treeInventory(root);

    const next = {};
    await contribute(next, ['producer', 'consumer'], root, 'producer', local());
    const refusal = await contribute(
      next,
      ['producer', 'consumer'],
      root,
      'consumer',
      remote(),
    ).then(
      () => undefined,
      (error: unknown) => error as Error & { files: string[] },
    );

    expect(refusal).toMatchObject({ code: OWNERSHIP_CODE, phase: 'preflight' });
    expect(refusal?.files).toEqual(
      expect.arrayContaining([producerFile, consumerFile]),
    );
    expect(treeInventory(root)).toEqual(before);
  });

  it('a refused generation leaves its outputs untouched and runs no hooks', async () => {
    const root = temporaryProject();
    const beforeCleanup = vi.fn();
    const afterGenerate = vi.fn();
    const contribution = () => ({
      owner: 'producer' as const,
      routeManifest: local(),
      semanticManifest: local(),
      options: routeOptions(),
      beforeCleanup,
      afterGenerate,
    });
    await contributeSvelteKitRoutes({}, ['producer'], root, contribution());
    expect(beforeCleanup).toHaveBeenCalledTimes(1);
    expect(afterGenerate).toHaveBeenCalledTimes(1);
    beforeCleanup.mockClear();
    afterGenerate.mockClear();
    const file = join(root, 'src/routes/api/local-widgets/[id]/+server.ts');
    writeFileSync(file, APPLICATION_HANDLER);
    const before = treeInventory(root);

    await expect(
      contributeSvelteKitRoutes({}, ['producer'], root, contribution()),
    ).rejects.toMatchObject({
      code: OWNERSHIP_CODE,
      phase: 'preflight',
      files: [file],
    });

    expect(beforeCleanup).not.toHaveBeenCalled();
    expect(afterGenerate).not.toHaveBeenCalled();
    expect(treeInventory(root)).toEqual(before);
  });

  it('a foreign producer’s protected route is never swept or written, and planning a write to it throws', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    const knowledgePath = join(
      root,
      'src/routes/external/knowledge/+server.ts',
    );
    await contribute(
      lifecycle,
      ['producer'],
      root,
      'producer',
      local(),
      routeOptions({
        knowledge: { api: { enabled: true, basePath: '/external/knowledge' } },
      }),
    );
    const producerBytes = readFileSync(knowledgePath, 'utf8');

    // Untouched: a consumer root that contains the protected path does not
    // sweep it.
    await contribute(
      lifecycle,
      ['consumer'],
      root,
      'consumer',
      remote(),
      routeOptions({ routesDir: 'src/routes/external' }),
    );
    expect(readFileSync(knowledgePath, 'utf8')).toBe(producerBytes);

    // Planned: a consumer route at the protected path throws before writing,
    // even without the collision claim pass.
    await expect(
      contribute(
        lifecycle,
        ['consumer'],
        root,
        'consumer',
        manifest(
          '@acme/widgets:Knowledge',
          'Knowledge',
          'knowledge',
          '@acme/widgets',
        ),
        routeOptions({
          routesDir: 'src/routes/external',
          rejectRouteCollisions: false,
        }),
      ),
    ).rejects.toThrow('Conflicting SvelteKit route');
    expect(readFileSync(knowledgePath, 'utf8')).toBe(producerBytes);
  });

  it('a foreign producer’s protected knowledge route is never removed by a producer with knowledge disabled', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    const knowledgePath = join(root, 'src/routes/__smrt/knowledge/+server.ts');
    await contribute(
      lifecycle,
      ['producer'],
      root,
      'producer',
      local(),
      routeOptions({ knowledge: { api: { enabled: true } } }),
    );
    const producerBytes = readFileSync(knowledgePath, 'utf8');

    await contribute(
      lifecycle,
      ['producer'],
      root,
      'producer',
      manifest('OtherWidget', 'OtherWidget', 'other-widgets', '@app/other'),
      routeOptions({
        routesDir: 'src/routes/other',
        knowledge: { api: { enabled: false } },
      }),
    );

    expect(
      existsSync(join(root, 'src/routes/other/other-widgets/+server.ts')),
    ).toBe(true);
    expect(readFileSync(knowledgePath, 'utf8')).toBe(producerBytes);
  });

  it.each([
    ['with an application handler in the former root', true],
    ['without an application handler (both roots reconcile)', false],
  ])('a nested generation refusal after a successful outer commit fails the build and leaves the outer root changed (%s)', async (_label, withHandler) => {
    const root = temporaryProject();
    const lifecycle = {};
    const oldOptions = routeOptions({ routesDir: 'src/routes/api-old' });
    // 1. The producer's contribution into the former root succeeds.
    await contribute(
      lifecycle,
      ['producer'],
      root,
      'producer',
      local(),
      oldOptions,
    );
    const oldRoot = join(root, 'src/routes/api-old');
    const handler = join(oldRoot, 'local-widgets/+server.ts');
    const newRoute = join(root, 'src/routes/api-new/remote-widgets/+server.ts');
    expect(existsSync(newRoute)).toBe(false);
    // 2. Between invocations, a hand-written handler takes a planned path.
    if (withHandler) writeFileSync(handler, APPLICATION_HANDLER);
    const oldBefore = treeInventory(oldRoot);

    // 3. The hosted consumer moves to a new root; afterGenerate reconciles
    // the former root through the real revocation call.
    const run = contributeSvelteKitRoutes(lifecycle, ['consumer'], root, {
      owner: 'consumer',
      routeManifest: remote(),
      semanticManifest: remote(),
      options: routeOptions({ routesDir: 'src/routes/api-new' }),
      afterGenerate: () =>
        revokeSvelteKitRoutes(
          lifecycle,
          ['producer'],
          root,
          'src/routes/api-old',
        ),
    });

    if (withHandler) {
      await expect(run).rejects.toMatchObject({
        code: OWNERSHIP_CODE,
        phase: 'preflight',
        files: [handler],
      });
      expect(treeInventory(oldRoot)).toEqual(oldBefore);
      expect(readFileSync(handler, 'utf8')).toBe(APPLICATION_HANDLER);
    } else {
      await expect(run).resolves.toBe('accepted');
      expect(readFileSync(handler, 'utf8')).toContain(
        'Auto-generated by @smrt/core vite plugin',
      );
    }
    // The outer invocation already committed the new root.
    expect(existsSync(newRoute)).toBe(true);
  });
});

/** Fails loudly instead of hanging when an ordering guarantee breaks. */
function withinTimeout<T>(
  promise: Promise<T>,
  label: string,
  ms = 15_000,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms),
    ),
  ]);
}

/** A one-shot pause at a named coordinator point, for runs matching `when`. */
function pauseAt(
  point: SvelteKitCoordinatorPausePoint,
  when: (info: {
    owners: SvelteKitRouteOwner[];
    projectRoot: string;
  }) => boolean = () => true,
) {
  let reached!: () => void;
  let release!: () => void;
  const reachedPromise = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let used = false;
  const seen: Array<{ point: string; root: string }> = [];
  setSvelteKitCoordinatorPauseHookForTesting(async (current, info) => {
    seen.push({ point: current, root: info.projectRoot });
    if (current !== point || used || !when(info)) return;
    used = true;
    reached();
    await released;
  });
  return { reached: reachedPromise, release, seen };
}

describe('staged publication through the coordinator (#5462)', () => {
  const local = (collection = 'local-widgets', className = 'LocalWidget') =>
    manifest(className, className, collection, '@app/local');
  const remote = () =>
    manifest(
      '@acme/widgets:RemoteWidget',
      'RemoteWidget',
      'remote-widgets',
      '@acme/widgets',
    );

  afterEach(() => {
    // Optional calls: the regression run executes this file against a build
    // without these seams, where only the tests that use them may fail.
    setSvelteKitCoordinatorPauseHookForTesting?.(undefined);
    setRouteFileSystemForTesting?.(undefined);
    setArtifactFilesystemForTesting?.(undefined);
    vi.restoreAllMocks();
  });

  function producer(
    routeManifest: SmartObjectManifest,
    seq: number,
    settle: (outcome: SvelteKitSubmissionOutcome) => void | Promise<void>,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      owner: 'producer' as const,
      routeManifest,
      semanticManifest: routeManifest,
      options: routeOptions(),
      seq,
      settle,
      ...overrides,
    };
  }

  it('a coordinator pre-check refusal reverts the producer submission', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    const outcomes: string[] = [];
    await contributeSvelteKitRoutes(
      lifecycle,
      ['producer', 'consumer'],
      root,
      producer(local(), 1, (outcome) => {
        outcomes.push(`1:${outcome}`);
      }),
    );
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'consumer',
      remote(),
    );
    expect(outcomes).toEqual(['1:accepted']);
    const before = treeInventory(root);

    // The producer resubmits with a lazyActivation setting the consumer does
    // not share: refused before any output changes.
    await expect(
      contributeSvelteKitRoutes(
        lifecycle,
        ['producer', 'consumer'],
        root,
        producer(
          local('next-widgets', 'NextWidget'),
          2,
          (outcome) => {
            outcomes.push(`2:${outcome}`);
          },
          { options: routeOptions({ lazyActivation: true }) },
        ),
      ),
    ).rejects.toThrow('must agree on lazyActivation');
    expect(outcomes).toEqual(['1:accepted', '2:rejected']);
    expect(treeInventory(root)).toEqual(before);

    // The next consumer contribution generates from the accepted producer
    // manifest, not the refused one.
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'consumer',
      remote(),
    );
    expect(existsSync(routeFile(root, 'local-widgets'))).toBe(true);
    expect(existsSync(routeFile(root, 'next-widgets'))).toBe(false);
  });

  it('a nested refusal after an outer commit still publishes the outer result', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    await contribute(
      lifecycle,
      ['producer'],
      root,
      'producer',
      local(),
      routeOptions({ routesDir: 'src/routes/api-old' }),
    );
    writeFileSync(
      join(root, 'src/routes/api-old/local-widgets/+server.ts'),
      APPLICATION_HANDLER,
    );
    const outcomes: string[] = [];
    let lockFreeDuringReconciliation = false;
    const run = contributeSvelteKitRoutes(lifecycle, ['consumer'], root, {
      owner: 'consumer',
      routeManifest: remote(),
      semanticManifest: remote(),
      options: routeOptions({ routesDir: 'src/routes/api-new' }),
      settle: (outcome: SvelteKitSubmissionOutcome) => {
        outcomes.push(outcome);
      },
      afterGenerate: async () => {
        // Reconciliation runs only after the outer run released the lock.
        const release = await withinTimeout(
          svelteKitLifecycleLock(lifecycle).acquire(),
          'lifecycle lock during afterGenerate',
          3_000,
        );
        release();
        lockFreeDuringReconciliation = true;
        await revokeSvelteKitRoutes(
          lifecycle,
          ['producer'],
          root,
          'src/routes/api-old',
        );
      },
    });
    await expect(run).rejects.toMatchObject({ code: OWNERSHIP_CODE });
    expect(lockFreeDuringReconciliation).toBe(true);
    expect(outcomes).toEqual(['accepted']);
    expect(
      existsSync(join(root, 'src/routes/api-new/remote-widgets/+server.ts')),
    ).toBe(true);
  });

  it('a beforeCleanup failure before any output mutation publishes nothing', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    const outcomes: string[] = [];
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'consumer',
      remote(),
    );
    const before = treeInventory(root);
    await expect(
      contributeSvelteKitRoutes(lifecycle, ['producer', 'consumer'], root, {
        ...producer(local(), 1, (outcome) => {
          outcomes.push(outcome);
        }),
        beforeCleanup: () => {
          throw new Error('beforeCleanup failed before writing');
        },
      }),
    ).rejects.toThrow('beforeCleanup failed before writing');
    expect(outcomes).toEqual(['rejected']);
    expect(treeInventory(root)).toEqual(before);
  });

  it('a failure after the first route unlink publishes', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    const outcomes: string[] = [];
    await contributeSvelteKitRoutes(
      lifecycle,
      ['producer'],
      root,
      producer(local(), 1, (outcome) => {
        outcomes.push(`1:${outcome}`);
      }),
    );
    // The first sweep unlink succeeds; the second fails.
    let unlinks = 0;
    setRouteFileSystemForTesting({
      ...nodeRouteFileSystem,
      unlinkSync: (path) => {
        if (++unlinks === 2) throw new Error('failure after the first unlink');
        nodeRouteFileSystem.unlinkSync(path);
      },
    });
    await expect(
      contributeSvelteKitRoutes(
        lifecycle,
        ['producer'],
        root,
        producer(local('next-widgets', 'NextWidget'), 2, (outcome) => {
          outcomes.push(`2:${outcome}`);
        }),
      ),
    ).rejects.toThrow('failure after the first unlink');
    expect(unlinks).toBe(2);
    expect(outcomes).toEqual(['1:accepted', '2:accepted']);
  });

  it('a partial commit on a hosting move keeps the former root and journal', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    await contribute(
      lifecycle,
      ['consumer'],
      root,
      'consumer',
      remote(),
      routeOptions({ routesDir: 'src/routes/api-old' }),
    );
    const journal = join(root, '.smrt', 'consumer-sveltekit-routes.json');
    mkdirSync(join(root, '.smrt'), { recursive: true });
    writeFileSync(
      journal,
      JSON.stringify({ version: 1, routesDir: ['src/routes/api-old'] }),
    );
    const oldBefore = treeInventory(join(root, 'src/routes/api-old'));
    const journalBefore = readFileSync(journal, 'utf8');
    let writes = 0;
    setRouteFileSystemForTesting({
      ...nodeRouteFileSystem,
      openSync: (path, flag) => {
        if (
          path.includes('api-new') &&
          path.endsWith('+server.ts') &&
          ++writes === 2
        ) {
          throw Object.assign(new Error('EACCES: injected'), {
            code: 'EACCES',
          });
        }
        return nodeRouteFileSystem.openSync(path, flag);
      },
    });
    const afterGenerate = vi.fn();
    await expect(
      contributeSvelteKitRoutes(lifecycle, ['consumer'], root, {
        owner: 'consumer',
        routeManifest: remote(),
        semanticManifest: remote(),
        options: routeOptions({ routesDir: 'src/routes/api-new' }),
        afterGenerate,
      }),
    ).rejects.toThrow('EACCES: injected');
    expect(afterGenerate).not.toHaveBeenCalled();
    expect(treeInventory(join(root, 'src/routes/api-old'))).toEqual(oldBefore);
    expect(readFileSync(journal, 'utf8')).toBe(journalBefore);
  });

  it('a throwing settle never hides the generation error', async () => {
    const root = temporaryProject();
    const file = join(root, 'src/routes/api/local-widgets/+server.ts');
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, APPLICATION_HANDLER);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(
      contributeSvelteKitRoutes(
        {},
        ['producer'],
        root,
        producer(local(), 1, () => {
          throw new Error('settle failed');
        }),
      ),
    ).rejects.toMatchObject({ code: OWNERSHIP_CODE });
    expect(
      errors.mock.calls.some(([, error]) =>
        String((error as Error)?.message).includes('settle failed'),
      ),
    ).toBe(true);
  });

  it('a queued replacement survives the refusal of the run it waited for', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    const blocked = join(root, 'src/routes/api/blocked-widgets/+server.ts');
    mkdirSync(join(blocked, '..'), { recursive: true });
    writeFileSync(blocked, APPLICATION_HANDLER);
    const pause = pauseAt('beforeMark');
    const outcomes: string[] = [];
    const first = contributeSvelteKitRoutes(
      lifecycle,
      ['producer'],
      root,
      producer(local('blocked-widgets', 'BlockedWidget'), 1, (outcome) => {
        outcomes.push(`A:${outcome}`);
      }),
    ).catch((error: unknown) => error);
    await withinTimeout(pause.reached, 'run A paused');
    const second = contributeSvelteKitRoutes(
      lifecycle,
      ['producer'],
      root,
      producer(local('free-widgets', 'FreeWidget'), 2, (outcome) => {
        outcomes.push(`B:${outcome}`);
      }),
    );
    pause.release();
    expect(await withinTimeout(first, 'run A settles')).toMatchObject({
      code: OWNERSHIP_CODE,
    });
    expect(await withinTimeout(second, 'run B settles')).toBe('accepted');
    expect(outcomes).toEqual(['A:rejected', 'B:accepted']);
    expect(existsSync(routeFile(root, 'free-widgets'))).toBe(true);
  });

  it('a stale producer submission is rejected before any hook', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    const outcomes: string[] = [];
    await contributeSvelteKitRoutes(
      lifecycle,
      ['producer'],
      root,
      producer(local(), 2, (outcome) => {
        outcomes.push(`2:${outcome}`);
      }),
    );
    const before = treeInventory(root);
    let mutations = 0;
    setRouteFileSystemForTesting({
      ...nodeRouteFileSystem,
      unlinkSync: (path) => {
        mutations++;
        nodeRouteFileSystem.unlinkSync(path);
      },
      openSync: (path, flag) => {
        mutations++;
        return nodeRouteFileSystem.openSync(path, flag);
      },
    });
    const beforeCleanup = vi.fn();
    const result = await contributeSvelteKitRoutes(
      lifecycle,
      ['producer'],
      root,
      {
        ...producer(local('older-widgets', 'OlderWidget'), 1, (outcome) => {
          outcomes.push(`1:${outcome}`);
        }),
        beforeCleanup,
      },
    );
    expect(result).toBe('superseded');
    expect(outcomes).toEqual(['2:accepted', '1:superseded']);
    expect(beforeCleanup).not.toHaveBeenCalled();
    expect(mutations).toBe(0);
    expect(treeInventory(root)).toEqual(before);
  });

  it('a submission whose producer published a newer result is rejected at admission', async () => {
    const root = temporaryProject();
    const beforeCleanup = vi.fn();
    const result = await contributeSvelteKitRoutes({}, ['producer'], root, {
      ...producer(local(), 3, () => {}),
      isStale: () => true,
      beforeCleanup,
    });
    expect(result).toBe('superseded');
    expect(beforeCleanup).not.toHaveBeenCalled();
    expect(existsSync(join(root, 'src/routes'))).toBe(false);
  });

  it('serialised targets keep each other’s accepted registrations', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    const targetA = routeOptions({ routesDir: 'src/routes/api-a' });
    const targetB = routeOptions({ routesDir: 'src/routes/api-b' });
    const pause = pauseAt(
      'afterRegistrationInputs',
      ({ projectRoot }) => projectRoot === root,
    );
    const first = contributeSvelteKitRoutes(lifecycle, ['producer'], root, {
      ...producer(
        manifest(
          '@acme/a:AlphaWidget',
          'AlphaWidget',
          'alpha-widgets',
          '@acme/a',
        ),
        1,
        () => {},
      ),
      options: targetA,
    });
    await withinTimeout(pause.reached, 'target A paused');
    const second = contributeSvelteKitRoutes(lifecycle, ['producer'], root, {
      ...producer(
        manifest(
          '@acme/b:BravoWidget',
          'BravoWidget',
          'bravo-widgets',
          '@acme/b',
        ),
        1,
        () => {},
      ),
      options: targetB,
    });
    // B waits at the lock: it has not selected its registration inputs.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      pause.seen.filter(({ point }) => point === 'afterRegistrationInputs'),
    ).toHaveLength(1);
    pause.release();
    await withinTimeout(Promise.all([first, second]), 'both targets settle');
    const registration = readFileSync(
      join(root, 'src/lib/server/smrt-register.ts'),
      'utf8',
    );
    expect(registration).toContain('AlphaWidget');
    expect(registration).toContain('BravoWidget');
  });

  it('a registration write before a failed first route create counts as a change', async () => {
    const root = temporaryProject();
    const outcomes: string[] = [];
    setRouteFileSystemForTesting({
      ...nodeRouteFileSystem,
      openSync: (path, flag) => {
        if (path.endsWith('+server.ts')) {
          throw Object.assign(new Error('EACCES: first route create'), {
            code: 'EACCES',
          });
        }
        return nodeRouteFileSystem.openSync(path, flag);
      },
    });
    await expect(
      contributeSvelteKitRoutes(
        {},
        ['producer'],
        root,
        producer(local(), 1, (outcome) => {
          outcomes.push(outcome);
        }),
      ),
    ).rejects.toThrow('EACCES: first route create');
    expect(outcomes).toEqual(['accepted']);
    expect(
      readFileSync(join(root, 'src/lib/server/smrt-register.ts'), 'utf8'),
    ).toContain('LocalWidget');
  });

  it('a create that fails while writing counts as a change', async () => {
    const root = temporaryProject();
    const outcomes: string[] = [];
    let failed: string | undefined;
    setRouteFileSystemForTesting({
      ...nodeRouteFileSystem,
      writeSync: (descriptor, content) => {
        if (!failed && content.startsWith('// Auto-generated')) {
          failed = 'route';
          throw Object.assign(new Error('ENOSPC: no space left'), {
            code: 'ENOSPC',
          });
        }
        nodeRouteFileSystem.writeSync(descriptor, content);
      },
    });
    const error = await contributeSvelteKitRoutes(
      {},
      ['producer'],
      root,
      producer(local(), 1, (outcome) => {
        outcomes.push(outcome);
      }),
    ).then(
      () => undefined,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toMatch(/\+server\.ts failed after it was opened/);
    expect(outcomes).toEqual(['accepted']);
  });

  it('a pending target’s knowledge route is protected from other sweeps', async () => {
    const root = temporaryProject();
    const knowledge = join(root, 'src/routes/__smrt/knowledge/+server.ts');
    const withKnowledge = routeOptions({
      knowledge: { api: { enabled: true } },
    });
    await contribute(
      {},
      ['producer'],
      root,
      'producer',
      local(),
      withKnowledge,
    );
    expect(existsSync(knowledge)).toBe(true);
    const lifecycle = {};
    // Target A contributes and waits for a peer that has not run yet.
    await expect(
      contributeSvelteKitRoutes(lifecycle, ['producer', 'consumer'], root, {
        ...producer(local(), 1, () => {}),
        options: withKnowledge,
      }),
    ).resolves.toBe('pending');
    // Target B (knowledge configured but disabled) runs its own sweep.
    const other = temporaryProject();
    await contribute(
      lifecycle,
      ['producer'],
      other === root ? root : root,
      'producer',
      manifest(
        '@acme/o:OtherWidget',
        'OtherWidget',
        'other-widgets',
        '@acme/o',
      ),
      routeOptions({
        routesDir: 'src/routes/other',
        knowledge: { api: { enabled: false } },
      }),
    );
    expect(existsSync(knowledge)).toBe(true);
    // The consumer's direct sweep spares it too.
    clearGeneratedSvelteKitRouteFiles(
      join(root, 'src/routes'),
      producerKnowledgeRoutePaths(lifecycle),
    );
    expect(existsSync(knowledge)).toBe(true);
  });

  it('the lock is released on every exit', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'consumer',
      remote(),
    );
    await contributeSvelteKitRoutes(
      lifecycle,
      ['producer', 'consumer'],
      root,
      producer(local(), 1, () => {}),
    );
    // A pre-check throw.
    await expect(
      contributeSvelteKitRoutes(lifecycle, ['producer', 'consumer'], root, {
        ...producer(local(), 2, () => {}),
        options: routeOptions({ lazyActivation: true }),
      }),
    ).rejects.toThrow('must agree on lazyActivation');
    // A throwing settle on an accepted run.
    await withinTimeout(
      contributeSvelteKitRoutes(
        lifecycle,
        ['producer', 'consumer'],
        root,
        producer(local(), 3, () => {
          throw new Error('settle failed');
        }),
      ),
      'run after a pre-check throw',
    );
    expect(errors).toHaveBeenCalled();
    // An early return: a target whose peer is missing.
    await expect(
      contributeSvelteKitRoutes(lifecycle, ['producer', 'consumer'], root, {
        ...producer(local(), 1, () => {}),
        options: routeOptions({ routesDir: 'src/routes/waiting' }),
      }),
    ).resolves.toBe('pending');
    // Each exit released the lock: a following run completes.
    const outcomes: string[] = [];
    await withinTimeout(
      contributeSvelteKitRoutes(
        lifecycle,
        ['producer', 'consumer'],
        root,
        producer(local(), 4, (outcome) => {
          outcomes.push(outcome);
        }),
      ),
      'run after settle throw and early return',
    );
    expect(outcomes).toEqual(['accepted']);
    // A nested afterGenerate error after acceptance: the outcome stays accepted.
    const nested: string[] = [];
    await expect(
      contributeSvelteKitRoutes(lifecycle, ['producer', 'consumer'], root, {
        ...producer(local(), 5, (outcome) => {
          nested.push(outcome);
        }),
        afterGenerate: () => {
          throw new Error('nested reconciliation failed');
        },
      }),
    ).rejects.toThrow('nested reconciliation failed');
    expect(nested).toEqual(['accepted']);
    const release = await withinTimeout(
      svelteKitLifecycleLock(lifecycle).acquire(),
      'lock after a nested error',
    );
    release();
  });

  it('consumer registration writes count as changes and run under the lock', async () => {
    const root = temporaryProject();
    const outcomes: string[] = [];
    const activation = join(root, '.smrt', 'activation-manifest.json');
    mkdirSync(join(root, '.smrt'), { recursive: true });
    await expect(
      contributeSvelteKitRoutes({}, ['producer', 'consumer'], root, {
        ...producer(local(), 1, (outcome) => {
          outcomes.push(outcome);
        }),
      }),
    ).resolves.toBe('pending');
    const lifecycle = {};
    await contributeSvelteKitRoutes(lifecycle, ['producer', 'consumer'], root, {
      ...producer(local(), 1, (outcome) => {
        outcomes.push(outcome);
      }),
    });
    await expect(
      contributeSvelteKitRoutes(lifecycle, ['producer', 'consumer'], root, {
        owner: 'consumer',
        routeManifest: remote(),
        semanticManifest: remote(),
        options: routeOptions(),
        // The consumer replaces its activation bytes, then its journal write
        // fails: the replacement already counts.
        beforeCleanup: (mark: () => void) => {
          publishArtifactFiles(
            [{ path: activation, content: '{"replaced":true}' }],
            undefined,
            mark,
          );
          throw new Error('journal write failed');
        },
      }),
    ).rejects.toThrow('journal write failed');
    expect(outcomes).toEqual(['accepted']);
    expect(readFileSync(activation, 'utf8')).toBe('{"replaced":true}');
  });

  it('consumer submissions and revocations are exempt from the sequence rule', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    await contribute(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'consumer',
      remote(),
    );
    await contributeSvelteKitRoutes(
      lifecycle,
      ['producer', 'consumer'],
      root,
      producer(local(), 5, () => {}),
    );
    const consumerCleanup = vi.fn();
    await expect(
      contributeSvelteKitRoutes(lifecycle, ['producer', 'consumer'], root, {
        owner: 'consumer',
        routeManifest: remote(),
        semanticManifest: remote(),
        options: routeOptions(),
        beforeCleanup: consumerCleanup,
      }),
    ).resolves.toBe('accepted');
    expect(consumerCleanup).toHaveBeenCalledTimes(1);
    const revoked = vi.fn();
    await revokeSvelteKitRoutes(
      lifecycle,
      ['producer', 'consumer'],
      root,
      'src/routes/api',
      revoked,
    );
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(consumerCleanup).toHaveBeenCalledTimes(2);
  });
});

describe('per-root knowledge modules in one Vite lifecycle (#5462)', () => {
  it('each producer’s knowledge endpoint serves its own root', async () => {
    const { createServer } = await import('vite');
    const { smrtPlugin } = await import('./index.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const roots = { a: temporaryProject(), b: temporaryProject() };
    for (const [name, root] of Object.entries(roots)) {
      mkdirSync(join(root, 'src/lib/objects'), { recursive: true });
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: `@fixture/knowledge-${name}`, type: 'module' }),
      );
      writeFileSync(
        join(root, 'smrt.config.json'),
        JSON.stringify({
          knowledge: { summary: `marker-${name}`, api: { enabled: true } },
        }),
      );
      writeFileSync(
        join(root, 'src/lib/objects', `${name.toUpperCase()}Note.ts`),
        `import { SmrtObject, smrt } from '@happyvertical/smrt-core';\n@smrt()\nexport class ${name.toUpperCase()}Note extends SmrtObject {}\n`,
      );
    }
    const producer = (root: string) =>
      smrtPlugin({
        projectRoot: root,
        include: ['src/**/*.ts'],
        generateTypes: false,
        svelteKit: {
          enabled: true,
          routesDir: 'src/routes/api',
          objectsDir: 'src/lib/objects',
          changesRoute: { enabled: false },
          eventsRoute: { enabled: false },
          resourcesRoute: { enabled: false },
        },
      });
    const server = await createServer({
      root: roots.a,
      configFile: false,
      logLevel: 'silent',
      appType: 'custom',
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { middlewareMode: true, watch: null },
      plugins: [producer(roots.a), producer(roots.b)],
    });
    try {
      const moduleIdOf = (root: string) => {
        const id = /from "(smrt:knowledge-artifact\/[0-9a-f]+)"/.exec(
          readFileSync(
            join(root, 'src/routes/__smrt/knowledge/+server.ts'),
            'utf8',
          ),
        )?.[1];
        if (!id) throw new Error(`no knowledge module import under ${root}`);
        return id;
      };
      const served = async (root: string) =>
        (
          (await server.ssrLoadModule(moduleIdOf(root))) as {
            default: { summary?: string } | null;
          }
        ).default?.summary;
      expect(moduleIdOf(roots.a)).not.toBe(moduleIdOf(roots.b));
      expect(await served(roots.a)).toBe('marker-a');
      expect(await served(roots.b)).toBe('marker-b');

      // One artifact changes: only that endpoint changes.
      const artifactB = join(roots.b, '.smrt/smrt-knowledge.json');
      writeFileSync(
        artifactB,
        JSON.stringify({
          ...JSON.parse(readFileSync(artifactB, 'utf8')),
          summary: 'marker-b-changed',
        }),
      );
      const environment = server.environments.ssr;
      for (const root of [roots.a, roots.b]) {
        const module = environment.moduleGraph.getModuleById(
          `\0${moduleIdOf(root)}`,
        );
        if (module) environment.moduleGraph.invalidateModule(module);
      }
      expect(await served(roots.a)).toBe('marker-a');
      expect(await served(roots.b)).toBe('marker-b-changed');
    } finally {
      await server.close();
    }
  }, 120_000);
});

describe('a hosting move whose new root commits partially (#5462)', () => {
  afterEach(() => {
    setRouteFileSystemForTesting?.(undefined);
    vi.restoreAllMocks();
  });

  it('a partial commit on a hosting move keeps the former root and its journal entry (smrtConsumer)', async () => {
    const { smrtConsumer } = await import('../consumer-plugin/index.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const root = temporaryProject();
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: '@test/hosting-move', type: 'module' }),
    );
    const provider = join(root, 'node_modules', '@acme', 'widgets');
    mkdirSync(join(provider, 'dist'), { recursive: true });
    writeFileSync(
      join(provider, 'package.json'),
      JSON.stringify({
        name: '@acme/widgets',
        version: '1.0.0',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(join(provider, 'dist/index.js'), 'export class Widget {}\n');
    writeFileSync(
      join(provider, 'dist/manifest.json'),
      JSON.stringify({
        packageName: '@acme/widgets',
        objects: {
          '@acme/widgets:Widget': {
            className: 'Widget',
            qualifiedName: '@acme/widgets:Widget',
            collection: 'widgets',
            fields: {},
            methods: {},
            decoratorConfig: { api: { include: ['list', 'get'] } },
          },
        },
      }),
    );
    const host = async (routesDir: string) => {
      const plugin = smrtConsumer({
        projectRoot: root,
        packages: ['@acme/widgets'],
        disableScanning: true,
        generateTypes: false,
        svelteKit: {
          objects: ['@acme/widgets:Widget'],
          routesDir,
          changesRoute: { enabled: false },
          eventsRoute: { enabled: false },
          resourcesRoute: { enabled: false },
        },
      }) as unknown as { config: unknown };
      const hook = plugin.config as
        | ((...args: unknown[]) => unknown)
        | { handler: (...args: unknown[]) => unknown };
      const handler = typeof hook === 'function' ? hook : hook.handler;
      await handler.call(
        plugin,
        { root, plugins: [plugin] },
        { command: 'build', mode: 'production' },
      );
    };
    const journal = join(root, '.smrt', 'consumer-sveltekit-routes.json');
    await host('src/routes/hosted-old');
    const oldRoot = join(root, 'src/routes/hosted-old');
    const oldBefore = treeInventory(oldRoot);
    expect(
      Object.keys(oldBefore).some((path) => path.endsWith('+server.ts')),
    ).toBe(true);
    expect(JSON.parse(readFileSync(journal, 'utf8')).routesDir).toEqual([
      'src/routes/hosted-old',
    ]);

    // The move's commit writes its first route file, then fails.
    let created = 0;
    setRouteFileSystemForTesting({
      ...nodeRouteFileSystem,
      openSync: (path, flag) => {
        if (path.includes('hosted-new') && path.endsWith('+server.ts')) {
          if (++created === 2) {
            throw Object.assign(new Error('EACCES: injected second create'), {
              code: 'EACCES',
            });
          }
        }
        return nodeRouteFileSystem.openSync(path, flag);
      },
    });
    await expect(host('src/routes/hosted-new')).rejects.toThrow(
      'EACCES: injected second create',
    );
    expect(created).toBe(2);

    // Reconciliation did not run: the former root is untouched and the
    // journal still owns it beside the partially written new root.
    expect(treeInventory(oldRoot)).toEqual(oldBefore);
    expect(JSON.parse(readFileSync(journal, 'utf8')).routesDir).toEqual([
      'src/routes/hosted-new',
      'src/routes/hosted-old',
    ]);
  }, 60_000);
});

describe('code review round 2 (#5462)', () => {
  const local = (collection = 'local-widgets', className = 'LocalWidget') =>
    manifest(className, className, collection, '@app/local');
  const remote = () =>
    manifest(
      '@acme/widgets:RemoteWidget',
      'RemoteWidget',
      'remote-widgets',
      '@acme/widgets',
    );

  afterEach(() => {
    setSvelteKitCoordinatorPauseHookForTesting?.(undefined);
    setRouteFileSystemForTesting?.(undefined);
    vi.restoreAllMocks();
  });

  it('a pending producer overtaken by a newer publication never generates', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    let newerPublished = false;
    const outcomes: string[] = [];
    // The producer waits for its consumer...
    await expect(
      contributeSvelteKitRoutes(lifecycle, ['producer', 'consumer'], root, {
        owner: 'producer',
        routeManifest: local('stale-widgets', 'StaleWidget'),
        semanticManifest: local('stale-widgets', 'StaleWidget'),
        options: routeOptions(),
        seq: 1,
        isStale: () => newerPublished,
        settle: (outcome: SvelteKitSubmissionOutcome) => {
          outcomes.push(outcome);
        },
      }),
    ).resolves.toBe('pending');
    // ...while the producer publishes a newer prepared result (load()).
    newerPublished = true;
    const result = await contributeSvelteKitRoutes(
      lifecycle,
      ['producer', 'consumer'],
      root,
      {
        owner: 'consumer',
        routeManifest: remote(),
        semanticManifest: remote(),
        options: routeOptions(),
      },
    );
    expect(outcomes).toEqual(['superseded']);
    expect(result).toBe('pending');
    expect(existsSync(routeFile(root, 'stale-widgets'))).toBe(false);
    expect(existsSync(join(root, 'src/lib/server/smrt-register.ts'))).toBe(
      false,
    );
  });

  it('a failed build-schema fallback fails the run and runs no reconciliation', async () => {
    const root = temporaryProject();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    setRouteFileSystemForTesting({
      ...nodeRouteFileSystem,
      openSync: (path, flag) => {
        if (path.endsWith('build-schema.js')) {
          throw Object.assign(new Error('EACCES: build-schema write denied'), {
            code: 'EACCES',
          });
        }
        return nodeRouteFileSystem.openSync(path, flag);
      },
    });
    const afterGenerate = vi.fn();
    // The settle publishes nothing (its manifest write failed), so the
    // coordinator's fallback is the only writer left, and it fails too.
    await expect(
      contributeSvelteKitRoutes({}, ['producer'], root, {
        owner: 'producer',
        routeManifest: local(),
        semanticManifest: local(),
        options: routeOptions(),
        seq: 1,
        settle: () => {},
        publishesBuildSchemaFor: canonicalSvelteKitPath(root),
        afterGenerate,
      }),
    ).rejects.toThrow('EACCES: build-schema write denied');
    expect(afterGenerate).not.toHaveBeenCalled();
    expect(existsSync(join(root, '.smrt/build-schema.js'))).toBe(false);
    expect(errors).not.toHaveBeenCalledWith(
      '[smrt] Error writing the build-schema module:',
      expect.anything(),
    );
  });

  it('a queued revocation’s callback runs only after its own generation', async () => {
    const root = temporaryProject();
    const lifecycle = {};
    await contributeSvelteKitRoutes(lifecycle, ['producer'], root, {
      owner: 'producer',
      routeManifest: local(),
      semanticManifest: local(),
      options: routeOptions(),
      seq: 1,
      settle: () => {},
    });
    const pause = pauseAt('beforeSettle');
    const first = contributeSvelteKitRoutes(lifecycle, ['producer'], root, {
      owner: 'producer',
      routeManifest: local(),
      semanticManifest: local(),
      options: routeOptions(),
      seq: 2,
      settle: () => {},
    });
    await withinTimeout(pause.reached, 'first holder paused');
    const revoked = vi.fn();
    const revocation = revokeSvelteKitRoutes(
      lifecycle,
      ['producer'],
      root,
      'src/routes/api',
      revoked,
    ).catch((error: unknown) => error);
    // The revocation's own generation will refuse: an application handler
    // now sits at one of its planned paths.
    writeFileSync(routeFile(root, 'local-widgets'), APPLICATION_HANDLER);
    pause.release();
    await withinTimeout(first, 'first holder settles');
    expect(await withinTimeout(revocation, 'revocation settles')).toMatchObject(
      { code: OWNERSHIP_CODE },
    );
    expect(revoked).not.toHaveBeenCalled();
  });

  it('lazy consumer registration ignores a producer manifest from another project root', async () => {
    const { smrtConsumer } = await import('../consumer-plugin/index.js');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const repo = temporaryProject();
    const app = join(repo, 'app');
    mkdirSync(app, { recursive: true });
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify({ name: '@test/repo', type: 'module' }),
    );
    const provider = join(repo, 'node_modules', '@acme', 'widgets');
    mkdirSync(join(provider, 'dist'), { recursive: true });
    writeFileSync(
      join(provider, 'package.json'),
      JSON.stringify({
        name: '@acme/widgets',
        version: '1.0.0',
        exports: { '.': './dist/index.js' },
      }),
    );
    writeFileSync(join(provider, 'dist/index.js'), 'export class Widget {}\n');
    writeFileSync(
      join(provider, 'dist/manifest.json'),
      JSON.stringify({
        packageName: '@acme/widgets',
        objects: {
          '@acme/widgets:Widget': {
            className: 'Widget',
            qualifiedName: '@acme/widgets:Widget',
            collection: 'widgets',
            fields: {},
            methods: {},
            decoratorConfig: { api: { include: ['list', 'get'] } },
          },
        },
      }),
    );
    const producerMarker = { name: 'smrt-auto-service' } as Plugin;
    markSvelteKitRouteParticipant(
      producerMarker,
      'producer',
      true,
      'src/routes/api',
      undefined,
      () => app,
    );
    const consumer = smrtConsumer({
      projectRoot: repo,
      packages: ['@acme/widgets'],
      disableScanning: true,
      generateTypes: false,
      lazyActivation: true,
      svelteKit: {
        objects: ['@acme/widgets:Widget'],
        routesDir: 'app/src/routes/api',
        objectsDir: 'app/src/lib/objects',
        configPath: 'app/src/lib/server',
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
        resourcesRoute: { enabled: false },
      },
    }) as unknown as Plugin & { config: unknown };
    const lifecycle = { command: 'build', mode: 'production' };
    const userConfig = { root: repo, plugins: [producerMarker, consumer] };
    // The producer, rooted at app/, shares the physical route, object and
    // config directories with the consumer rooted at the repository.
    const appThingFile = join(app, 'src/lib/objects/AppOnlyThing.ts');
    mkdirSync(join(appThingFile, '..'), { recursive: true });
    writeFileSync(appThingFile, 'export class AppOnlyThing {}\n');
    const appThing = manifest(
      '@test/app:AppOnlyThing',
      'AppOnlyThing',
      'app-only-things',
      '@test/app',
      appThingFile,
    );
    await expect(
      contributeSvelteKitRoutes(lifecycle, ['producer', 'consumer'], app, {
        owner: 'producer',
        routeManifest: appThing,
        semanticManifest: appThing,
        options: routeOptions({ lazyActivation: true, kebabRoutes: false }),
        seq: 1,
        settle: () => {},
      }),
    ).resolves.toBe('pending');
    const hook = consumer.config as
      | ((...args: unknown[]) => unknown)
      | { handler: (...args: unknown[]) => unknown };
    const handler = typeof hook === 'function' ? hook : hook.handler;
    await handler.call(consumer, userConfig, lifecycle);

    // The consumer's lazy registration under the repository root names its
    // own objects, never the app root's.
    const registration: string[] = [];
    const collect = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) collect(path);
        else if (path.endsWith('.js'))
          registration.push(readFileSync(path, 'utf8'));
      }
    };
    collect(join(repo, '.smrt'));
    expect(registration.join('\n')).toContain('@acme/widgets:Widget');
    expect(registration.join('\n')).not.toContain('AppOnlyThing');
  }, 60_000);

  it.each([
    ['eager', false],
    ['lazy', true],
  ])(
    'a clean cross-root consumer registration imports a build-schema module that exists after config settlement (%s)',
    async (_mode, lazyActivation) => {
      const { smrtConsumer } = await import('../consumer-plugin/index.js');
      vi.spyOn(console, 'log').mockImplementation(() => {});
      const repo = temporaryProject();
      const app = join(repo, 'app');
      const appObjects = join(app, 'src/lib/objects');
      mkdirSync(appObjects, { recursive: true });
      writeFileSync(
        join(repo, 'package.json'),
        JSON.stringify({ name: '@test/repo', type: 'module' }),
      );
      const provider = join(repo, 'node_modules', '@acme', 'widgets');
      mkdirSync(join(provider, 'dist'), { recursive: true });
      writeFileSync(
        join(provider, 'package.json'),
        JSON.stringify({
          name: '@acme/widgets',
          version: '1.0.0',
          exports: { '.': './dist/index.js' },
        }),
      );
      writeFileSync(
        join(provider, 'dist/index.js'),
        'export class Widget {}\n',
      );
      writeFileSync(
        join(provider, 'dist/manifest.json'),
        JSON.stringify({
          packageName: '@acme/widgets',
          objects: {
            '@acme/widgets:Widget': {
              className: 'Widget',
              qualifiedName: '@acme/widgets:Widget',
              collection: 'widgets',
              fields: {},
              methods: {},
              decoratorConfig: { api: { include: ['list', 'get'] } },
            },
          },
        }),
      );
      const producerMarker = { name: 'smrt-auto-service' } as Plugin;
      markSvelteKitRouteParticipant(
        producerMarker,
        'producer',
        true,
        'src/routes/api',
        undefined,
        () => app,
      );
      const consumer = smrtConsumer({
        projectRoot: repo,
        packages: ['@acme/widgets'],
        disableScanning: true,
        generateTypes: false,
        lazyActivation,
        svelteKit: {
          objects: ['@acme/widgets:Widget'],
          routesDir: 'app/src/routes/api',
          objectsDir: 'app/src/lib/objects',
          configPath: 'app/src/lib/server',
          changesRoute: { enabled: false },
          eventsRoute: { enabled: false },
          resourcesRoute: { enabled: false },
        },
      }) as unknown as Plugin & { config: unknown };
      const lifecycle = { command: 'build', mode: 'production' };
      const thingFile = join(appObjects, 'AppThing.ts');
      writeFileSync(thingFile, 'export class AppThing {}\n');
      const appManifest = manifest(
        '@test/app:AppThing',
        'AppThing',
        'app-things',
        '@test/app',
        thingFile,
      );
      // The producer at app/ is the settling writer for app/.smrt only.
      await expect(
        contributeSvelteKitRoutes(lifecycle, ['producer', 'consumer'], app, {
          owner: 'producer',
          routeManifest: appManifest,
          semanticManifest: appManifest,
          options: routeOptions({ lazyActivation, kebabRoutes: false }),
          seq: 1,
          settle: () => {},
          publishesBuildSchemaFor: canonicalSvelteKitPath(app),
        }),
      ).resolves.toBe('pending');
      const hook = consumer.config as
        | ((...args: unknown[]) => unknown)
        | { handler: (...args: unknown[]) => unknown };
      const handler = typeof hook === 'function' ? hook : hook.handler;
      await handler.call(
        consumer,
        { root: repo, plugins: [producerMarker, consumer] },
        lifecycle,
      );

      const registerPath = join(repo, '.smrt', 'register.js');
      const specifier = /import '(\.\/build-schema\.js)';/.exec(
        readFileSync(registerPath, 'utf8'),
      )?.[1];
      expect(specifier).toBe('./build-schema.js');
      expect(existsSync(join(repo, '.smrt', 'build-schema.js'))).toBe(true);
      expect(existsSync(join(app, '.smrt', 'build-schema.js'))).toBe(true);
    },
    60_000,
  );
});
