import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Plugin } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types.js';
import type { SvelteKitOptions } from './sveltekit-generator.js';
import {
  contributeSvelteKitRoutes,
  expectedSvelteKitRouteOwners,
  markSvelteKitRouteParticipant,
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
): Promise<void> {
  await contributeSvelteKitRoutes(lifecycle, expectedOwners, root, {
    owner,
    routeManifest,
    semanticManifest,
    options,
  });
}

describe('SvelteKit route participant targets', () => {
  it('waits only for participants with the same routesDir', () => {
    const producer = { name: 'smrt-auto-service' } as Plugin;
    const consumer = { name: 'smrt-consumer' } as Plugin;
    markSvelteKitRouteParticipant(producer, 'producer', true, 'src/routes/api');
    markSvelteKitRouteParticipant(
      consumer,
      'consumer',
      true,
      'src/routes/external',
    );
    const config = { plugins: [producer, consumer] };

    expect(expectedSvelteKitRouteOwners(config, 'src/routes/api')).toEqual([
      'producer',
    ]);
    expect(expectedSvelteKitRouteOwners(config, 'src/routes/external')).toEqual(
      ['consumer'],
    );
  });
});

describe('contributeSvelteKitRoutes', () => {
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
});
