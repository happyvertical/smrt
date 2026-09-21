/**
 * Agent (bot) profile resolution under concurrency — PostgreSQL (#2995).
 *
 * `resolveAgentProfile()` is a find-then-create, and its first use happens on an
 * agent's first turn — exactly when several requests can arrive at once. A split
 * identity here would be silent: two `bot` profiles for one agent, so replies in
 * one session stop joining to the author of another.
 *
 * The convergence this pins is engine-level (revision conflicts, the
 * `(tenant_id, slug, context)` unique index, and the fact that NULLs are
 * distinct in that index for an untenanted agent), so it only means anything
 * against real PostgreSQL. Gated on `DATABASE_URL`.
 */

import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfileCollection, resolveAgentProfileId } from '../index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('resolveAgentProfile concurrency (#2995)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let profiles: ProfileCollection;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        '@happyvertical/smrt-profiles:Profile',
        '@happyvertical/smrt-profiles:ProfileType',
      ],
    });
    profiles = await ProfileCollection.create({ db: isolated.db });
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  async function agentProfileRows(slug: string): Promise<number> {
    const result = await isolated?.db.query(
      `SELECT CAST(id AS VARCHAR) AS id FROM profiles
        WHERE slug = ? AND context = 'smrt:agent'`,
      slug,
    );
    return result?.rows.length ?? -1;
  }

  it('converges on one profile for parallel first use in a tenant', async () => {
    const tenantId = crypto.randomUUID();
    const ids = await Promise.all(
      Array.from({ length: 5 }, () =>
        resolveAgentProfileId(profiles, { agentId: 'race_agent', tenantId }),
      ),
    );

    expect(new Set(ids).size).toBe(1);
    expect(await agentProfileRows('race_agent')).toBe(1);
  });

  it('converges on one profile for parallel first use of an untenanted agent', async () => {
    // The unique index is `(tenant_id, slug, context)` and NULLs are distinct in
    // it (smrt#2360), so this case is NOT arbitrated by the database — it is the
    // resolver's re-read that has to converge it.
    const ids = await Promise.all(
      Array.from({ length: 5 }, () =>
        resolveAgentProfileId(profiles, {
          agentId: 'race_global',
          tenantId: null,
        }),
      ),
    );

    expect(new Set(ids).size).toBe(1);
    expect(await agentProfileRows('race_global')).toBe(1);
  });
});
