import { BackfillTracker } from '@happyvertical/smrt-core/migrations';
import {
  normalizeIdentityEmail,
  Person,
  PROFILE_EMAIL_KEY_BACKFILL_NAME,
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import type { getDatabase } from '@happyvertical/sql';
import { USER_EMAIL_KEY_BACKFILL_NAME } from './backfillUserEmailKeys.js';

type DatabaseInterface = Awaited<ReturnType<typeof getDatabase>>;

export const LEGACY_USER_PROFILE_BACKFILL_NAME =
  '@happyvertical/smrt-users:legacy-user-profiles:v1';

export interface BackfillLegacyUserProfilesResult {
  created: number;
  linked: number;
}

export type LegacyUserProfileBackfillErrorCode =
  | 'duplicate_user_email'
  | 'missing_email'
  | 'profile_conflict'
  | 'profile_email_backfill_required'
  | 'profile_type_conflict'
  | 'reservation_conflict'
  | 'stale_user_email_key'
  | 'transaction_required'
  | 'user_email_backfill_required';

/** Fail-closed deploy-time legacy User/Profile migration error. */
export class LegacyUserProfileBackfillError extends Error {
  constructor(
    readonly code: LegacyUserProfileBackfillErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'LegacyUserProfileBackfillError';
  }
}

interface LegacyUserCandidate {
  email: string;
  emailKey: string;
  id: string;
}

/**
 * Create and link canonical global Person Profiles for legacy Users whose
 * `profile_id` is still null or blank.
 *
 * Run this from one deploy process after schema migration and both email-key
 * backfills. Every preflight read and mutation uses one transaction. Existing
 * same-email Profiles are rejected for explicit operator reconciliation; this
 * migration never infers ownership and never creates an OIDC identity.
 *
 * The completion marker records a successful pass but does not skip later
 * calls. A newly imported legacy User is therefore processed on the next run.
 */
export async function backfillLegacyUserProfiles(
  db: DatabaseInterface,
): Promise<BackfillLegacyUserProfilesResult> {
  if (!db.transaction) {
    throw new LegacyUserProfileBackfillError(
      'transaction_required',
      'Legacy User/Profile backfill requires a root database with transaction().',
    );
  }
  const transaction = db.transaction;

  return withSystemContext(() =>
    transaction<BackfillLegacyUserProfilesResult>(async (tx) => {
      BackfillTracker.requireExistingTable(tx);
      const tracker = new BackfillTracker({ db: tx });
      if (!(await tracker.isApplied(PROFILE_EMAIL_KEY_BACKFILL_NAME))) {
        throw new LegacyUserProfileBackfillError(
          'profile_email_backfill_required',
          'Run backfillProfileEmailKeys() before the legacy User/Profile backfill.',
        );
      }
      if (!(await tracker.isApplied(USER_EMAIL_KEY_BACKFILL_NAME))) {
        throw new LegacyUserProfileBackfillError(
          'user_email_backfill_required',
          'Run backfillUserEmailKeys() before the legacy User/Profile backfill.',
        );
      }

      const lockClause = /^postgres(?:ql)?:/iu.test(tx.url ?? '')
        ? ' FOR UPDATE'
        : '';
      const userResult = await tx.query(
        `SELECT CAST(id AS VARCHAR) AS id, email, email_key,
                CAST(profile_id AS VARCHAR) AS profile_id
         FROM users
         ORDER BY id${lockClause}`,
      );
      const candidates: LegacyUserCandidate[] = [];
      const userEmailOwners = new Map<string, string[]>();

      for (const row of userResult.rows) {
        const id = readRequiredString(row.id, 'User id');
        const email = readString(row.email) ?? '';
        const emailKey = email.trim() ? normalizeIdentityEmail(email) : null;
        if (readString(row.email_key) !== emailKey) {
          throw new LegacyUserProfileBackfillError(
            'stale_user_email_key',
            `User ${id} has a missing or stale email key; rerun backfillUserEmailKeys().`,
          );
        }
        if (emailKey) {
          const owners = userEmailOwners.get(emailKey) ?? [];
          owners.push(id);
          userEmailOwners.set(emailKey, owners);
        }

        const profileId = readString(row.profile_id);
        if (profileId?.trim()) continue;
        if (!emailKey) {
          throw new LegacyUserProfileBackfillError(
            'missing_email',
            `User ${id} cannot receive a canonical Profile without a nonblank email.`,
          );
        }
        candidates.push({ email, emailKey, id });
      }

      const duplicate = [...userEmailOwners.entries()].find(
        ([, owners]) => owners.length > 1,
      );
      if (duplicate) {
        throw new LegacyUserProfileBackfillError(
          'duplicate_user_email',
          `Multiple Users share normalized email ${duplicate[0]}; reconcile them before backfill.`,
        );
      }

      const candidateEmails = new Set(
        candidates.map((candidate) => candidate.emailKey),
      );
      const profileResult = await tx.query(
        'SELECT CAST(id AS VARCHAR) AS id, slug, email, email_key FROM profiles ORDER BY id',
      );
      for (const row of profileResult.rows) {
        const id = readRequiredString(row.id, 'Profile id');
        const slug = readString(row.slug);
        const email = readString(row.email) ?? '';
        const expectedEmailKey = email.trim()
          ? normalizeIdentityEmail(email)
          : null;
        if (readString(row.email_key) !== expectedEmailKey) {
          throw new LegacyUserProfileBackfillError(
            'profile_email_backfill_required',
            `Profile ${id} has a missing or stale email key; rerun backfillProfileEmailKeys().`,
          );
        }
        if (expectedEmailKey && candidateEmails.has(expectedEmailKey)) {
          throw new LegacyUserProfileBackfillError(
            'profile_conflict',
            `A Profile already uses the email required by legacy User ${findCandidateId(candidates, expectedEmailKey)}; reconcile ownership explicitly.`,
          );
        }
        const slugOwner = candidates.find(
          (candidate) => `legacy-user-${candidate.id}` === slug,
        );
        if (slugOwner) {
          throw new LegacyUserProfileBackfillError(
            'profile_conflict',
            `Profile slug ${slug} is already in use; reconcile legacy User ${slugOwner.id} explicitly.`,
          );
        }
      }

      if (candidateEmails.size > 0) {
        const reservationResult = await tx.query(
          'SELECT email_key FROM oidc_profile_email_reservations ORDER BY email_key',
        );
        const conflict = reservationResult.rows.find((row) => {
          const emailKey = readString(row.email_key);
          return emailKey ? candidateEmails.has(emailKey) : false;
        });
        if (conflict) {
          const emailKey = readRequiredString(
            conflict.email_key,
            'Reservation email key',
          );
          throw new LegacyUserProfileBackfillError(
            'reservation_conflict',
            `A canonical identity reservation already uses the email required by legacy User ${findCandidateId(candidates, emailKey)}.`,
          );
        }
      }

      const personTypeResult = await tx.query(
        `SELECT CAST(id AS VARCHAR) AS id
         FROM profile_types
         WHERE slug = 'person'
           AND context = ''
           AND _meta_type = '@happyvertical/smrt-profiles:ProfileType'
           AND tenant_id IS NULL
         ORDER BY id`,
      );
      if (personTypeResult.rows.length > 1) {
        throw new LegacyUserProfileBackfillError(
          'profile_type_conflict',
          'Multiple global Person ProfileTypes exist; reconcile them before backfill.',
        );
      }

      const profileTypes = await ProfileTypeCollection.create({ db: tx });
      const profiles = await ProfileCollection.create({ db: tx });
      let created = 0;
      let linked = 0;

      for (const candidate of candidates) {
        const personType = await profileTypes.getOrCreateGlobalBySlug(
          'person',
          {
            name: 'Person',
            description: 'Individual person profile',
          },
        );
        const typeId = readRequiredString(
          personType.id,
          'Person ProfileType id',
        );
        let profile = new Person({
          db: tx,
          email: candidate.email,
          name: candidate.email,
          slug: `legacy-user-${candidate.id}`,
          tenantId: null,
          typeId,
        });
        await profile.initialize();
        await profile.save();
        profile = await profiles.reserveCanonicalIdentityEmail(
          readRequiredString(profile.id, 'Created Profile id'),
          candidate.email,
        );
        const update = await tx.query(
          `UPDATE users
           SET profile_id = ?, updated_at = current_timestamp
           WHERE id = ?
             AND (profile_id IS NULL OR TRIM(CAST(profile_id AS VARCHAR)) = '')`,
          readRequiredString(profile.id, 'Reserved Profile id'),
          candidate.id,
        );
        if (update.rowCount !== 1) {
          throw new Error(
            `Legacy User ${candidate.id} changed during Profile backfill.`,
          );
        }
        created += 1;
        linked += 1;
      }

      await tracker.recordApplied(LEGACY_USER_PROFILE_BACKFILL_NAME, {
        description: 'Legacy Users have canonical global Person Profiles.',
        packageName: '@happyvertical/smrt-users',
      });
      return { created, linked };
    }),
  );
}

function findCandidateId(
  candidates: LegacyUserCandidate[],
  emailKey: string,
): string {
  return (
    candidates.find((candidate) => candidate.emailKey === emailKey)?.id ??
    '<unknown>'
  );
}

function readString(value: unknown): string | null {
  return typeof value === 'string'
    ? value
    : value == null
      ? null
      : String(value);
}

function readRequiredString(value: unknown, label: string): string {
  const stringValue = readString(value);
  if (!stringValue) throw new Error(`${label} is missing.`);
  return stringValue;
}
