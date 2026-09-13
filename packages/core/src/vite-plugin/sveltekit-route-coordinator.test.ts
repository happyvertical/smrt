import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types.js';
import type { SvelteKitOptions } from './sveltekit-generator.js';
import {
  assertSvelteKitRouteCoordinationComplete,
  contributeSvelteKitRoutes,
  expectedSvelteKitRouteOwners,
  markSvelteKitRouteParticipant,
  revokeSvelteKitRoutes,
  type SvelteKitRouteOwner,
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
        filePath: join('/virtual/node_modules', packageName, `${className}.ts`),
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
      manifest('LocalWidget', 'LocalWidget', 'local-widgets', '@app/local'),
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
    expect(registration).toContain('RemoteWidget');
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
