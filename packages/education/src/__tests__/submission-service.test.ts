import { getTestDatabase } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, it } from 'vitest';
import { learnerFixture } from './learner-workflows.js';
import { assertPrivateAssetWriteGuard } from './private-asset-write-workflows.js';
import { assertPrivateMaterial } from './private-material-workflows.js';
import { assertSubmissionModels } from './submission-model-workflows.js';
import {
  assertCapture,
  assertCaptureRollback,
  assertCleanupFailure,
  assertGrading,
  assertPackets,
  assertSharedStorageDenial,
  assertSubmissionHostDenial,
  assertSubmissionQueue,
  assertUncertainCommit,
  submissionClasses,
} from './submission-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
describe('SubmissionService sqlite', () => {
  for (const [name, assertion] of Object.entries({
    privateWriteGuard: (f: Awaited<ReturnType<typeof learnerFixture>>) =>
      assertPrivateAssetWriteGuard(f, 'sqlite'),
    privateMaterial: assertPrivateMaterial,
    models: assertSubmissionModels,
    capture: assertCapture,
    sharedStorageDenial: assertSharedStorageDenial,
    uncertainCommit: assertUncertainCommit,
    queue: assertSubmissionQueue,
    grading: assertGrading,
    rollback: assertCaptureRollback,
    cleanupFailure: assertCleanupFailure,
    hostDenial: assertSubmissionHostDenial,
    packets: assertPackets,
  }))
    it(name, async () => {
      const db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: submissionClasses,
      });
      try {
        await assertion(await learnerFixture(db));
      } finally {
        await db.close?.();
      }
    });
});
