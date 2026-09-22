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

interface StatementCounts {
  permissionReads: number;
  rolePermissionReads: number;
  permissionWrites: number;
  rolePermissionWrites: number;
  changeFeedAppends: number;
}

/**
 * Open a sqlite handle that tallies the statements this guard is about — the
 * reads on `query()` and the row writes on `upsert()`, plus the change-feed
 * appends those writes produce.
 *
 * Counting at the handle is deliberate: it sees exactly what the database is
 * asked to do, with no assumption about which collection method produced it, so
 * the guard still holds if the seeding path is restructured. It also has to
 * wrap BOTH entry points, because `SmrtObject.save()` persists through
 * `db.upsert(table, ...)` rather than a SQL string on `query()` — a counter
 * watching only `query()` sees the reads and the change feed but not the row
 * writes themselves.
 *
 * Writes are counted because read amplification was only half of #3022. The
 * other half was a second `save()` after a `create()` that already persists,
 * which doubled the rows written and, with them, the change-feed appends
 * (18,544 -> 9,289 on the reporting consumer). A guard watching only SELECTs
 * stays green while that write doubling comes back.
 */
async function openCountingDatabase(label: string): Promise<{
  db: Awaited<ReturnType<typeof getDatabase>>;
  counts: StatementCounts;
}> {
  const dbPath = join(tmpdir(), `smrt-3022-${label}-${Date.now()}.db`);
  dbPaths.push(dbPath);
  const db = await getDatabase({ type: 'sqlite', url: dbPath });
  const counts: StatementCounts = {
    permissionReads: 0,
    rolePermissionReads: 0,
    permissionWrites: 0,
    rolePermissionWrites: 0,
    changeFeedAppends: 0,
  };

  const handle = db as unknown as Record<string, (...a: unknown[]) => unknown>;

  const originalQuery = handle.query.bind(handle);
  handle.query = async (...args: unknown[]) => {
    const normalized = String(args[0]).replace(/\s+/g, ' ').toLowerCase();
    if (normalized.startsWith('select')) {
      if (/ from permissions\b/.test(normalized)) counts.permissionReads += 1;
      if (/ from role_permissions\b/.test(normalized)) {
        counts.rolePermissionReads += 1;
      }
    } else if (/^insert into _smrt_changes\b/.test(normalized)) {
      counts.changeFeedAppends += 1;
    }
    return await originalQuery(...args);
  };

  const originalUpsert = handle.upsert.bind(handle);
  handle.upsert = async (...args: unknown[]) => {
    // `role_permissions` is checked first: it would also satisfy a loose match
    // on `permissions`.
    const table = String(args[0]);
    if (table === 'role_permissions') counts.rolePermissionWrites += 1;
    else if (table === 'permissions') counts.permissionWrites += 1;
    return await originalUpsert(...args);
  };

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

interface SeedOutcome {
  counts: StatementCounts;
  /** Permission rows `syncPermissionCatalog()` reports it created. */
  permissionsCreated: number;
  /** Grant rows `seedRolePermissions()` reports it added, across all roles. */
  grantsAdded: number;
}

async function seedWithCatalogSize(
  label: string,
  size: number,
): Promise<SeedOutcome> {
  customCatalogOfSize(size);
  const { db, counts } = await openCountingDatabase(label);
  const options = { db };

  const sync = await syncPermissionCatalog(options);

  const roles = await RoleCollection.create(options);
  await roles.seedSystemRoles();

  const rolePermissions = await RolePermissionCollection.create(options);
  const seeded = await rolePermissions.seedRolePermissions(undefined, {
    syncCatalog: false,
  });

  return {
    counts,
    permissionsCreated: sync.created.length,
    grantsAdded: Object.values(seeded.added).reduce(
      (total, slugs) => total + slugs.length,
      0,
    ),
  };
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
    expect(
      large.counts.permissionReads - small.counts.permissionReads,
    ).toBeLessThanOrEqual(2);
    expect(
      large.counts.rolePermissionReads - small.counts.rolePermissionReads,
    ).toBeLessThanOrEqual(2);
  });

  it('reads the permission catalog a bounded number of times', async () => {
    const { counts } = await seedWithCatalogSize('bounded', 200);

    // `syncPermissionCatalog()` reads the table once; `seedRolePermissions()`
    // reads it once more for its slug->id map. Everything else is per-role.
    expect(counts.permissionReads).toBeLessThanOrEqual(8);
    // One grant-set read per system role, not one read per (role, slug) pair.
    expect(counts.rolePermissionReads).toBeLessThanOrEqual(16);
  });

  /**
   * The write half of #3022. Read amplification was only part of it: a second
   * `save()` after a `create()` that already persists doubled the rows written
   * and, with them, the change-feed appends. Without this assertion the guard
   * above stays green while that doubling comes back.
   */
  it('writes each seeded row once, not twice', async () => {
    const outcome = await seedWithCatalogSize('writes', 200);

    expect(outcome.permissionsCreated).toBeGreaterThan(0);
    expect(outcome.grantsAdded).toBeGreaterThan(0);

    // One write per created row. The pre-fix path wrote each row twice — the
    // `create()`'s own persist and a redundant `save()` — so these bounds are
    // exactly what a reintroduced second write breaks.
    expect(outcome.counts.permissionWrites).toBeLessThanOrEqual(
      outcome.permissionsCreated,
    );
    expect(outcome.counts.rolePermissionWrites).toBeLessThanOrEqual(
      outcome.grantsAdded,
    );

    // And one change-feed append per row write. This is the counter that
    // actually dominated the consumer's wall clock, and it is asserted
    // separately so a future write path that bypasses `upsert()` cannot make
    // the doubling invisible again. The slack covers the handful of system
    // role rows seeded alongside the catalog.
    expect(outcome.counts.changeFeedAppends).toBeLessThanOrEqual(
      outcome.permissionsCreated + outcome.grantsAdded + 16,
    );
  });
});
