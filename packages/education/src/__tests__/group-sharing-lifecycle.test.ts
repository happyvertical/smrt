import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, it } from 'vitest';
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

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('group sharing lifecycle SQLite', () => {
  for (const [name, assertion] of Object.entries({
    administration: assertGroupSharingAdministration,
    capabilityIsolation: assertGroupSharingCapabilityIsolation,
    discovery: assertGroupSharingDiscovery,
    rosterAvailability: assertGroupSharingRosterAvailability,
    retainedAvailability: assertGroupSharingRetainedAvailability,
    lifecycle: assertGroupSharingLifecycle,
    hostContracts: assertGroupSharingHostContracts,
    targeting: assertGroupSharingTargeting,
    atomicity: assertGroupSharingAtomicity,
    currentAuthority: assertGroupSharingCurrentAuthority,
    validation: assertGroupSharingValidation,
    rosterAndRevocation: assertGroupSharingRosterAndRevocation,
    persistedAuthority: assertGroupSharingPersistedAuthority,
  })) {
    it(name, async () => {
      const db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: groupSharingLifecycleClasses,
      });
      try {
        await assertion(await groupSharingLifecycleFixture(db));
      } finally {
        await db.close?.();
      }
    });
  }
});
