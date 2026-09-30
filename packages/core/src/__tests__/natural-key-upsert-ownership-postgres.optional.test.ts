/**
 * Natural-key upsert ownership on PostgreSQL — the Anytown Ludis shape.
 *
 * Anytown's `leagues` table is keyed by a global `(slug, context)` unique and
 * its `teams.league_id` references it `ON UPDATE CASCADE`. Tenant B's
 * `save()` of a league slug tenant A owns upserted onto A's row: the SDK's
 * `DO UPDATE SET` rewrote A's `id` and `tenant_id`, and the cascade moved A's
 * teams under B's league. This file proves, against a real server:
 *
 * 1. the control: the raw SDK upsert really does that on this schema;
 * 2. `save()` now refuses the cross-tenant collision on a conflict target
 *    that omits the owner, leaving A's row and A's children untouched;
 * 3. a same-owner natural-key save keeps the primary key (no cascade churn);
 * 4. a class with an undeclared `tenantId` field gets the tenant-led unique,
 *    and the pre-migration global unique is swapped in place by name — until
 *    then its creates fail loudly instead of overwriting.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set (`pnpm test:postgres`).
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { TenantIsolationError } from '../errors.js';
import { getSQLFromDiff, SchemaComparer } from '../migrations/differ.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getDDLStrategy } from '../schema/ddl/index.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const LEGACY_LEAGUES = 'nk_pg_legacy_leagues';
const LEGACY_TEAMS = 'nk_pg_legacy_teams';
const LEAGUES = 'nk_pg_leagues';

/** Pre-migration target: the explicit key omits the tenant column. */
@smrt({
  tableName: 'nk_pg_legacy_leagues',
  conflictColumns: ['slug', 'context'],
})
class NkPgLegacyLeague extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.name === 'string') this.name = options.name;
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId as string | null;
    }
  }
}

class NkPgLegacyLeagueCollection extends SmrtCollection<NkPgLegacyLeague> {
  static readonly _itemClass = NkPgLegacyLeague;
}

/** The Ludis model as shipped: `tenantId` field, no tenancy declaration. */
@smrt({ tableName: 'nk_pg_leagues' })
class NkPgLeague extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.name === 'string') this.name = options.name;
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId as string | null;
    }
  }
}

class NkPgLeagueCollection extends SmrtCollection<NkPgLeague> {
  static readonly _itemClass = NkPgLeague;
}

function registrationName(ctor: typeof SmrtObject): string {
  const registration = ObjectRegistry.getClassByConstructor(ctor);
  return registration?.qualifiedName || registration?.name || ctor.name;
}

async function createTable(
  db: DatabaseInterface,
  ctor: typeof SmrtObject,
  table: string,
  options: { indexes: boolean },
): Promise<void> {
  const className = registrationName(ctor);
  const schema = ObjectRegistry.getSchema(className);
  const ddl = ObjectRegistry.getSchemaDDL(className, 'postgres');
  if (!schema || !ddl) throw new Error(`Missing schema for ${className}`);
  await db.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
  await db.query(ddl);
  if (!options.indexes) return;
  for (const indexSql of getDDLStrategy('postgres').generateIndexes(schema)) {
    await db.query(indexSql);
  }
}

async function rows(
  db: DatabaseInterface,
  table: string,
): Promise<Array<Record<string, unknown>>> {
  return (await db.list(table, {})) as Array<Record<string, unknown>>;
}

describe.skipIf(!pgUrl)('natural-key upsert ownership on PostgreSQL', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: `smrt-test-nk-ownership-${randomUUID()}`,
      max: 4,
    } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
    await createTable(db, NkPgLegacyLeague, LEGACY_LEAGUES, { indexes: true });
    // Anytown's child shape: an FK that follows a primary-key rewrite.
    await db.query(`DROP TABLE IF EXISTS "${LEGACY_TEAMS}"`);
    await db.query(
      `CREATE TABLE "${LEGACY_TEAMS}" (id UUID PRIMARY KEY, name TEXT, tenant_id UUID,
         league_id UUID REFERENCES "${LEGACY_LEAGUES}" (id) ON UPDATE CASCADE)`,
    );
  }, 30_000);

  afterAll(async () => {
    if (!db) return;
    try {
      for (const table of [LEGACY_TEAMS, LEGACY_LEAGUES, LEAGUES]) {
        await db.query(`DROP TABLE IF EXISTS "${table}" CASCADE`);
      }
    } finally {
      await db.close?.();
    }
  });

  beforeEach(async () => {
    await db.query(`TRUNCATE "${LEGACY_TEAMS}", "${LEGACY_LEAGUES}"`);
  });

  async function seedTenantA() {
    const leagues = await NkPgLegacyLeagueCollection.create({ db });
    const league = await leagues.create({ name: 'U13', tenantId: TENANT_A });
    const teamId = randomUUID();
    await db.query(
      `INSERT INTO "${LEGACY_TEAMS}" (id, name, tenant_id, league_id) VALUES ($1, 'Broncos', $2, $3)`,
      [teamId, TENANT_A, league.id],
    );
    return { leagues, league, teamId };
  }

  it('control: the raw SDK upsert on (slug, context) takes over tenant A and cascades its teams', async () => {
    const { league, teamId } = await seedTenantA();
    const hijackId = randomUUID();
    await db.upsert(LEGACY_LEAGUES, ['slug', 'context'], {
      id: hijackId,
      slug: 'u13',
      context: '',
      name: 'U13',
      tenant_id: TENANT_B,
    });
    const [leagueRow] = await rows(db, LEGACY_LEAGUES);
    expect(leagueRow.id).toBe(hijackId);
    expect(leagueRow.tenant_id).toBe(TENANT_B);
    const [teamRow] = await rows(db, LEGACY_TEAMS);
    expect(teamRow.id).toBe(teamId);
    expect(teamRow.league_id).toBe(hijackId);
    expect(teamRow.league_id).not.toBe(league.id);
  });

  it('save() refuses the cross-tenant collision and leaves tenant A and its teams untouched', async () => {
    const { leagues, league, teamId } = await seedTenantA();
    const error = await leagues
      .create({ name: 'U13', tenantId: TENANT_B })
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect(error).toBeInstanceOf(TenantIsolationError);
    expect((error as TenantIsolationError).code).toBe(
      'TENANT_ISOLATION_VIOLATION',
    );
    expect((error as Error).message).not.toContain(TENANT_A);

    const leagueRows = await rows(db, LEGACY_LEAGUES);
    expect(leagueRows).toHaveLength(1);
    expect(leagueRows[0].id).toBe(league.id);
    expect(leagueRows[0].tenant_id).toBe(TENANT_A);
    const [teamRow] = await rows(db, LEGACY_TEAMS);
    expect(teamRow.id).toBe(teamId);
    expect(teamRow.league_id).toBe(league.id);
  });

  it('a same-owner natural-key save keeps the primary key, so nothing cascades', async () => {
    const { league, teamId } = await seedTenantA();
    const again = new NkPgLegacyLeague({ db, tenantId: TENANT_A });
    await again.initialize();
    again.name = 'U13 (renamed)';
    again.slug = 'u13';
    again.id = randomUUID();
    await again.save();

    expect(again.id).toBe(league.id);
    const leagueRows = await rows(db, LEGACY_LEAGUES);
    expect(leagueRows).toHaveLength(1);
    expect(leagueRows[0].id).toBe(league.id);
    expect(leagueRows[0].name).toBe('U13 (renamed)');
    const [teamRow] = await rows(db, LEGACY_TEAMS);
    expect(teamRow.id).toBe(teamId);
    expect(teamRow.league_id).toBe(league.id);
  });

  it('an undeclared tenantId field gets the tenant-led unique; the global one is swapped in place', async () => {
    const className = registrationName(NkPgLeague);
    expect(ObjectRegistry.getConflictColumns(className)).toEqual([
      'tenant_id',
      'slug',
      'context',
    ]);
    const schema = ObjectRegistry.getSchema(className);
    if (!schema) throw new Error('missing schema');

    // The live pre-migration shape: global (slug, context) unique.
    await createTable(db, NkPgLeague, LEAGUES, { indexes: false });
    await db.query(
      `CREATE UNIQUE INDEX "${LEAGUES}_slug_context_idx" ON "${LEAGUES}" (slug, context)`,
    );
    const existingId = randomUUID();
    await db.query(
      `INSERT INTO "${LEAGUES}" (id, slug, context, name, tenant_id) VALUES ($1, 'u13', '', 'U13', $2)`,
      [existingId, TENANT_A],
    );

    // Before the migration the runtime target has no matching unique index:
    // the create fails loudly (42P10) and tenant A's row is never touched.
    const leagues = await NkPgLeagueCollection.create({ db });
    await expect(
      leagues.create({ name: 'U13', tenantId: TENANT_B }),
    ).rejects.toThrow();
    expect((await rows(db, LEAGUES))[0].id).toBe(existingId);

    const comparer = new SchemaComparer(db, { includeDroppedIndexes: false });
    const diff = await comparer.compare({ [LEAGUES]: schema });
    const events = diff.changes
      .filter((c) => c.type === 'drop_index' || c.type === 'add_index')
      .map((c) => `${c.type}:${c.name}`);
    expect(events).toContain(`drop_index:${LEAGUES}_slug_context_idx`);
    expect(events).toContain(`add_index:${LEAGUES}_slug_context_idx`);
    for (const sql of getSQLFromDiff(diff)) {
      await db.query(sql);
    }

    const b = await leagues.create({ name: 'U13', tenantId: TENANT_B });
    expect(b.id).not.toBe(existingId);
    const after = await rows(db, LEAGUES);
    expect(after).toHaveLength(2);
    expect(after.find((row) => row.tenant_id === TENANT_A)?.id).toBe(
      existingId,
    );
  });
});
