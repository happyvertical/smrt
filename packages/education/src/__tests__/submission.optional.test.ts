import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
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
  assertLegacyIntakeFallback,
  assertPackets,
  assertSharedStorageDenial,
  assertSubmissionHostDenial,
  assertSubmissionQueue,
  assertUncertainCommit,
  submissionClasses,
} from './submission-workflows.js';

beforeAll(() => enableTenancy());
afterAll(() => disableTenancy());
(isPostgresAvailable() ? describe : describe.skip)(
  'SubmissionService postgres',
  () => {
    for (const [name, assertion] of Object.entries({
      privateWriteGuard: (f: Awaited<ReturnType<typeof learnerFixture>>) =>
        assertPrivateAssetWriteGuard(f, 'postgres'),
      privateMaterial: assertPrivateMaterial,
      models: assertSubmissionModels,
      capture: assertCapture,
      sharedStorageDenial: assertSharedStorageDenial,
      uncertainCommit: assertUncertainCommit,
      queue: assertSubmissionQueue,
      grading: assertGrading,
      legacyIntakeFallback: assertLegacyIntakeFallback,
      rollback: assertCaptureRollback,
      cleanupFailure: assertCleanupFailure,
      hostDenial: assertSubmissionHostDenial,
      packets: assertPackets,
    }))
      it(name, async () => {
        const isolated = await createIsolatedTestDbFromManifest({
          includeObjects: submissionClasses,
        });
        try {
          await assertion(await learnerFixture(isolated.baseDb));
        } finally {
          await isolated.cleanup();
        }
      });
  },
);
