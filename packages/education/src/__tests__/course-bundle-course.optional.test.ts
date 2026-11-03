import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterAll, beforeAll, it } from 'vitest';
import {
  assertChooseDuringAttach,
  assertConcurrentPartsSettlePlacement,
  assertFirstAttachRace,
  classes,
} from './course-bundle-course-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? it : it.skip)(
  'serializes a review choice made while an attach is in flight on PostgreSQL',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: classes,
    });
    try {
      await assertChooseDuringAttach(isolated.baseDb);
    } finally {
      await isolated.cleanup();
    }
  },
);
(isPostgresAvailable() ? it : it.skip)(
  'settles a shared placement one part at a time on PostgreSQL',
  async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: classes,
    });
    try {
      await assertConcurrentPartsSettlePlacement(isolated.baseDb);
    } finally {
      await isolated.cleanup();
    }
  },
);
for (const reason of ['unit-mismatch', 'part-conflict'] as const)
  for (const pause of ['before-lock', 'after-reads'] as const)
    (isPostgresAvailable() ? it : it.skip)(
      `lets only one of two disagreeing first attaches commit on PostgreSQL (${reason}, paused ${pause})`,
      async () => {
        const isolated = await createIsolatedTestDbFromManifest({
          includeObjects: classes,
        });
        try {
          await assertFirstAttachRace(reason, pause, isolated.baseDb);
        } finally {
          await isolated.cleanup();
        }
      },
    );
