import { BackfillTracker } from '@happyvertical/smrt-core/migrations';
import { normalizeIdentityEmail } from '@happyvertical/smrt-profiles';
import type { getDatabase } from '@happyvertical/sql';

type DatabaseInterface = Awaited<ReturnType<typeof getDatabase>>;

export const USER_EMAIL_KEY_BACKFILL_NAME =
  '@happyvertical/smrt-users:user-email-keys:v1';

export interface DuplicateUserEmailKey {
  emailKey: string;
  userCount: number;
}

export interface BackfillUserEmailKeysResult {
  updated: number;
}

export type UserEmailKeyBackfillErrorCode =
  | 'duplicate_email'
  | 'transaction_required';

/**
 * Raised before any rows are changed when legacy User emails are ambiguous.
 */
export class UserEmailKeyBackfillError extends Error {
  constructor(
    readonly code: UserEmailKeyBackfillErrorCode,
    message: string,
    readonly duplicates: DuplicateUserEmailKey[] = [],
  ) {
    super(message);
    this.name = 'UserEmailKeyBackfillError';
  }
}

/**
 * Populate the durable normalized-email key for Users created before the
 * `emailKey` field existed.
 *
 * Apply the schema migration first, stop or upgrade legacy writers, then call
 * this once from a single deploy process. The operation is idempotent. It
 * fails before changing any rows when two non-blank emails normalize to the
 * same key, so operators can reconcile those Users explicitly.
 */
export async function backfillUserEmailKeys(
  db: DatabaseInterface,
): Promise<BackfillUserEmailKeysResult> {
  if (!db.transaction) {
    throw new UserEmailKeyBackfillError(
      'transaction_required',
      'User email-key backfill requires a root database with transaction().',
    );
  }

  const tracker = new BackfillTracker({ db });
  await tracker.initialize();

  return db.transaction(async (tx) => {
    BackfillTracker.inheritInitialization(tx, db);
    const result = await tx.query(
      'SELECT id, email, email_key FROM users ORDER BY id',
    );
    const counts = new Map<string, number>();
    const updates: Array<{ emailKey: string | null; id: string }> = [];

    for (const row of result.rows) {
      const id = typeof row.id === 'string' ? row.id : '';
      if (!id) {
        throw new Error('User email-key backfill found a row without an id.');
      }
      const email = typeof row.email === 'string' ? row.email : '';
      const emailKey = email.trim() ? normalizeIdentityEmail(email) : null;
      if (emailKey) counts.set(emailKey, (counts.get(emailKey) ?? 0) + 1);
      const storedKey =
        typeof row.email_key === 'string' ? row.email_key : null;
      if (storedKey !== emailKey) updates.push({ emailKey, id });
    }

    const duplicates = [...counts.entries()]
      .filter(([, userCount]) => userCount > 1)
      .map(([emailKey, userCount]) => ({ emailKey, userCount }))
      .sort((left, right) => left.emailKey.localeCompare(right.emailKey));
    if (duplicates.length > 0) {
      throw new UserEmailKeyBackfillError(
        'duplicate_email',
        'Cannot backfill User.emailKey because legacy User emails contain normalized duplicates.',
        duplicates,
      );
    }

    // Clear every changing key first. This avoids transient unique-index
    // conflicts for valid final states such as two legacy rows whose stale
    // keys were swapped.
    for (const update of updates) {
      await tx.query(
        'UPDATE users SET email_key = NULL WHERE id = ?',
        update.id,
      );
    }
    for (const update of updates) {
      await tx.query(
        'UPDATE users SET email_key = ? WHERE id = ?',
        update.emailKey,
        update.id,
      );
    }

    await new BackfillTracker({ db: tx }).recordApplied(
      USER_EMAIL_KEY_BACKFILL_NAME,
      {
        description: 'Canonical User email keys are current.',
        packageName: '@happyvertical/smrt-users',
      },
    );

    return { updated: updates.length };
  });
}
