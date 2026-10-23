import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ReferenceReviewHost } from '../../reference/review-host.js';

export type OwnedReviewFixture = {
  app: ReferenceReviewHost;
  close(): Promise<void>;
};

/** Creates and exclusively owns the temporary root used by the browser fixture. */
export async function createReviewFixture(
  provision: (root: string) => Promise<ReferenceReviewHost>,
): Promise<OwnedReviewFixture> {
  const root = await mkdtemp(join(tmpdir(), 'review-'));
  let app: ReferenceReviewHost;
  try {
    app = await provision(root);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  let closing: Promise<void> | undefined;
  return {
    app,
    close() {
      closing ??= (async () => {
        try {
          await app.settle();
          await app.db.close?.();
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      })();
      return closing;
    },
  };
}
