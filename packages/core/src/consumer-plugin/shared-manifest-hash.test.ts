/**
 * One `manifestHash` per generation. When a producer and a consumer host
 * routes into one SvelteKit app, the CRUD routes' ETag salt, the `_events`
 * stream's hash and both web modules' `manifestHash` export must be the same
 * value: smrt-web compares the `_events` hash with the web module's, and a
 * mismatch reports a contract update on every connection.
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types.js';
import { smrtPlugin } from '../vite-plugin/index.js';
import {
  computeWebManifestHash,
  withMemoizedWebManifestHash,
} from '../vite-plugin/web-collections.js';
import { smrtConsumer } from './index.js';

const PROVIDER = '@acme/hashed';

let projectRoot: string;

function routeHash(path: string): string {
  const source = readFileSync(
    join(projectRoot, 'src/routes/api', path),
    'utf-8',
  );
  const match = source.match(/const MANIFEST_HASH = (['"])([^'"]+)\1;/);
  if (!match) throw new Error(`No MANIFEST_HASH in ${path}`);
  return match[2];
}

async function webModuleHash(plugin: any, id: string): Promise<string> {
  const hook = plugin.load;
  const load = typeof hook === 'function' ? hook : hook.handler;
  const source = (await load.call({}, id, {})) as string;
  const match = source.match(/export const manifestHash = "([^"]+)";/);
  if (!match) throw new Error(`No manifestHash in ${id}`);
  return match[1];
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'smrt-shared-hash-'));
  mkdirSync(join(projectRoot, 'src/lib/objects'), { recursive: true });
  mkdirSync(join(projectRoot, 'src/lib/server'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({
      name: '@fixture/shared-hash-app',
      version: '1.0.0',
      type: 'module',
      dependencies: { [PROVIDER]: '1.0.0' },
    }),
  );
  writeFileSync(
    join(projectRoot, 'src/lib/objects/LocalNote.ts'),
    `import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ api: { include: ['list', 'get'] } })
export class LocalNote extends SmrtObject {
  title = '';
}
`,
  );
  const providerDir = join(projectRoot, 'node_modules', '@acme', 'hashed');
  mkdirSync(join(providerDir, 'dist'), { recursive: true });
  writeFileSync(
    join(providerDir, 'package.json'),
    JSON.stringify({
      name: PROVIDER,
      version: '1.0.0',
      exports: { '.': './dist/index.js' },
    }),
  );
  writeFileSync(
    join(providerDir, 'dist', 'index.js'),
    'export class Gadget {}\n',
  );
  writeFileSync(
    join(providerDir, 'dist', 'manifest.json'),
    JSON.stringify({
      moduleType: 'smrt',
      packageName: PROVIDER,
      objects: {
        [`${PROVIDER}:Gadget`]: {
          className: 'Gadget',
          qualifiedName: `${PROVIDER}:Gadget`,
          packageName: PROVIDER,
          collection: 'gadgets',
          fields: { label: { type: 'text' } },
          methods: {},
          decoratorConfig: { api: { include: ['list', 'get'] } },
        },
      },
    }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('a producer and a consumer sharing one route target', () => {
  it('emit one manifestHash in the routes, the events stream and both web modules', async () => {
    const producer = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
      svelteKit: {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      },
    });
    const consumer = smrtConsumer({
      packages: [PROVIDER],
      projectRoot,
      disableScanning: true,
      generateTypes: false,
      svelteKit: { objects: [`${PROVIDER}:Gadget`] },
    });

    await resolveConfig(
      {
        root: projectRoot,
        configFile: false,
        logLevel: 'silent',
        plugins: [producer, consumer],
      },
      'build',
    );

    const localRoute = routeHash('localnotes/+server.ts');
    expect(routeHash('localnotes/[id]/+server.ts')).toBe(localRoute);
    expect(routeHash('gadgets/+server.ts')).toBe(localRoute);
    expect(routeHash('_events/+server.ts')).toBe(localRoute);
    expect(await webModuleHash(producer, '\0smrt:web')).toBe(localRoute);
    expect(await webModuleHash(consumer, '\0smrt-consumer:web')).toBe(
      localRoute,
    );
  });

  it('keeps a producer-only app on its own manifest hash', async () => {
    rmSync(join(projectRoot, 'node_modules'), { recursive: true, force: true });
    const producer = smrtPlugin({
      include: ['src/**/*.ts'],
      generateTypes: false,
      svelteKit: {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
      },
    });

    await resolveConfig(
      {
        root: projectRoot,
        configFile: false,
        logLevel: 'silent',
        plugins: [producer],
      },
      'build',
    );

    const localRoute = routeHash('localnotes/+server.ts');
    expect(routeHash('_events/+server.ts')).toBe(localRoute);
    expect(await webModuleHash(producer, '\0smrt:web')).toBe(localRoute);
  });

  it('memoizes the hash by manifest identity only inside one generation pass', async () => {
    const manifest = {
      version: '1.0.0',
      timestamp: 0,
      objects: {
        '@fixture/memo:Note': {
          className: 'Note',
          name: 'Note',
          qualifiedName: '@fixture/memo:Note',
          packageName: '@fixture/memo',
          filePath: '',
          collection: 'notes',
          fields: { title: { type: 'text' } },
          methods: {},
          decoratorConfig: {},
        },
      },
    } as unknown as SmartObjectManifest;
    const before = computeWebManifestHash(manifest);
    const widen = () => {
      (
        manifest.objects['@fixture/memo:Note'].fields as Record<string, unknown>
      ).body = {
        type: 'text',
      };
    };

    await withMemoizedWebManifestHash(async () => {
      expect(computeWebManifestHash(manifest)).toBe(before);
      widen();
      // Inside the pass the first answer is reused.
      expect(computeWebManifestHash(manifest)).toBe(before);
    });

    // Outside it, the hash reflects the manifest again.
    expect(computeWebManifestHash(manifest)).not.toBe(before);
  });
});
