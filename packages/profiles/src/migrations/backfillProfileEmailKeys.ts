import { BackfillTracker } from '@happyvertical/smrt-core/migrations';
import type { getDatabase } from '@happyvertical/sql';
import { normalizeIdentityEmail } from '../auth/normalizeIdentityEmail.js';

type DatabaseInterface = Awaited<ReturnType<typeof getDatabase>>;

export const PROFILE_EMAIL_KEY_BACKFILL_NAME =
  '@happyvertical/smrt-profiles:profile-email-keys:v1';

export interface BackfillProfileEmailKeysResult {
  updated: number;
}

/**
 * Populate adapter-independent Profile email keys after the schema migration.
 *
 * Run this from one deploy process after legacy writers are stopped or
 * upgraded. Every read and update runs in one transaction, and repeats are a
 * no-op.
 */
export async function backfillProfileEmailKeys(
  db: DatabaseInterface,
): Promise<BackfillProfileEmailKeysResult> {
  if (!db.transaction) {
    throw new Error(
      'Profile email-key backfill requires a root database with transaction().',
    );
  }

  const tracker = new BackfillTracker({ db });
  await tracker.initialize();

  return db.transaction(async (tx) => {
    BackfillTracker.inheritInitialization(tx, db);
    const result = await tx.query(
      'SELECT id, email, email_key FROM profiles ORDER BY id',
    );
    const updates: Array<{ emailKey: string | null; id: string }> = [];

    for (const row of result.rows) {
      const id = typeof row.id === 'string' ? row.id : '';
      if (!id) {
        throw new Error(
          'Profile email-key backfill found a row without an id.',
        );
      }
      const email = typeof row.email === 'string' ? row.email : '';
      const emailKey = email.trim() ? normalizeIdentityEmail(email) : null;
      const storedKey =
        typeof row.email_key === 'string' ? row.email_key : null;
      if (storedKey !== emailKey) updates.push({ emailKey, id });
    }

    for (const update of updates) {
      await tx.query(
        'UPDATE profiles SET email_key = ? WHERE id = ?',
        update.emailKey,
        update.id,
      );
    }

    await new BackfillTracker({ db: tx }).recordApplied(
      PROFILE_EMAIL_KEY_BACKFILL_NAME,
      {
        description: 'Canonical Profile identity email keys are current.',
        packageName: '@happyvertical/smrt-profiles',
      },
    );

    return { updated: updates.length };
  });
}
