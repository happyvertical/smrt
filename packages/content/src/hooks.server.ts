/**
 * SvelteKit server hooks — bootstraps DB schema for dev mode
 *
 * Since lazy schema creation was removed, we need to explicitly
 * create tables on server startup before any routes can function.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '@happyvertical/logger';
import {
  ObjectRegistry,
  SmrtCollection,
  type SmrtObject,
} from '@happyvertical/smrt-core';
import {
  ensureSchema,
  generateSchema,
} from '@happyvertical/smrt-core/schema/utils';
import { getDatabase } from '@happyvertical/sql';
import type { Handle } from '@sveltejs/kit';
import { seedContents } from '$lib/server/seed-contents';
import { getSmrtConfig } from '$lib/server/smrt';
import { workspacePackageRoots } from '../workspace-aliases.js';

const logger = createLogger({ level: 'info' });

let schemaReady = false;
let bootstrapPromise: Promise<void> | null = null;
let runtimeRegistrationReady = false;
let runtimeRegistrationPromise: Promise<void> | null = null;
const currentPackageRoot = fileURLToPath(new URL('..', import.meta.url));

const dependencyPackageLoaders = [
  () => import('@happyvertical/smrt-assets'),
  () => import('@happyvertical/smrt-chat'),
  () => import('@happyvertical/smrt-facts'),
  () => import('@happyvertical/smrt-images'),
  () => import('@happyvertical/smrt-messages'),
  () => import('@happyvertical/smrt-profiles'),
] as const;

function resolveWorkspaceManifestPaths(): string[] {
  const packageRoots = [
    currentPackageRoot,
    ...Object.values(workspacePackageRoots),
  ];

  const candidates = packageRoots
    .map((packageRoot) => {
      const runtimeManifestCandidates =
        packageRoot === currentPackageRoot
          ? [
              resolve(packageRoot, '.smrt/manifest.json'),
              resolve(packageRoot, 'dist/manifest.json'),
              resolve(packageRoot, 'src/manifest/manifest.json'),
            ]
          : [
              resolve(packageRoot, 'dist/manifest.json'),
              resolve(packageRoot, 'src/manifest/manifest.json'),
              resolve(packageRoot, '.smrt/manifest.json'),
            ];

      return runtimeManifestCandidates.find((manifestPath) =>
        existsSync(manifestPath),
      );
    })
    .filter((manifestPath): manifestPath is string => Boolean(manifestPath));

  return [...new Set(candidates)];
}

async function registerContentWorkspaceRuntime() {
  if (runtimeRegistrationReady) {
    return;
  }

  if (runtimeRegistrationPromise) {
    return runtimeRegistrationPromise;
  }

  runtimeRegistrationPromise = (async () => {
    const externalManifestPaths = resolveWorkspaceManifestPaths();
    if (externalManifestPaths.length > 0) {
      ObjectRegistry.loadAllManifests({
        manifestPaths: externalManifestPaths,
      });
    } else {
      ObjectRegistry.loadAllManifests();
    }

    for (const loadDependencyPackage of dependencyPackageLoaders) {
      await loadDependencyPackage();
    }

    // Register the content package after dependency manifests are cached so the
    // generated routes and qualified lookups resolve against the same runtime
    // metadata the package publishes.
    await import('./lib/server/smrt-register.js');
    runtimeRegistrationReady = true;
  })();

  return runtimeRegistrationPromise;
}

function getRegisteredObjectClasses(): Array<typeof SmrtObject> {
  const constructors = new Set<typeof SmrtObject>();
  const frameworkBaseClassNames = new Set([
    'SmrtClass',
    'SmrtCollection',
    'SmrtObject',
  ]);

  for (const registered of ObjectRegistry.getAllClasses().values()) {
    const ctor = registered.constructor;

    if (!ctor) {
      continue;
    }

    if (frameworkBaseClassNames.has(ctor.name)) {
      continue;
    }

    if (ctor.prototype instanceof SmrtCollection) {
      continue;
    }

    if (
      registered.extends === 'SmrtCollection' ||
      registered.inheritanceChain?.includes('SmrtCollection')
    ) {
      continue;
    }

    if ('_itemClass' in (ctor as object) || ctor.name.endsWith('Collection')) {
      continue;
    }

    constructors.add(ctor as typeof SmrtObject);
  }

  return [...constructors];
}

async function bootstrapSchema() {
  if (schemaReady) {
    return;
  }

  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    try {
      await registerContentWorkspaceRuntime();

      const config = getSmrtConfig('@happyvertical/smrt-content:Content');
      // `config.db` is a `DatabaseConfig` union; only the object-config form
      // carries `url`/`type`. Narrow to that shape (the string and
      // DatabaseInterface variants fall through to the defaults below).
      const dbConfig =
        config.db && typeof config.db === 'object'
          ? (config.db as {
              url?: string;
              type?: 'sqlite' | 'postgres' | 'duckdb' | 'json';
            })
          : undefined;
      const dbUrl = dbConfig?.url || '.smrt/local.db';
      const dbType = dbConfig?.type || 'sqlite';
      const db = await getDatabase({ url: dbUrl, type: dbType });

      // Only generate schema for persisted object classes. Collection classes
      // and base framework types are registered too, but they should never hit
      // schema generation.
      const registeredClasses = getRegisteredObjectClasses();
      const schemaReadyClassNames = new Set<string>();

      for (const cls of registeredClasses) {
        try {
          await generateSchema(cls);
          schemaReadyClassNames.add(cls.name);
        } catch (error) {
          logger.warn(`[hooks] Skipped schema generation for ${cls.name}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      let created = 0;
      for (const className of schemaReadyClassNames) {
        try {
          await ensureSchema(db, className);
          created++;
        } catch (error) {
          logger.warn(`[hooks] Skipped schema ensure for ${className}`, {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info(
        `[hooks] Database schema bootstrap complete (${created} tables ensured)`,
      );
      await seedContents();
      schemaReady = true;
    } catch (err) {
      logger.error('[hooks] Failed to bootstrap schema', { error: err });
    } finally {
      if (!schemaReady) {
        bootstrapPromise = null;
      }
    }
  })();

  return bootstrapPromise;
}

function requestNeedsSchemaBootstrap(pathname: string): boolean {
  return pathname.startsWith('/api/');
}

export const handle: Handle = async ({ event, resolve }) => {
  if (requestNeedsSchemaBootstrap(event.url.pathname)) {
    await bootstrapSchema();
  }

  return resolve(event);
};
