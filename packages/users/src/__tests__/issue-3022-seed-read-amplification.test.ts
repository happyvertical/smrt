/**
 * Regression guard for issue #3022.
 *
 * The permission catalog is registry-derived, so it grows with every consumed
 * package's object and action surface. Cold bootstrap — `syncPermissionCatalog()`
 * followed by `seedRolePermissions()` — used to issue one `permissions` read per
 * catalog slug and one `role_permissions` read per (role, slug) pair, so its cost
 * scaled linearly with the catalog. That is why a consumer's first write went
 * from ~15s on 0.51.7 to ~26-30s on 0.51.11 with no change on its side: the
 * catalog grew ~60%, and a per-slug round trip turned that straight into ~60%
 * more wall clock.
 *
 * These tests pin the SHAPE, not a wall-clock number: seeding a catalog that is
 * an order of magnitude larger must not issue an order of magnitude more reads.
 * A future change that reintroduces a per-slug or per-pair probe fails here
 * instead of silently doubling a consumer's bootstrap again.
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import '../models/index.js';
import { RoleCollection } from '../collections/RoleCollection.js';
import { RolePermissionCollection } from '../collections/RolePermissionCollection.js';
import { syncPermissionCatalog } from '../services/index.js';

const dbPaths: string[] = [];

interface ReadCounts {
  permissionReads: number;
  rolePermissionReads: number;
}

/**
 * Open a sqlite handle whose `query()` tallies the reads this guard is about.
 *
 * Counting at the handle is deliberate: it sees exactly what the database is
 * asked to do, with no assumption about which collection method produced it, so
 * the guard still holds if the seeding path is restructured.
 */
async function openCountingDatabase(label: string): Promise<{
  db: Awaited<ReturnType<typeof getDatabase>>;
  counts: ReadCounts;
}> {
  const dbPath = join(tmpdir(), `smrt-3022-${label}-${Date.now()}.db`);
  dbPaths.push(dbPath);
  const db = await getDatabase({ type: 'sqlite', url: dbPath });
  const counts: ReadCounts = { permissionReads: 0, rolePermissionReads: 0 };
  const original = db.query.bind(db);
  (db as { query: typeof db.query }).query = (async (
    sql: string,
    ...rest: unknown[]
  ) => {
    const normalized = String(sql).replace(/\s+/g, ' ').toLowerCase();
    if (
      normalized.startsWith('select') &&
      / from permissions\b/.test(normalized)
    ) {
      counts.permissionReads += 1;
    }
    if (
      normalized.startsWith('select') &&
      / from role_permissions\b/.test(normalized)
    ) {
      counts.rolePermissionReads += 1;
    }
    return await (original as (...args: unknown[]) => Promise<unknown>)(
      sql,
      ...rest,
    );
  }) as typeof db.query;
  return { db, counts };
}

function customCatalogOfSize(size: number): void {
  setConfig({
    packages: {
      users: {
        permissions: {
          custom: Array.from({ length: size }, (_, index) => ({
            category: 'issue3022',
            description: `Generated permission ${index}`,
            name: `Generated ${index}`,
            slug: `issue3022.generated_${String(index).padStart(4, '0')}`,
          })),
        },
      },
    },
  });
}

async function seedWithCatalogSize(
  label: string,
  size: number,
): Promise<ReadCounts> {
  customCatalogOfSize(size);
  const { db, counts } = await openCountingDatabase(label);
  const options = { db };

  await syncPermissionCatalog(options);

  const roles = await RoleCollection.create(options);
  await roles.seedSystemRoles();

  const rolePermissions = await RolePermissionCollection.create(options);
  await rolePermissions.seedRolePermissions(undefined, {
    syncCatalog: false,
  });

  return counts;
}

describe('issue #3022: cold seeding must not read per catalog slug', () => {
  afterEach(() => {
    clearCache();
    setConfig({});
    for (const dbPath of dbPaths.splice(0)) {
      if (existsSync(dbPath)) {
        rmSync(dbPath, { force: true });
      }
    }
  });

  it('keeps read counts flat as the catalog grows tenfold', async () => {
    const small = await seedWithCatalogSize('small', 20);
    const large = await seedWithCatalogSize('large', 200);

    // The catalog grew by 180 slugs. A per-slug probe would show up here as
    // ~180 extra permission reads and ~180 extra reads per seeded role.
    expect(large.permissionReads - small.permissionReads).toBeLessThanOrEqual(
      2,
    );
    expect(
      large.rolePermissionReads - small.rolePermissionReads,
    ).toBeLessThanOrEqual(2);
  });

  it('reads the permission catalog a bounded number of times', async () => {
    const counts = await seedWithCatalogSize('bounded', 200);

    // `syncPermissionCatalog()` reads the table once; `seedRolePermissions()`
    // reads it once more for its slug->id map. Everything else is per-role.
    expect(counts.permissionReads).toBeLessThanOrEqual(8);
    // One grant-set read per system role, not one read per (role, slug) pair.
    expect(counts.rolePermissionReads).toBeLessThanOrEqual(16);
  });
});
