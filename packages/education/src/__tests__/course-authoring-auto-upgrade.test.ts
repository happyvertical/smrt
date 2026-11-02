import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertFailingAutoUpgradeAuthorizerIsIsolated,
  autoUpgradeClasses,
} from './course-authoring-auto-upgrade-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());

describe('Auto-upgrade authorizer isolation SQLite', () => {
  it('isolates a host authorizer whose statement fails', async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: autoUpgradeClasses,
    });
    try {
      await assertFailingAutoUpgradeAuthorizerIsIsolated(db);
    } finally {
      await db.close?.();
    }
  });
});
