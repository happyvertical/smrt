/**
 * SvelteKit server hooks — bootstraps DB schema for dev mode
 *
 * Since lazy schema creation was removed, we need to explicitly
 * create tables on server startup before any routes can function.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  ensureSchema,
  generateSchema,
} from '@happyvertical/smrt-core/schema/utils';
import { getDatabase } from '@happyvertical/sql';
import type { Handle } from '@sveltejs/kit';

// Register dependency package objects used by the content dev server QA
// surfaces so schema bootstrap can prepare their tables too.
import '@happyvertical/smrt-assets';
import '@happyvertical/smrt-chat';
import '@happyvertical/smrt-facts';
import '@happyvertical/smrt-images';
import '@happyvertical/smrt-messages';
import '@happyvertical/smrt-profiles';

// Side-effect: import registers all SMRT classes via @smrt() decorators
import './lib/server/smrt-register.js';
import { getSmrtConfig } from '$lib/server/smrt';

let schemaReady = false;
let bootstrapPromise: Promise<void> | null = null;

async function bootstrapSchema() {
  if (schemaReady) {
    return;
  }

  if (bootstrapPromise) {
    return bootstrapPromise;
  }

  bootstrapPromise = (async () => {
    try {
      const config = getSmrtConfig('@happyvertical/smrt-content:Content');
      const dbUrl = (config.db as any)?.url || '.smrt/local.db';
      const dbType = (config.db as any)?.type || 'sqlite';
      const db = await getDatabase({ url: dbUrl, type: dbType });

      // Load all available manifests so cross-package classes (Image, Asset, etc.) are known
      ObjectRegistry.loadAllManifests();

      // Compile schemas for all registered objects, including dependency
      // packages used by the content QA surfaces. The dev server now exposes
      // governance, contributions, facts, chat, images, and other generated
      // routes, so only preparing local content classes leaves hidden runtime
      // gaps that browser E2E catches immediately.
      const registeredClasses = ObjectRegistry.getClassNames()
        .map((name) => ObjectRegistry.getClass(name))
        .filter((registered): registered is NonNullable<typeof registered> =>
          Boolean(registered),
        )
        .map((registered) => registered.constructor);

      for (const cls of registeredClasses) {
        try {
          await generateSchema(cls);
        } catch (error) {
          console.warn(
            `[hooks] Skipped schema generation for ${cls.name}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }

      // Now ensure all schemas exist in the database
      const classNames = ObjectRegistry.getClassNames();
      let created = 0;
      for (const className of classNames) {
        try {
          await ensureSchema(db, className);
          created++;
        } catch {
          // Some classes (collection types, abstract) don't need tables — skip
        }
      }

      console.log(
        `[hooks] Database schema bootstrap complete (${created} tables ensured)`,
      );
      schemaReady = true;
    } catch (err: any) {
      console.error('[hooks] Failed to bootstrap schema:', err.message);
    } finally {
      if (!schemaReady) {
        bootstrapPromise = null;
      }
    }
  })();

  return bootstrapPromise;
}

export const handle: Handle = async ({ event, resolve }) => {
  await bootstrapSchema();
  return resolve(event);
};
