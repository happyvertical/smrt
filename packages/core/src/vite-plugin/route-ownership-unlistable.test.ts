/**
 * A route directory the generated-route sweep would walk but cannot list
 * refuses in the preflight, before `beforeCleanup` and before any generated
 * file is removed (#5437). The listing failure is injected through a
 * pass-through `node:fs` mock; no test relies on file modes.
 */

import { createHash } from 'node:crypto';
import {
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SmartObjectManifest } from '../scanner/types';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import { generateSvelteKitRoutes } from './sveltekit-generator.js';

const unlistable = vi.hoisted(() => ({
  path: undefined as string | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const readdirSync = ((path: unknown, ...rest: unknown[]) => {
    if (unlistable.path !== undefined && String(path) === unlistable.path) {
      throw Object.assign(new Error('EACCES: injected listing failure'), {
        code: 'EACCES',
      });
    }
    return (actual.readdirSync as (...args: unknown[]) => unknown)(
      path,
      ...rest,
    );
  }) as typeof actual.readdirSync;
  return { ...actual, default: { ...actual, readdirSync }, readdirSync };
});

const PACKAGE = '@fixture/route-unlistable';
let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'smrt-route-unlistable-'));
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: PACKAGE, type: 'module' }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  unlistable.path = undefined;
  vi.restoreAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
});

function manifest(...collections: string[]): SmartObjectManifest {
  return {
    version: '1',
    timestamp: 0,
    packageName: PACKAGE,
    objects: Object.fromEntries(
      collections.map((collection) => {
        const className = `${collection[0]?.toUpperCase()}${collection.slice(1, -1)}`;
        return [
          `${PACKAGE}:${className}`,
          {
            qualifiedName: `${PACKAGE}:${className}`,
            className,
            collection,
            packageName: PACKAGE,
            filePath: join(projectRoot, 'src/lib/objects', `${className}.ts`),
            fields: { name: { type: 'text' } },
            methods: {},
            decoratorConfig: { api: true },
          },
        ];
      }),
    ),
  } as unknown as SmartObjectManifest;
}

function inventory(root = projectRoot): Record<string, string> {
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

describe('route directories the sweep cannot list', () => {
  it('a route directory the sweep cannot list refuses before anything changes', async () => {
    const options = {
      enabled: true,
      routesDir: 'src/routes/api',
      objectsDir: 'src/lib/objects',
      configPath: 'src/lib/server',
      configFileName: 'smrt.ts',
      resourcesRoute: { enabled: false },
    };
    const routeManifest = manifest('kites', 'lanterns');
    await generateSvelteKitRoutes(projectRoot, routeManifest, options);
    // An obsolete generated route the sweep would remove first.
    const obsolete = join(projectRoot, 'src/routes/api/archive/+server.ts');
    mkdirSync(join(obsolete, '..'), { recursive: true });
    writeFileSync(obsolete, `${AUTO_GENERATED_ROUTE_HEADER}\n// obsolete\n`);
    const blocked = join(projectRoot, 'src/routes/api/lanterns');
    const beforeCleanup = vi.fn();
    const before = inventory();
    unlistable.path = blocked;

    await expect(
      generateSvelteKitRoutes(
        projectRoot,
        routeManifest,
        options,
        routeManifest,
        undefined,
        routeManifest,
        { beforeCleanup },
      ),
    ).rejects.toMatchObject({
      name: 'ApplicationRouteConflictError',
      code: 'SMRT_ROUTE_OWNERSHIP_CONFLICT',
      phase: 'preflight',
      files: [blocked],
    });

    unlistable.path = undefined;
    expect(beforeCleanup).not.toHaveBeenCalled();
    expect(inventory()).toEqual(before);

    // Negative control: once listable, the sweep removes the obsolete route.
    await generateSvelteKitRoutes(
      projectRoot,
      routeManifest,
      options,
      routeManifest,
      undefined,
      routeManifest,
      { beforeCleanup },
    );
    expect(beforeCleanup).toHaveBeenCalledTimes(1);
    expect(inventory()[relative(projectRoot, obsolete)]).toBeUndefined();
  });
});
