/**
 * Natural-key upsert ownership (the Anytown Ludis takeover).
 *
 * Anytown's Ludis `League`/`Team` carry a `tenantId` field but declare no
 * tenancy; the app registers them with the tenancy interceptor at runtime.
 * Their natural key was the global `(slug, context)`, so tenant B's
 * tenant-filtered lookup missed tenant A's same-slug row, B's `save()` took
 * the INSERT path, and `ON CONFLICT (slug, context) DO UPDATE SET` rewrote A's
 * row — `id` and `tenant_id` included — while `ON UPDATE CASCADE` re-pointed
 * A's children at B's row. Same family as the #1501 secret clobber and #2360.
 *
 * Two independent defenses, both exercised here without the tenancy package
 * (the interceptor-driven reproduction lives in
 * `packages/tenancy/src/__tests__/natural-key-ownership.test.ts`):
 *
 * 1. Schema: a class with an undeclared `tenantId` field is tenant-OWNED, so
 *    its default conflict target and unique index are
 *    `(tenant_id, slug, context)` — two tenants may each own a slug.
 * 2. Runtime: when a conflict target still omits the owner (an explicit key,
 *    or a live table that has not been migrated), `save()` reads the row the
 *    upsert would hit and refuses a different owner with
 *    `TENANT_ISOLATION_VIOLATION`; a same-owner row is adopted by id so the
 *    upsert never changes its primary key.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field, foreignKey } from '../decorators/index.js';
import { TenantIsolationError } from '../errors.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** Ludis shape: `tenantId` field, no tenancy declaration, default key. */
@smrt({ tableName: 'nk_leagues' })
class NkLeague extends SmrtObject {
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

class NkLeagueCollection extends SmrtCollection<NkLeague> {
  static readonly _itemClass = NkLeague;
}

/**
 * The pre-migration shape: an explicit key that omits the tenant column (the
 * same unique a live Anytown table still carries until `db:migrate`).
 */
@smrt({ tableName: 'nk_legacy_leagues', conflictColumns: ['slug', 'context'] })
class NkLegacyLeague extends SmrtObject {
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

class NkLegacyLeagueCollection extends SmrtCollection<NkLegacyLeague> {
  static readonly _itemClass = NkLegacyLeague;
}

@smrt({ tableName: 'nk_legacy_teams' })
class NkLegacyTeam extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @foreignKey('NkLegacyLeague')
  leagueId?: string;

  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.name === 'string') this.name = options.name;
    if (typeof options.leagueId === 'string') this.leagueId = options.leagueId;
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId as string | null;
    }
  }
}

class NkLegacyTeamCollection extends SmrtCollection<NkLegacyTeam> {
  static readonly _itemClass = NkLegacyTeam;
}

/** No tenant column at all: only primary-key stability applies. */
@smrt({ tableName: 'nk_tags' })
class NkTag extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.name === 'string') this.name = options.name;
  }
}

class NkTagCollection extends SmrtCollection<NkTag> {
  static readonly _itemClass = NkTag;
}

/** smrt-users shape: the tenant column is a foreign key to the tenant table. */
@smrt({ tableName: 'nk_orgs' })
class NkOrg extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

@smrt({ tableName: 'nk_members' })
class NkMember extends SmrtObject {
  @foreignKey('NkOrg')
  tenantId?: string;
}

type Row = Record<string, unknown>;

describe('natural-key upsert ownership', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    ObjectRegistry.registerCollection('NkLeague', NkLeagueCollection);
    ObjectRegistry.registerCollection(
      'NkLegacyLeague',
      NkLegacyLeagueCollection,
    );
    ObjectRegistry.registerCollection('NkLegacyTeam', NkLegacyTeamCollection);
    ObjectRegistry.registerCollection('NkTag', NkTagCollection);
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['NkLeague', 'NkLegacyLeague', 'NkLegacyTeam', 'NkTag'],
    });
  });

  afterAll(async () => {
    await db?.close?.();
  });

  beforeEach(async () => {
    for (const table of [
      'nk_legacy_teams',
      'nk_leagues',
      'nk_legacy_leagues',
      'nk_tags',
    ]) {
      await db.query(`DELETE FROM ${table}`);
    }
  });

  describe('an undeclared tenantId field makes the default key tenant-led', () => {
    it('resolves (tenant_id, slug, context) for the conflict target', () => {
      expect(ObjectRegistry.getTenantColumn('NkLeague')).toBeUndefined();
      expect(ObjectRegistry.getOwnershipTenantColumn('NkLeague')).toBe(
        'tenant_id',
      );
      expect(ObjectRegistry.getConflictColumns('NkLeague')).toEqual([
        'tenant_id',
        'slug',
        'context',
      ]);
    });

    it('emits the tenant-led unique index under the stable name', () => {
      const conflict = ObjectRegistry.getSchema('NkLeague')?.indexes.find(
        (index) => index.name === 'nk_leagues_slug_context_idx',
      );
      expect(conflict?.unique).toBe(true);
      expect(conflict?.columns).toEqual(['tenant_id', 'slug', 'context']);
    });

    it('a tenant foreign key leads the key without becoming a delete CASCADE', () => {
      expect(NkOrg.name).toBe('NkOrg');
      expect(ObjectRegistry.getConflictColumns('NkMember')).toEqual([
        'tenant_id',
        'slug',
        'context',
      ]);
      const column = ObjectRegistry.getSchema('NkMember')?.columns.tenant_id;
      expect(column?.foreignKey?.onDelete).toBe('NO ACTION');
    });

    it('never rewrites an explicit key and leaves tenantless classes alone', () => {
      expect(ObjectRegistry.getConflictColumns('NkLegacyLeague')).toEqual([
        'slug',
        'context',
      ]);
      expect(ObjectRegistry.getConflictColumns('NkTag')).toEqual([
        'slug',
        'context',
      ]);
    });

    it('two tenants each keep their own same-slug league', async () => {
      const leagues = await NkLeagueCollection.create({ db });
      const a = await leagues.create({ name: 'U13', tenantId: TENANT_A });
      const b = await leagues.create({ name: 'U13', tenantId: TENANT_B });

      expect(b.id).not.toBe(a.id);
      const rows = (await db.list('nk_leagues', {})) as Row[];
      expect(rows).toHaveLength(2);
      expect(rows.find((row) => row.tenant_id === TENANT_A)?.id).toBe(a.id);
      expect(rows.find((row) => row.tenant_id === TENANT_B)?.id).toBe(b.id);
    });
  });

  describe('a conflict target without the owner refuses a cross-owner save', () => {
    it('tenant B cannot overwrite tenant A: id, tenant and children stay put', async () => {
      const leagues = await NkLegacyLeagueCollection.create({ db });
      const teams = await NkLegacyTeamCollection.create({ db });
      const a = await leagues.create({ name: 'U13', tenantId: TENANT_A });
      const broncos = await teams.create({
        name: 'Broncos',
        leagueId: a.id as string,
        tenantId: TENANT_A,
      });

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
      // The other tenant is never named to the caller.
      expect(String((error as Error).message)).not.toContain(TENANT_A);
      expect(
        JSON.stringify((error as TenantIsolationError).details),
      ).not.toContain(TENANT_A);

      const rows = (await db.list('nk_legacy_leagues', {})) as Row[];
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(a.id);
      expect(rows[0].tenant_id).toBe(TENANT_A);
      const teamRows = (await db.list('nk_legacy_teams', {})) as Row[];
      expect(teamRows[0].id).toBe(broncos.id);
      expect(teamRows[0].league_id).toBe(a.id);
    });

    it('a tenant save never adopts a global row, and a global save never adopts a tenant row', async () => {
      const leagues = await NkLegacyLeagueCollection.create({ db });
      const global = await leagues.create({ name: 'Open', tenantId: null });
      await expect(
        leagues.create({ name: 'Open', tenantId: TENANT_A }),
      ).rejects.toBeInstanceOf(TenantIsolationError);

      const owned = await leagues.create({ name: 'U15', tenantId: TENANT_A });
      await expect(
        leagues.create({ name: 'U15', tenantId: null }),
      ).rejects.toBeInstanceOf(TenantIsolationError);

      const rows = (await db.list('nk_legacy_leagues', {})) as Row[];
      expect(rows.find((row) => row.id === global.id)?.tenant_id).toBeNull();
      expect(rows.find((row) => row.id === owned.id)?.tenant_id).toBe(TENANT_A);
    });

    it('the same owner still upserts in place and keeps the primary key', async () => {
      const leagues = await NkLegacyLeagueCollection.create({ db });
      const first = await leagues.create({ name: 'U13', tenantId: TENANT_A });
      // A fresh instance that never looked the row up carries a new id.
      const again = new NkLegacyLeague({ db, tenantId: TENANT_A });
      await again.initialize();
      again.name = 'U13';
      again.slug = 'u13';
      again.id = crypto.randomUUID();
      await again.save();

      expect(again.id).toBe(first.id);
      const rows = (await db.list('nk_legacy_leagues', {})) as Row[];
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(first.id);
    });
  });

  it('a table without a tenant column keeps its primary key on a natural-key upsert', async () => {
    const tags = await NkTagCollection.create({ db });
    const first = await tags.create({ name: 'Hockey' });
    const again = new NkTag({ db });
    await again.initialize();
    again.name = 'Hockey';
    again.slug = 'hockey';
    again.id = crypto.randomUUID();
    await again.save();

    expect(again.id).toBe(first.id);
    const rows = (await db.list('nk_tags', {})) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(first.id);
  });
});
