/**
 * ProfileTypeCollection - Collection manager for ProfileType objects
 *
 * Provides querying for profile type lookup table.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { isSystemContext } from '@happyvertical/smrt-tenancy';
import { ProfileType } from '../models/ProfileType';

function isPostgresUrl(url: string | undefined): boolean {
  return /^postgres(?:ql)?:/iu.test(url ?? '');
}

export class ProfileTypeCollection extends SmrtCollection<ProfileType> {
  static readonly _itemClass = ProfileType;

  /**
   * Get profile type by slug
   *
   * @param slug - The slug to search for
   * @returns ProfileType instance or null
   */
  async getBySlug(slug: string): Promise<ProfileType | null> {
    return await this.get({ slug });
  }

  /**
   * Get or create a profile type by slug
   *
   * @param slug - The slug to search for
   * @param defaults - Default values if creating
   * @returns ProfileType instance
   */
  async getOrCreateBySlug(
    slug: string,
    defaults: { name: string; description?: string },
  ): Promise<ProfileType> {
    const existing = await this.getBySlug(slug);
    if (existing) return existing;

    const profileType = await this.create({ slug, ...defaults });
    await profileType.save();
    return profileType;
  }

  /**
   * Atomically create or load a global ProfileType from trusted system code.
   *
   * This intentionally bypasses tenant auto-population and therefore refuses
   * to run outside an explicit `withSystemContext()` boundary.
   */
  async getOrCreateGlobalBySlug(
    slug: string,
    defaults: { name: string; description?: string },
  ): Promise<ProfileType> {
    if (!isSystemContext()) {
      throw new Error(
        'Global ProfileType creation requires an explicit system context.',
      );
    }

    const existing = await this.loadGlobalBySlug(slug);
    if (existing) return existing;

    // A plain SMRT create is an upsert and may replace the winning row's id
    // when two first-login transactions race. Keep the canonical id stable by
    // using a cross-adapter insert-if-absent and then hydrating the winner.
    //
    // The table's unique key is `(tenant_id, slug, context, _meta_type)` since
    // smrt#2360, and a global row's NULL tenant never conflicts at the
    // database level (NULLs are distinct in a unique index), so a raw
    // `ON CONFLICT (…) DO NOTHING` can no longer arbitrate this race. Serialize
    // the global create per slug instead: PostgreSQL through a
    // transaction-scoped advisory lock (the arbiter the SDK's null-aware
    // upsert uses too); the embedded engines through the provisioning
    // coordinator's in-process lock plus their single-writer transactions.
    const insertIfAbsent = async (db: typeof this.db): Promise<void> => {
      if (isPostgresUrl(db.url)) {
        await db.query(
          'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?))',
          '@happyvertical/smrt-profiles:profile_types:global',
          slug,
        );
      }
      await db.query(
        `INSERT INTO profile_types
          (id, slug, context, _meta_type, tenant_id, name, description)
         SELECT ?, ?, '', '@happyvertical/smrt-profiles:ProfileType', NULL, ?, ?
         WHERE NOT EXISTS (
           SELECT 1 FROM profile_types
           WHERE slug = ?
             AND context = ''
             AND _meta_type = '@happyvertical/smrt-profiles:ProfileType'
             AND tenant_id IS NULL
         )`,
        crypto.randomUUID(),
        slug,
        defaults.name,
        defaults.description ?? null,
        slug,
      );
    };

    // A transaction-scoped advisory lock only spans both statements when they
    // run on one transaction. On PostgreSQL, any handle that is NOT already
    // transaction-bound may route each query to a different pooled connection
    // — a root adapter (`beginTransaction` present) and equally a view
    // wrapper (only `transaction()` present) — so open a transaction for the
    // pair on every such handle. A transaction-bound handle (fingerprint: it
    // carries `commit`) already keeps both statements on one client and must
    // not nest. Embedded engines run directly: a nested root transaction
    // would deadlock their single-writer adapters, and the provisioning
    // coordinator's in-process lock already serializes them.
    const isTransactionBound =
      typeof (this.db as { commit?: unknown }).commit === 'function';
    if (
      isPostgresUrl(this.db.url) &&
      !isTransactionBound &&
      typeof this.db.transaction === 'function'
    ) {
      await this.db.transaction((tx) => insertIfAbsent(tx));
    } else {
      await insertIfAbsent(this.db);
    }
    const profileType = await this.loadGlobalBySlug(slug);
    if (!profileType) {
      throw new Error(
        `Global ProfileType '${slug}' could not be created or loaded.`,
      );
    }
    return profileType;
  }

  private async loadGlobalBySlug(slug: string): Promise<ProfileType | null> {
    const result = await this.db.query(
      `SELECT CAST(id AS VARCHAR) AS id
       FROM profile_types
       WHERE slug = ?
         AND context = ''
         AND _meta_type = '@happyvertical/smrt-profiles:ProfileType'
         AND tenant_id IS NULL
       LIMIT 1`,
      slug,
    );
    const id = result.rows[0]?.id;
    if (typeof id !== 'string') return null;
    const profileType = await this.get({ id });
    // @happyvertical/sql 0.88 exposes native DuckDB UUID result values as an
    // internal object. The cast above is the portable identity boundary for
    // this lookup; retain it on the hydrated object used by provisioning.
    if (profileType) profileType.id = id;
    return profileType;
  }
}
