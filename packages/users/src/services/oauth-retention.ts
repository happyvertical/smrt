import type { DatabaseInterface } from '@happyvertical/sql';
import {
  UsersOAuthAccessTokenRevocationCollection,
  UsersOAuthAuthorizationCodeCollection,
  UsersOAuthRefreshFamilyCollection,
  UsersOAuthRefreshGrantCollection,
} from '../collections/OAuthAuthorizationCollection.js';
import { withOAuthTransaction } from './oauth-transaction.js';

/** Keep expired refresh hashes for another 30 days to detect late replay. */
export const OAUTH_REFRESH_REPLAY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Reap expired OAuth credentials without removing a live family's lock row.
 * Refresh history survives token expiry plus the replay grace period, including
 * consumed/revoked grants. Clients and consent decisions are not credentials.
 * Dry runs perform no writes; their counts may race concurrent rotation.
 */
export async function pruneOAuthCredentials(
  db: DatabaseInterface,
  options: { dryRun?: boolean; now?: Date } = {},
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(
    now.getTime() - OAUTH_REFRESH_REPLAY_RETENTION_MS,
  ).toISOString();
  const codes = await UsersOAuthAuthorizationCodeCollection.create({ db });
  const revocations = await UsersOAuthAccessTokenRevocationCollection.create({
    db,
  });
  const grants = await UsersOAuthRefreshGrantCollection.create({ db });
  const families = await UsersOAuthRefreshFamilyCollection.create({ db });
  let total = 0;
  for (const table of [codes.tableName, revocations.tableName]) {
    const prune = async (tx: DatabaseInterface) => {
      // Mutate before reading in SQLite's deferred transaction: a count-first
      // read snapshot cannot be upgraded safely while another writer commits.
      if (!options.dryRun) {
        const deleted = await tx.query(
          `DELETE FROM ${table} WHERE expires_at < ? RETURNING id`,
          now.toISOString(),
        );
        return deleted.rows.length;
      }
      const counted = await tx.query(
        `SELECT COUNT(*) AS total FROM ${table} WHERE expires_at < ?`,
        now.toISOString(),
      );
      return Number(counted.rows[0]?.total ?? 0);
    };
    total += options.dryRun
      ? await prune(db)
      : await withOAuthTransaction(db, prune);
  }
  // Select only families with expired history or no descendants. An active
  // family may rotate between selection and pruning; recheck under its lock.
  const candidates = await db.query(
    `SELECT id FROM ${families.tableName} f WHERE EXISTS (SELECT 1 FROM ${grants.tableName} g WHERE g.family_id = CAST(f.id AS TEXT) AND g.expires_at < ?) OR NOT EXISTS (SELECT 1 FROM ${grants.tableName} g WHERE g.family_id = CAST(f.id AS TEXT)) ORDER BY id`,
    cutoff,
  );
  for (const candidate of candidates.rows) {
    const id = String(candidate.id);
    const prune = async (tx: DatabaseInterface) => {
      if (!options.dryRun) {
        const locked = await tx.query(
          `UPDATE ${families.tableName} SET updated_at = ? WHERE id = ?`,
          now.toISOString(),
          id,
        );
        if (locked.rowCount !== 1) return 0;
      }
      const counted = await tx.query(
        `SELECT COUNT(*) AS total FROM ${grants.tableName} WHERE family_id = ? AND expires_at < ?`,
        id,
        cutoff,
      );
      const retained = await tx.query(
        `SELECT COUNT(*) AS total FROM ${grants.tableName} WHERE family_id = ? AND expires_at >= ?`,
        id,
        cutoff,
      );
      const empty = Number(retained.rows[0]?.total ?? 0) === 0;
      if (!options.dryRun) {
        await tx.query(
          `DELETE FROM ${grants.tableName} WHERE family_id = ? AND expires_at < ?`,
          id,
          cutoff,
        );
        if (empty) {
          await tx.query(`DELETE FROM ${families.tableName} WHERE id = ?`, id);
        }
      }
      return Number(counted.rows[0]?.total ?? 0) + Number(empty);
    };
    total += options.dryRun
      ? await prune(db)
      : await withOAuthTransaction(db, prune);
  }
  return total;
}
