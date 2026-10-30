import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe } from 'vitest';
import {
  groupSharingAdversarialClasses,
  groupSharingAdversarialContractTests,
} from './group-sharing-adversarial-workflows.js';
import { groupSharingConcurrencyContractTests } from './group-sharing-concurrency-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
const make = async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: groupSharingAdversarialClasses,
  });
  return {
    db,
    cleanup: async () => {
      await db.close?.();
    },
  };
};
describe('Group sharing adversarial SQLite', () =>
  groupSharingAdversarialContractTests(make));
describe('Group sharing concurrency SQLite', () =>
  groupSharingConcurrencyContractTests(make));
