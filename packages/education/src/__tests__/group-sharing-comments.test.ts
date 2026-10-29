import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe } from 'vitest';
import {
  groupSharingCommentClasses,
  groupSharingCommentContractTests,
} from './group-sharing-comment-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('Group sharing revision comments sqlite', () =>
  groupSharingCommentContractTests(async () => {
    const db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: groupSharingCommentClasses,
    });
    return {
      db,
      cleanup: async () => {
        await db.close?.();
      },
    };
  }));
