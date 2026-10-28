import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  groupSharingAdversarialClasses,
  groupSharingAdversarialContractTests,
  groupSharingConcurrencyContractTests,
} from './group-sharing-adversarial-workflows.js';
import {
  groupSharingCommentClasses,
  groupSharingCommentContractTests,
} from './group-sharing-comment-workflows.js';
import {
  assertGroupSharingAdministration,
  assertGroupSharingAtomicity,
  assertGroupSharingCapabilityIsolation,
  assertGroupSharingCurrentAuthority,
  assertGroupSharingDiscovery,
  assertGroupSharingHostContracts,
  assertGroupSharingLifecycle,
  assertGroupSharingPersistedAuthority,
  assertGroupSharingRetainedAvailability,
  assertGroupSharingRosterAndRevocation,
  assertGroupSharingRosterAvailability,
  assertGroupSharingTargeting,
  assertGroupSharingValidation,
  groupSharingLifecycleClasses,
  groupSharingLifecycleFixture,
} from './group-sharing-lifecycle-workflows.js';
import {
  groupSharingMigrationBaseClasses,
  groupSharingMigrationContractTests,
} from './group-sharing-migration-workflows.js';
import {
  groupSharingReadClasses,
  groupSharingReadContractTests,
} from './group-sharing-read-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

const make = async () => {
  const isolated = await createIsolatedTestDbFromManifest({
    includeObjects: [
      ...new Set([
        ...groupSharingLifecycleClasses,
        ...groupSharingReadClasses,
        ...groupSharingCommentClasses,
        ...groupSharingAdversarialClasses,
      ]),
    ],
  });
  return {
    db: isolated.baseDb,
    cleanup: isolated.cleanup,
    connect: () =>
      getDatabase({
        ...isolated.config,
        cache: false,
        __smrtSkipVitestSchemaPreparation: true,
      } as Parameters<typeof getDatabase>[0]),
  };
};

// Upgrade verification needs its own old database; other committed fixtures
// have already installed the sharing tables in the package's disposable DB.
const makeMigration = async () => {
  const connection = process.env.DATABASE_URL;
  if (!connection)
    throw new Error('Migrated disposable PostgreSQL URL required');
  const url = new URL(connection);
  // Administrative handles must not auto-install application schema in the
  // original shared database under the administrative role.
  const admin = await (async () => {
    const probe = await getDatabase({
      type: 'postgres',
      url: connection,
      cache: false,
      __smrtSkipVitestSchemaPreparation: true,
    } as Parameters<typeof getDatabase>[0]);
    let candidate: Awaited<ReturnType<typeof getDatabase>> | undefined;
    try {
      const ownership = `SELECT schemaname, tablename, tableowner
        FROM pg_tables
        WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
        ORDER BY schemaname, tablename`;
      const before = (await probe.query(ownership)).rows;
      candidate = await getDatabase({
        type: 'postgres',
        url: process.env.SMRT_TEST_POSTGRES_ADMIN_URL ?? url.toString(),
        cache: false,
        __smrtSkipVitestSchemaPreparation: true,
      } as Parameters<typeof getDatabase>[0]);
      expect((await probe.query(ownership)).rows).toEqual(before);
      return candidate;
    } catch (error) {
      await candidate?.close?.();
      throw error;
    } finally {
      await probe.close?.();
    }
  })();
  const name = `smrt_groups_upgrade_${crypto.randomUUID().replaceAll('-', '')}`;
  const owner = decodeURIComponent(url.username).replaceAll('"', '""');
  let db: Awaited<ReturnType<typeof getTestDatabase>> | undefined;
  try {
    await admin.query(`CREATE DATABASE "${name}" OWNER "${owner}"`);
    url.pathname = `/${name}`;
    db = await getTestDatabase({
      type: 'postgres',
      url: url.toString(),
      classes: groupSharingMigrationBaseClasses,
    });
    return {
      db,
      cleanup: async () => {
        await db?.close?.();
        await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
        await admin.close?.();
      },
    };
  } catch (error) {
    await db?.close?.();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.close?.();
    throw error;
  }
};

(isPostgresAvailable() ? describe : describe.skip)(
  'Group sharing PostgreSQL owning boundaries and concurrent consent',
  () => {
    for (const [name, assertion] of Object.entries({
      administration: assertGroupSharingAdministration,
      lifecycle: assertGroupSharingLifecycle,
      targeting: assertGroupSharingTargeting,
      atomicity: assertGroupSharingAtomicity,
      rosterAvailability: assertGroupSharingRosterAvailability,
      retainedAvailability: assertGroupSharingRetainedAvailability,
      capabilityIsolation: assertGroupSharingCapabilityIsolation,
      currentAuthority: assertGroupSharingCurrentAuthority,
      hostContracts: assertGroupSharingHostContracts,
      discovery: assertGroupSharingDiscovery,
      validation: assertGroupSharingValidation,
      rosterAndRevocation: assertGroupSharingRosterAndRevocation,
      persistedAuthority: assertGroupSharingPersistedAuthority,
    })) {
      it(name, async () => {
        const handle = await make();
        try {
          await assertion(await groupSharingLifecycleFixture(handle.db));
        } finally {
          await handle.cleanup();
        }
      });
    }
    groupSharingReadContractTests(make);
    groupSharingCommentContractTests(make);
    groupSharingAdversarialContractTests(make);
    groupSharingConcurrencyContractTests(make);
    groupSharingMigrationContractTests(makeMigration);
  },
);
