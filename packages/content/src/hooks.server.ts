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

// Side-effect: import registers all SMRT classes via @smrt() decorators
import './lib/server/smrt-register.js';
import { getSmrtConfig } from '$lib/server/smrt';

// Also import actual class constructors so generateSchema can resolve them
import { Content } from './content.js';
import { ContentReference } from './content-reference.js';

let schemaReady = false;

async function bootstrapSchema() {
  if (schemaReady) return;
  schemaReady = true; // Mark early to prevent concurrent bootstrap attempts

  try {
    const config = getSmrtConfig('Content');
    const dbUrl = (config.db as any)?.url || '.smrt/local.db';
    const db = await getDatabase({ url: dbUrl, type: 'sqlite' });

    // Load all available manifests so cross-package classes (Image, Asset, etc.) are known
    ObjectRegistry.loadAllManifests();

    // For local classes, we need to compile schemas first
    // (external classes already have schemas in their manifests)
    const localClasses = [Content, ContentReference];
    for (const cls of localClasses) {
      try {
        await generateSchema(cls);
      } catch {
        // Schema generation may fail for abstract/collection classes
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
  } catch (err: any) {
    console.error('[hooks] Failed to bootstrap schema:', err.message);
  }
}

export const handle: Handle = async ({ event, resolve }) => {
  await bootstrapSchema();
  return resolve(event);
};
