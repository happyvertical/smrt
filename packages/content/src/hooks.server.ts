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
import { seedContents } from '$lib/server/seed-contents';
import { getSmrtConfig } from '$lib/server/smrt';

// Also import actual class constructors so generateSchema can resolve them
import { Content } from './content.js';
import { ContentContribution } from './content-contribution.js';
import { ContentContributionAttachment } from './content-contribution-attachment.js';
import { ContentContributionRevision } from './content-contribution-revision.js';
import { ContentContributionType } from './content-contribution-type.js';
import { ContentContributor } from './content-contributor.js';
import { ContentCorrection } from './content-correction.js';
import { ContentGovernanceAssignment } from './content-governance-assignment.js';
import { ContentGovernancePolicy } from './content-governance-policy.js';
import { ContentGovernanceProfile } from './content-governance-profile.js';
import { ContentReference } from './content-reference.js';
import { ContentReview } from './content-review.js';
import { ContentVersion } from './content-version.js';

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

      // For local classes, we need to compile schemas first
      // (external classes already have schemas in their manifests)
      const localClasses = [
        Content,
        ContentReference,
        ContentContribution,
        ContentContributionRevision,
        ContentContributionAttachment,
        ContentContributionType,
        ContentContributor,
        ContentCorrection,
        ContentGovernancePolicy,
        ContentGovernanceProfile,
        ContentGovernanceAssignment,
        ContentReview,
        ContentVersion,
      ];
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
      schemaReady = true;

      // Seed sample content for dev mode
      await seedContents();
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
