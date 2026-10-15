import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, describe, it } from 'vitest';
import {
  assertAuthorizationAndSharing,
  assertInputAndIdentityGuards,
  assertRefreshAndPrivacy,
  assertRollbackAndRetry,
  sourceFixture,
} from './source-import-contract.js';

(isPostgresAvailable() ? describe : describe.skip)(
  'source import (PostgreSQL)',
  () => {
    beforeAll(() => enableTenancy());
    afterAll(() => disableTenancy());
    for (const [name, contract] of [
      [
        'retains identities and history; real catalog excludes other owners',
        assertRefreshAndPrivacy,
      ],
      [
        'enforces actor and source sharing matrix',
        assertAuthorizationAndSharing,
      ],
      [
        'rolls back later failures and retries serialized imports',
        assertRollbackAndRetry,
      ],
      [
        'validates fetch, rechecks policy and rejects corrupted identities',
        assertInputAndIdentityGuards,
      ],
    ] as const) {
      it(name, async () => {
        const isolated = await createIsolatedTestDbFromManifest({
          includeObjects: [
            'Tenant',
            'CourseSource',
            'Course',
            'CourseSection',
            'Lesson',
          ],
        });
        try {
          await contract(await sourceFixture(isolated.baseDb));
        } finally {
          await isolated.cleanup();
        }
      });
    }
  },
);
