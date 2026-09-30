/**
 * The Anytown Ludis takeover, reproduced through the real tenancy stack.
 *
 * Ludis `League`/`Team` carry a `tenantId` field but declare no tenancy; the
 * app registers them with `registerTenantScopedClass()` at runtime. The
 * interceptor therefore filters every lookup by tenant — so tenant B's
 * `create({ name: 'U13' })` cannot see tenant A's `u13` league, never adopts
 * its id, and takes the INSERT path. With the old global `(slug, context)`
 * key, `ON CONFLICT … DO UPDATE SET` then rewrote A's `id` and `tenant_id`,
 * and `ON UPDATE CASCADE` moved A's teams under B.
 *
 * Covered here on SQLite, and on PostgreSQL when `SMRT_TEST_POSTGRES_URL` is
 * set (`pnpm test:postgres`):
 *
 * - the shipped model (undeclared `tenantId`) now keys on
 *   `(tenant_id, slug, context)`: both tenants keep their own `u13`;
 * - a conflict target that still omits the tenant (explicit key, the
 *   pre-migration live shape) refuses B's save with
 *   `TENANT_ISOLATION_VIOLATION`; A's league and teams are untouched;
 * - a repeated same-tenant create still dedups in place and keeps the id;
 * - `auditTenantScopedRegistrations()` reports the runtime-only registrations
 *   and the ones whose natural key is not tenant-scoped.
 */

import {
  field,
  foreignKey,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { withSystemContext, withTenant } from '../context.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  auditTenantScopedRegistrations,
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

/** As shipped in Anytown: `tenantId` field, no tenancy declaration. */
@smrt({ tableName: 'ludis_nk_leagues' })
class LudisNkLeague extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

class LudisNkLeagueCollection extends SmrtCollection<LudisNkLeague> {
  static readonly _itemClass = LudisNkLeague;
}

@smrt({ tableName: 'ludis_nk_teams' })
class LudisNkTeam extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @foreignKey('LudisNkLeague')
  leagueId?: string;

  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.leagueId !== undefined) this.leagueId = options.leagueId;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

class LudisNkTeamCollection extends SmrtCollection<LudisNkTeam> {
  static readonly _itemClass = LudisNkTeam;
}

/** The pre-migration conflict target: the global `(slug, context)` key. */
@smrt({
  tableName: 'ludis_nk_legacy_leagues',
  conflictColumns: ['slug', 'context'],
})
class LudisNkLegacyLeague extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

class LudisNkLegacyLeagueCollection extends SmrtCollection<LudisNkLegacyLeague> {
  static readonly _itemClass = LudisNkLegacyLeague;
}

/** Registered on a field the model does not have. */
@smrt({ tableName: 'ludis_nk_mismatched' })
class LudisNkMismatched extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

const LUDIS_POLICY = {
  field: 'tenantId',
  mode: 'required' as const,
  autoFilter: true,
  autoPopulate: true,
  allowSuperAdminBypass: true,
};

const TABLES = [
  'ludis_nk_teams',
  'ludis_nk_leagues',
  'ludis_nk_legacy_leagues',
  'ludis_nk_mismatched',
];

type Row = Record<string, unknown>;

async function rawRows(db: DatabaseInterface, table: string): Promise<Row[]> {
  return (await db.list(table, {})) as Row[];
}

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

const engines: Array<{
  name: string;
  skip: boolean;
  connect: () => Promise<DatabaseInterface>;
}> = [
  {
    name: 'SQLite',
    skip: false,
    connect: async () => getDatabase({ type: 'sqlite', url: ':memory:' }),
  },
  {
    name: 'PostgreSQL',
    skip: !pgUrl,
    connect: async () =>
      getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-tenancy-nk-ownership-${crypto.randomUUID()}`,
        max: 4,
      } as Parameters<typeof getDatabase>[0]),
  },
];

for (const engine of engines) {
  describe.skipIf(engine.skip)(
    `Ludis natural-key takeover through the tenancy interceptor (${engine.name})`,
    () => {
      let db: DatabaseInterface;
      let leagues: LudisNkLeagueCollection;
      let teams: LudisNkTeamCollection;
      let legacy: LudisNkLegacyLeagueCollection;

      beforeAll(async () => {
        ObjectRegistry.registerCollection(
          'LudisNkLeague',
          LudisNkLeagueCollection,
        );
        ObjectRegistry.registerCollection('LudisNkTeam', LudisNkTeamCollection);
        ObjectRegistry.registerCollection(
          'LudisNkLegacyLeague',
          LudisNkLegacyLeagueCollection,
        );
        const connection = await engine.connect();
        if (engine.name === 'PostgreSQL') {
          for (const table of TABLES) {
            await connection.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
          }
        }
        db = await getTestDatabase({
          db: connection,
          classes: [
            'LudisNkLeague',
            'LudisNkTeam',
            'LudisNkLegacyLeague',
            'LudisNkMismatched',
          ],
        });
        leagues = await LudisNkLeagueCollection.create({ db });
        teams = await LudisNkTeamCollection.create({ db });
        legacy = await LudisNkLegacyLeagueCollection.create({ db });
        enableTenancy();
        for (const className of [
          'LudisNkLeague',
          'LudisNkTeam',
          'LudisNkLegacyLeague',
        ]) {
          registerTenantScopedClass(className, LUDIS_POLICY);
        }
      }, 30_000);

      afterAll(async () => {
        for (const className of [
          'LudisNkLeague',
          'LudisNkTeam',
          'LudisNkLegacyLeague',
          'LudisNkMismatched',
        ]) {
          unregisterTenantScopedClass(className);
        }
        disableTenancy();
        if (!db) return;
        if (engine.name === 'PostgreSQL') {
          for (const table of TABLES) {
            await db.query(`DROP TABLE IF EXISTS ${table} CASCADE`);
          }
        }
        await db.close?.();
      });

      beforeEach(async () => {
        for (const table of TABLES) {
          await db.query(`DELETE FROM ${table}`);
        }
      });

      it('both tenants keep their own "U13" league; tenant A keeps its id and teams', async () => {
        const a = await withTenant({ tenantId: TENANT_A }, () =>
          leagues.create({ name: 'U13' }),
        );
        const broncos = await withTenant({ tenantId: TENANT_A }, () =>
          teams.create({ name: 'Broncos', leagueId: a.id as string }),
        );
        const b = await withTenant({ tenantId: TENANT_B }, () =>
          leagues.create({ name: 'U13' }),
        );

        expect(a.tenantId).toBe(TENANT_A);
        expect(b.tenantId).toBe(TENANT_B);
        expect(b.id).not.toBe(a.id);

        const leagueRows = await rawRows(db, 'ludis_nk_leagues');
        expect(leagueRows).toHaveLength(2);
        expect(leagueRows.find((row) => row.id === a.id)?.tenant_id).toBe(
          TENANT_A,
        );
        const [teamRow] = await rawRows(db, 'ludis_nk_teams');
        expect(teamRow.id).toBe(broncos.id);
        expect(teamRow.league_id).toBe(a.id);

        const seenByA = await withTenant({ tenantId: TENANT_A }, () =>
          leagues.list({}),
        );
        expect(seenByA.map((league) => league.id)).toEqual([a.id]);
      });

      it('a repeated same-tenant create still dedups in place and keeps the id', async () => {
        const first = await withTenant({ tenantId: TENANT_A }, () =>
          leagues.create({ name: 'U13' }),
        );
        const again = await withTenant({ tenantId: TENANT_A }, () =>
          leagues.create({ name: 'U13' }),
        );
        expect(again.id).toBe(first.id);
        expect(await rawRows(db, 'ludis_nk_leagues')).toHaveLength(1);
      });

      it('with the pre-migration global key, tenant B is refused instead of taking over tenant A', async () => {
        const a = await withTenant({ tenantId: TENANT_A }, () =>
          legacy.create({ name: 'U13' }),
        );
        const error = await withTenant({ tenantId: TENANT_B }, () =>
          legacy.create({ name: 'U13' }),
        ).then(
          () => null,
          (caught: unknown) => caught,
        );
        expect(error).toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });
        expect(String((error as Error).message)).not.toContain(TENANT_A);

        const rows = await rawRows(db, 'ludis_nk_legacy_leagues');
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(a.id);
        expect(rows[0].tenant_id).toBe(TENANT_A);
      });

      it('system context cannot take over a tenant row through the natural key either', async () => {
        await withTenant({ tenantId: TENANT_A }, () =>
          legacy.create({ name: 'U15' }),
        );
        await expect(
          withSystemContext(() =>
            legacy.create({ name: 'U15', tenantId: TENANT_B }),
          ),
        ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });
      });

      it('under system context the guard still refuses a global save over a tenant row and adopts a same-owner row', async () => {
        const a = await withTenant({ tenantId: TENANT_A }, () =>
          legacy.create({ name: 'U17' }),
        );
        // NULL is an owner: a system-context global save never adopts A's row.
        await expect(
          withSystemContext(() =>
            legacy.create({ name: 'U17', tenantId: null }),
          ),
        ).rejects.toMatchObject({ code: 'TENANT_ISOLATION_VIOLATION' });
        // The same owner, written from system context, updates in place.
        const again = await withSystemContext(() =>
          legacy.create({ name: 'U17', tenantId: TENANT_A }),
        );
        expect(again.id).toBe(a.id);
        const rows = await rawRows(db, 'ludis_nk_legacy_leagues');
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(a.id);
        expect(rows[0].tenant_id).toBe(TENANT_A);
      });

      it('with the tenant-led key a system-context global row is a separate row, by design', async () => {
        const a = await withTenant({ tenantId: TENANT_A }, () =>
          leagues.create({ name: 'U19' }),
        );
        const global = await withSystemContext(() =>
          leagues.create({ name: 'U19', tenantId: null }),
        );
        expect(global.id).not.toBe(a.id);
        const rows = await rawRows(db, 'ludis_nk_leagues');
        expect(rows).toHaveLength(2);
        expect(rows.find((row) => row.id === a.id)?.tenant_id).toBe(TENANT_A);
        expect(rows.find((row) => row.id === global.id)?.tenant_id).toBeNull();
      });

      it('audits runtime registrations against the model', () => {
        registerTenantScopedClass('LudisNkMismatched', {
          ...LUDIS_POLICY,
          field: 'ownerTenantId',
        });
        const findings = auditTenantScopedRegistrations().filter((finding) =>
          finding.selector.startsWith('LudisNk'),
        );
        const kinds = (selector: string) =>
          findings
            .filter((finding) => finding.selector === selector)
            .map((finding) => finding.kind)
            .sort();

        expect(kinds('LudisNkLeague')).toEqual(['undeclared_tenant_scope']);
        expect(kinds('LudisNkLegacyLeague')).toEqual([
          'natural_key_not_tenant_scoped',
          'undeclared_tenant_scope',
        ]);
        expect(kinds('LudisNkMismatched')).toEqual(['missing_tenant_field']);
        expect(
          findings.find((finding) => finding.kind === 'missing_tenant_field')
            ?.severity,
        ).toBe('error');
      });
    },
  );
}
