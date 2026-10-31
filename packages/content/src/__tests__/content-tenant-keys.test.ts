/**
 * Tenant-local natural keys for content contributors and governance
 * definitions (#3305 M1).
 *
 * `content_contributors` was keyed on `(email)` and the three governance
 * tables on `(key)`, installation-wide, although every row is tenant-owned
 * (optional mode: NULL tenant = global default). A second tenant could not
 * hold the same email or key: its save was arbitrated onto, or refused by,
 * the first tenant's row. The keys are now `(tenant_id, email)` and
 * `(tenant_id, key)`; lookups resolve within one tenant (governance falls
 * back to the global layer, contributors do not), and `db:migrate` replaces
 * the legacy narrower unique index without touching the rows.
 *
 * Runs on the generated schema from the package manifest: SQLite by default,
 * PostgreSQL (native UUID tenant columns) when `DATABASE_URL` is set.
 */

import { randomUUID } from 'node:crypto';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import {
  generateSchemaDiff,
  getSQLFromDiff,
} from '@happyvertical/smrt-core/migrations';
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Content } from '../content';
import { ContentContributorCollection } from '../content-contributors';
import {
  getEffectiveContentGovernanceConfig,
  resetContentGovernanceConfig,
} from '../content-governance';
import { ContentGovernanceAssignmentCollection } from '../content-governance-assignments';
import { ContentGovernancePolicyCollection } from '../content-governance-policies';
import { ContentGovernanceProfileCollection } from '../content-governance-profiles';
import { Contents } from '../contents';

const TABLES = {
  content_contributors: 'email',
  content_governance_policies: 'key',
  content_governance_profiles: 'key',
  content_governance_assignments: 'key',
} as const;

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  return ((result as { rows?: Row[] } | undefined)?.rows ?? []) as Row[];
}

async function selectRows(
  db: DatabaseInterface,
  table: string,
  where = '',
  params: unknown[] = [],
): Promise<Row[]> {
  return rowsOf(
    await db.query(
      `SELECT * FROM ${table} ${where} ORDER BY created_at, id`,
      ...params,
    ),
  );
}

describe('content tenant-local natural keys (#3305 M1)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const inA = <T>(fn: () => Promise<T>) =>
    withTenant({ tenantId: tenantA }, fn);
  const inB = <T>(fn: () => Promise<T>) =>
    withTenant({ tenantId: tenantB }, fn);

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Content',
        'ContentContributor',
        'ContentGovernanceAssignment',
        'ContentGovernancePolicy',
        'ContentGovernanceProfile',
        'Profile',
        'ProfileType',
      ],
      prefix: 'content-tenant-keys',
    });
    db = isolated.db as unknown as DatabaseInterface;
    resetContentGovernanceConfig();
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    resetContentGovernanceConfig();
    await isolated?.cleanup();
    isolated = undefined;
  });

  describe('generated schema', () => {
    it('leads every conflict key and its unique index with tenant_id', () => {
      const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
      for (const [table, column] of Object.entries(TABLES)) {
        const unique = (schemas[table]?.indexes ?? [])
          .filter((index) => index.unique)
          .map((index) => index.columns);
        expect(unique, table).toContainEqual(['tenant_id', column]);
        expect(unique, table).not.toContainEqual([column]);
      }
    });
  });

  describe('contributors', () => {
    it('lets two tenants hold the same normalized email as distinct rows', async () => {
      const contributors = await ContentContributorCollection.create({ db });
      const a = await inA(() =>
        contributors.findOrCreateByEmail({
          email: '  Writer@Example.COM ',
          name: 'A writer',
        }),
      );
      const b = await inB(() =>
        contributors.findOrCreateByEmail({
          email: 'writer@example.com',
          name: 'B writer',
        }),
      );

      expect(b.id).not.toBe(a.id);
      const rows = await selectRows(db, 'content_contributors');
      expect(
        rows.map((row) => [String(row.tenant_id), row.email, row.name]).sort(),
      ).toEqual(
        [
          [tenantA, 'writer@example.com', 'A writer'],
          [tenantB, 'writer@example.com', 'B writer'],
        ].sort(),
      );
      // Each contributor links a profile of its own tenant.
      const profiles = await selectRows(db, 'profiles');
      const profileTenant = (id: unknown) =>
        String(profiles.find((p) => p.id === id)?.tenant_id);
      expect(profileTenant(a.profileId)).toBe(tenantA);
      expect(profileTenant(b.profileId)).toBe(tenantB);
    });

    it('returns the same row on a same-tenant retry, whether by context or explicit tenant', async () => {
      const contributors = await ContentContributorCollection.create({ db });
      const first = await inA(() =>
        contributors.findOrCreateByEmail({ email: 'retry@example.com' }),
      );
      const byContext = await inA(() =>
        contributors.findOrCreateByEmail({ email: 'RETRY@example.com' }),
      );
      const byExplicitTenant = await contributors.findOrCreateByEmail({
        email: 'retry@example.com',
        tenantId: tenantA,
      });

      expect(byContext.id).toBe(first.id);
      expect(byExplicitTenant.id).toBe(first.id);
      expect(
        await selectRows(db, 'content_contributors', 'WHERE email = ?', [
          'retry@example.com',
        ]),
      ).toHaveLength(1);
    });

    it('keeps one global contributor per email and never hands it to a tenant', async () => {
      const contributors = await ContentContributorCollection.create({ db });
      const global = await contributors.findOrCreateByEmail({
        email: 'global@example.com',
      });
      const globalRetry = await contributors.findOrCreateByEmail({
        email: 'global@example.com',
      });
      expect(globalRetry.id).toBe(global.id);
      expect(global.tenantId ?? null).toBeNull();

      expect(
        await inA(() => contributors.getByEmail('global@example.com')),
      ).toBeNull();
      const tenantRow = await inA(() =>
        contributors.findOrCreateByEmail({ email: 'global@example.com' }),
      );
      expect(tenantRow.id).not.toBe(global.id);
      expect(tenantRow.tenantId).toBe(tenantA);
      expect((await contributors.getByEmail('global@example.com'))?.id).toBe(
        global.id,
      );
    });

    it('never resolves or reuses another tenant row', async () => {
      const contributors = await ContentContributorCollection.create({ db });
      await inA(() =>
        contributors.findOrCreateByEmail({ email: 'only-a@example.com' }),
      );

      expect(
        await inB(() => contributors.getByEmail('only-a@example.com')),
      ).toBeNull();
      // No context and no tenant: global rows only.
      expect(await contributors.getByEmail('only-a@example.com')).toBeNull();
      // A system context does not widen the lookup to every tenant.
      expect(
        await withSystemContext(() =>
          contributors.getByEmail('only-a@example.com'),
        ),
      ).toBeNull();
      // An explicit foreign tenant under an active context fails closed.
      await expect(
        inB(() =>
          contributors.getByEmail('only-a@example.com', { tenantId: tenantA }),
        ),
      ).rejects.toThrow(/isolation/i);
      expect(
        (
          await contributors.getByEmail('only-a@example.com', {
            tenantId: tenantA,
          })
        )?.tenantId,
      ).toBe(tenantA);
    });
  });

  describe('governance definitions', () => {
    it('lets tenants override a global key without colliding with each other', async () => {
      const policies = await ContentGovernancePolicyCollection.create({ db });
      const save = async (tenantId: string | null, label: string) => {
        const policy = await policies.create({
          key: 'house-style',
          label,
          kind: 'custom',
          instructions: label,
          tenantId,
        });
        await policy.save();
        return policy;
      };
      const global = await withSystemContext(() => save(null, 'Global style'));
      const a = await inA(() => save(tenantA, 'A style'));
      const b = await inB(() => save(tenantB, 'B style'));
      // Same-tenant and global retries upsert in place.
      const aRetry = await inA(() => save(tenantA, 'A style v2'));
      const globalRetry = await withSystemContext(() =>
        save(null, 'Global style v2'),
      );

      expect(new Set([global.id, a.id, b.id]).size).toBe(3);
      expect(aRetry.id).toBe(a.id);
      expect(globalRetry.id).toBe(global.id);
      const rows = await selectRows(
        db,
        'content_governance_policies',
        'WHERE key = ?',
        ['house-style'],
      );
      expect(rows).toHaveLength(3);

      const label = async (fn: () => Promise<{ label?: string } | null>) =>
        (await fn())?.label;
      expect(
        await label(() => inA(() => policies.getByKey('house-style'))),
      ).toBe('A style v2');
      expect(
        await label(() => inB(() => policies.getByKey('house-style'))),
      ).toBe('B style');
      expect(await label(() => policies.getByKey('house-style'))).toBe(
        'Global style v2',
      );
      expect(
        await label(() =>
          withSystemContext(() => policies.getByKey('house-style')),
        ),
      ).toBe('Global style v2');
      expect(
        await label(() =>
          withSystemContext(() =>
            policies.getByKey('house-style', { tenantId: tenantB }),
          ),
        ),
      ).toBe('B style');
      await expect(
        inA(() => policies.getByKey('house-style', { tenantId: tenantB })),
      ).rejects.toThrow(/isolation/i);

      // The merged config keeps the layers apart: each tenant sees its own
      // override; a system context sees only the global layer.
      const effectiveLabel = async (tenantId?: string | null) =>
        (
          await getEffectiveContentGovernanceConfig({ db, tenantId })
        ).policies.find((policy) => policy.key === 'house-style')?.label;
      expect(await effectiveLabel(tenantA)).toBe('A style v2');
      expect(await effectiveLabel(tenantB)).toBe('B style');
      expect(await effectiveLabel(null)).toBe('Global style v2');
      expect(await withSystemContext(() => effectiveLabel())).toBe(
        'Global style v2',
      );
    });

    it('resolves profiles and assignments per tenant with global fallback', async () => {
      const profiles = await ContentGovernanceProfileCollection.create({ db });
      const assignments = await ContentGovernanceAssignmentCollection.create({
        db,
      });
      await inA(async () => {
        const profile = await profiles.create({
          key: 'desk',
          label: 'A desk',
          requirements: [],
        });
        await profile.save();
      });
      await withSystemContext(async () => {
        const profile = await profiles.create({
          key: 'desk',
          label: 'Global desk',
          requirements: [],
        });
        await profile.save();
        const assignment = await assignments.create({
          contentType: 'article',
          enabled: true,
          publicationProfileKey: 'desk',
        });
        await assignment.save();
      });
      await inB(async () => {
        const assignment = await assignments.create({
          contentType: 'article',
          contentVariant: 'opinion',
          enabled: true,
          publicationProfileKey: 'desk',
        });
        await assignment.save();
      });

      expect((await inA(() => profiles.getByKey('desk')))?.label).toBe(
        'A desk',
      );
      expect((await inB(() => profiles.getByKey('desk')))?.label).toBe(
        'Global desk',
      );
      // Key bytes are unchanged: `type::variant`.
      expect(
        (
          await inB(() =>
            assignments.resolveForContent({
              contentType: 'article',
              contentVariant: 'opinion',
            }),
          )
        )?.key,
      ).toBe('article::opinion');
      const forA = await inA(() =>
        assignments.resolveForContent({
          contentType: 'article',
          contentVariant: 'opinion',
        }),
      );
      expect(forA?.key).toBe('article::');
      expect(forA?.tenantId ?? null).toBeNull();
    });

    it('refuses to delete a global row a tenant still relies on', async () => {
      const policies = await ContentGovernancePolicyCollection.create({ db });
      const profiles = await ContentGovernanceProfileCollection.create({ db });
      const assignments = await ContentGovernanceAssignmentCollection.create({
        db,
      });
      const globalPolicy = await withSystemContext(async () => {
        const policy = await policies.create({
          key: 'legal-check',
          label: 'Legal',
        });
        await policy.save();
        return policy;
      });
      const globalProfile = await withSystemContext(async () => {
        const profile = await profiles.create({
          key: 'legal-desk',
          label: 'Legal desk',
          requirements: [],
        });
        await profile.save();
        return profile;
      });
      await inA(async () => {
        const profile = await profiles.create({
          key: 'a-desk',
          requirements: [{ policyKey: 'legal-check', label: 'Legal' }],
        });
        await profile.save();
        const assignment = await assignments.create({
          contentType: 'article',
          enabled: true,
          publicationProfileKey: 'legal-desk',
        });
        await assignment.save();
      });

      await expect(
        withSystemContext(() => globalPolicy.delete()),
      ).rejects.toThrow(
        new RegExp(`referenced by profiles: ${tenantA}:a-desk`),
      );
      await expect(
        withSystemContext(() => globalProfile.delete()),
      ).rejects.toThrow(
        new RegExp(`referenced by assignments: ${tenantA}:article::`),
      );

      // Another tenant's context learns only that references exist.
      await expect(inB(() => globalProfile.delete())).rejects.toThrow(
        /referenced by assignments: 1 tenant definition\(s\)$/,
      );

      // Once tenant A overrides the key, the global row is no longer relied on.
      await inA(async () => {
        const override = await policies.create({
          key: 'legal-check',
          label: 'A legal',
        });
        await override.save();
      });
      await expect(
        withSystemContext(() => globalPolicy.delete()),
      ).resolves.toBeUndefined();
    });

    it('reports the tenant override as the effective definition and its id', async () => {
      const policies = await ContentGovernancePolicyCollection.create({ db });
      await withSystemContext(async () => {
        const policy = await policies.create({ key: 'house', label: 'Global' });
        await policy.save();
      });
      const override = await inA(async () => {
        const policy = await policies.create({ key: 'house', label: 'A' });
        await policy.save();
        return policy;
      });
      const contents = await Contents.create({ db });
      const definitions = await inA(() =>
        contents.getGovernanceDefinitionsAction(),
      );
      const house = definitions.effective.policies.find(
        (policy) => policy.key === 'house',
      ) as { id?: string; label?: string; tenantId?: string | null };
      expect(house.label).toBe('A');
      expect(house.id).toBe(override.id);
      expect(house.tenantId).toBe(tenantA);
    });

    it('fails closed when a tenant context asks for another tenant definitions', async () => {
      await expect(
        inA(() =>
          getEffectiveContentGovernanceConfig({ db, tenantId: tenantB }),
        ),
      ).rejects.toThrow(/isolation/i);
      await expect(
        inA(() =>
          getEffectiveContentGovernanceConfig({ db, tenantId: tenantA }),
        ),
      ).resolves.toBeDefined();
    });

    it('limits the persisted-assignment probe to the content tenant and the global layer', async () => {
      const assignments = await ContentGovernanceAssignmentCollection.create({
        db,
      });
      await inB(async () => {
        const assignment = await assignments.create({
          contentType: 'article',
          enabled: true,
        });
        await assignment.save();
      });

      const probe = (tenantId: string | null) => {
        const content = new Content({ type: 'article' });
        content.tenantId = tenantId;
        (content as unknown as { _db: DatabaseInterface })._db = db;
        return (
          content as unknown as {
            hasPersistedGovernanceAssignments(): Promise<boolean>;
          }
        ).hasPersistedGovernanceAssignments();
      };
      expect(await probe(tenantB)).toBe(true);
      expect(await probe(tenantA)).toBe(false);
      expect(await probe(null)).toBe(false);
    });
  });
});

type Engine = 'sqlite' | 'duckdb' | 'postgres';
const ENGINES: Engine[] = process.env.DATABASE_URL
  ? ['sqlite', 'duckdb', 'postgres']
  : ['sqlite', 'duckdb'];

/**
 * `smrt db:migrate` over a deployment still carrying the pre-#3305 global
 * unique indexes. Runs on its own committed database per engine (not the
 * transaction-isolated handle, which has no catalog reader), with the
 * schema generated from the registered models.
 */
describe.each(
  ENGINES,
)('db:migrate from the legacy global keys on %s (#3305 M1)', (engine) => {
  let admin: DatabaseInterface | undefined;
  let db: DatabaseInterface;
  let databaseName = '';
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const classes = [
    'ContentContributor',
    'ContentGovernanceAssignment',
    'ContentGovernancePolicy',
    'ContentGovernanceProfile',
  ];
  const saveContributor = async (
    contributors: ContentContributorCollection,
    tenantId: string,
  ) =>
    withTenant({ tenantId }, async () => {
      const contributor = await contributors.create({
        email: 'Legacy@Example.com',
        name: 'Legacy',
      });
      await contributor.save();
      return contributor;
    });

  beforeEach(async () => {
    if (engine === 'postgres') {
      const baseUrl = process.env.DATABASE_URL ?? '';
      admin = await getTestDatabase({
        type: 'postgres',
        url: baseUrl,
        classes: [],
        includeSystemTables: false,
      });
      databaseName = `content_keys_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await admin.query(`CREATE DATABASE ${databaseName}`);
      const url = new URL(baseUrl);
      url.pathname = `/${databaseName}`;
      db = await getTestDatabase({
        type: 'postgres',
        url: String(url),
        classes,
      });
    } else {
      db = await getTestDatabase({ type: engine, url: ':memory:', classes });
    }
    resetContentGovernanceConfig();
    enableTenancy();
  });

  afterEach(async () => {
    disableTenancy();
    await (db as { close?: () => Promise<void> } | undefined)?.close?.();
    if (databaseName) {
      await admin?.query(
        `DROP DATABASE IF EXISTS ${databaseName} WITH (FORCE)`,
      );
      databaseName = '';
    }
    await (admin as { close?: () => Promise<void> } | undefined)?.close?.();
    admin = undefined;
  });

  it('keeps same keys per tenant, one global row on retry, and fails closed on foreign reads', async () => {
    const policies = await ContentGovernancePolicyCollection.create({ db });
    const contributors = await ContentContributorCollection.create({ db });
    const savePolicy = (tenantId: string | null, label: string) => {
      const run = async () => {
        const policy = await policies.create({ key: 'shared', label });
        await policy.save();
        return policy;
      };
      return tenantId ? withTenant({ tenantId }, run) : withSystemContext(run);
    };
    const a = await savePolicy(tenantA, 'A');
    const b = await savePolicy(tenantB, 'B');
    const g = await savePolicy(null, 'G');
    const gRetry = await savePolicy(null, 'G2');
    expect(new Set([a.id, b.id, g.id]).size).toBe(3);
    expect(gRetry.id).toBe(g.id);
    expect(
      await selectRows(db, 'content_governance_policies', 'WHERE key = ?', [
        'shared',
      ]),
    ).toHaveLength(3);
    expect(
      (
        await withTenant({ tenantId: tenantA }, () =>
          policies.getByKey('shared'),
        )
      )?.label,
    ).toBe('A');
    expect((await policies.getByKey('shared'))?.label).toBe('G2');
    await expect(
      withTenant({ tenantId: tenantA }, () =>
        policies.getByKey('shared', { tenantId: tenantB }),
      ),
    ).rejects.toThrow(/isolation/i);

    const first = await saveContributor(contributors, tenantA);
    expect(
      await withTenant({ tenantId: tenantB }, () =>
        contributors.getByEmail('legacy@example.com'),
      ),
    ).toBeNull();
    expect((await saveContributor(contributors, tenantA)).id).toBe(first.id);
  });

  it('replaces the narrower unique index in place, preserving rows, and is then a no-op', async () => {
    const inA = <T>(fn: () => Promise<T>) =>
      withTenant({ tenantId: tenantA }, fn);
    const contributors = await ContentContributorCollection.create({ db });
    const policies = await ContentGovernancePolicyCollection.create({ db });
    const legacyContributor = await saveContributor(contributors, tenantA);
    const legacyPolicy = await withSystemContext(async () => {
      const policy = await policies.create({
        key: 'Legacy Key ✓',
        label: 'Legacy',
      });
      await policy.save();
      return policy;
    });
    const before = {
      contributors: await selectRows(db, 'content_contributors'),
      policies: await selectRows(db, 'content_governance_policies'),
    };

    // Re-create the pre-#3305 shape: the framework-named global unique.
    for (const [table, column] of Object.entries(TABLES)) {
      await db.query(`DROP INDEX IF EXISTS ${table}_tenant_id_${column}_idx`);
      await db.query(
        `CREATE UNIQUE INDEX ${table}_${column}_idx ON ${table} (${column})`,
      );
    }

    const all = ObjectRegistry.getAllSchemasAsDefinitions();
    const schemas = Object.fromEntries(
      Object.keys(TABLES).map((table) => [table, all[table]]),
    );
    const diff = await generateSchemaDiff(db, schemas, { engineHint: engine });
    const indexChanges = diff.changes
      .filter(
        (change) => change.type === 'add_index' || change.type === 'drop_index',
      )
      .map((change) => `${change.type}:${change.name}`)
      .sort();
    expect(indexChanges).toEqual(
      Object.entries(TABLES)
        .flatMap(([table, column]) => [
          `add_index:${table}_tenant_id_${column}_idx`,
          `drop_index:${table}_${column}_idx`,
        ])
        .sort(),
    );
    for (const statement of getSQLFromDiff(diff)) {
      await db.query(statement);
    }

    // Rows, ids, normalized emails and key bytes are untouched.
    expect(await selectRows(db, 'content_contributors')).toEqual(
      before.contributors,
    );
    expect(await selectRows(db, 'content_governance_policies')).toEqual(
      before.policies,
    );
    expect(
      (await inA(() => contributors.getByEmail('legacy@example.com')))?.id,
    ).toBe(legacyContributor.id);
    expect((await policies.getByKey('Legacy Key ✓'))?.id).toBe(legacyPolicy.id);

    // The widened key admits a second tenant and still fences one tenant.
    const second = await saveContributor(contributors, tenantB);
    expect(second.id).not.toBe(legacyContributor.id);
    // A same-tenant retry upserts onto the existing row.
    expect((await saveContributor(contributors, tenantA)).id).toBe(
      legacyContributor.id,
    );
    await expect(
      db.query(
        'INSERT INTO content_contributors (id, slug, context, created_at, updated_at, tenant_id, email) VALUES (?, ?, ?, ?, ?, ?, ?)',
        randomUUID(),
        'duplicate',
        '',
        new Date().toISOString(),
        new Date().toISOString(),
        tenantA,
        'legacy@example.com',
      ),
    ).rejects.toThrow(/unique|duplicate|constraint/i);

    const again = await generateSchemaDiff(db, schemas, { engineHint: engine });
    expect(
      again.changes.filter(
        (change) => change.type === 'add_index' || change.type === 'drop_index',
      ),
    ).toEqual([]);
  });
});
