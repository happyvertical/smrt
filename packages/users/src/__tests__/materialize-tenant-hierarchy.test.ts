/**
 * smrt#3036: the idempotent backfill behind
 * `smrt db:materialize-tenant-hierarchy`.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TenantCollection } from '../collections/TenantCollection.js';
import {
  materializeTenantHierarchy,
  TenantHierarchyMaterializationError,
} from '../migrations/materializeTenantHierarchy.js';
import {
  MAX_TENANT_HIERARCHY_DEPTH,
  planTenantHierarchy,
  type TenantHierarchyRow,
} from '../models/tenant-hierarchy.js';

function row(
  id: string,
  parentTenantId: string | null,
  hierarchyPath: string | null = '',
  hierarchyLevel: number | null = 0,
): TenantHierarchyRow {
  return { id, parentTenantId, hierarchyPath, hierarchyLevel };
}

describe('planTenantHierarchy', () => {
  it('derives every path from the parent graph, in any row order', () => {
    const plan = planTenantHierarchy([
      row('desk', 'pub'),
      row('pub', 'net'),
      row('net', null),
      row('sib', 'net'),
    ]);
    expect(plan.total).toBe(4);
    expect(plan.problems).toEqual([]);
    expect(
      plan.changes.map(({ id, hierarchyPath, hierarchyLevel }) => ({
        id,
        hierarchyPath,
        hierarchyLevel,
      })),
    ).toEqual([
      { id: 'desk', hierarchyPath: 'net/pub', hierarchyLevel: 2 },
      { id: 'pub', hierarchyPath: 'net', hierarchyLevel: 1 },
      { id: 'sib', hierarchyPath: 'net', hierarchyLevel: 1 },
    ]);
  });

  it('reports nothing for an already-correct hierarchy (idempotence)', () => {
    const plan = planTenantHierarchy([
      row('net', null, '', 0),
      row('pub', 'net', 'net', 1),
      row('desk', 'pub', 'net/pub', 2),
    ]);
    expect(plan.changes).toEqual([]);
    expect(plan.problems).toEqual([]);
  });

  it('repairs a stale or forged path and a null level', () => {
    const plan = planTenantHierarchy([
      row('net', null, 'forged', null),
      row('pub', 'net', 'other', 1),
    ]);
    expect(plan.changes.map((change) => change.id)).toEqual(['net', 'pub']);
    expect(plan.changes[0]).toMatchObject({
      hierarchyPath: '',
      hierarchyLevel: 0,
      previousPath: 'forged',
      previousLevel: null,
    });
  });

  it('reports a missing parent for the orphan and everything below it', () => {
    const plan = planTenantHierarchy([
      row('net', null),
      row('orphan', 'ghost'),
      row('below', 'orphan'),
    ]);
    expect(plan.problems.map((problem) => [problem.id, problem.code])).toEqual([
      ['below', 'PARENT_NOT_FOUND'],
      ['orphan', 'PARENT_NOT_FOUND'],
    ]);
    expect(plan.changes).toEqual([]);
  });

  it('reports a cycle for every tenant that feeds into it', () => {
    const plan = planTenantHierarchy([
      row('a', 'b'),
      row('b', 'a'),
      row('tail', 'a'),
      row('fine', null),
    ]);
    expect(plan.problems.map((problem) => [problem.id, problem.code])).toEqual([
      ['a', 'CIRCULAR_REFERENCE'],
      ['b', 'CIRCULAR_REFERENCE'],
      ['tail', 'CIRCULAR_REFERENCE'],
    ]);
  });

  it('reports a tenant deeper than the limit', () => {
    const rows = [row('t0', null)];
    for (let level = 1; level <= MAX_TENANT_HIERARCHY_DEPTH; level++) {
      rows.push(row(`t${level}`, `t${level - 1}`));
    }
    const plan = planTenantHierarchy(rows);
    expect(plan.problems.map((problem) => problem.id)).toEqual([
      `t${MAX_TENANT_HIERARCHY_DEPTH}`,
    ]);
    expect(plan.problems[0].code).toBe('MAX_DEPTH_EXCEEDED');
  });
});

describe('materializeTenantHierarchy (SQLite)', () => {
  let dbPath: string | undefined;

  afterEach(() => {
    if (dbPath && existsSync(dbPath)) rmSync(dbPath, { force: true });
    dbPath = undefined;
  });

  it('dry-runs, applies, and is a no-op on the second run', async () => {
    dbPath = join(tmpdir(), `smrt-materialize-${randomUUID()}.db`);
    const tenants = await TenantCollection.create({
      db: { type: 'sqlite' as const, url: dbPath },
    });
    const network = await tenants.create({ name: 'Network' });
    const publication = await tenants.create({ name: 'Publication' });
    await tenants.db.query(
      'UPDATE tenants SET parent_tenant_id = ? WHERE id = ?',
      network.id,
      publication.id,
    );

    const dry = await materializeTenantHierarchy(tenants.db, { dryRun: true });
    expect(dry.applied).toBe(false);
    expect(dry.changes.map((change) => change.id)).toEqual([publication.id]);
    expect(
      (await tenants.get({ id: publication.id as string }))?.hierarchyPath,
    ).toBe('');

    const applied = await materializeTenantHierarchy(tenants.db);
    expect(applied.applied).toBe(true);
    expect(applied.changes).toHaveLength(1);
    const reloaded = await tenants.get({ id: publication.id as string });
    expect(reloaded?.hierarchyPath).toBe(network.id);
    expect(reloaded?.hierarchyLevel).toBe(1);

    const again = await materializeTenantHierarchy(tenants.db);
    expect(again.changes).toEqual([]);
  });

  it('refuses a database that cannot run the write in one transaction', async () => {
    const db = {
      query: async () => ({ rows: [] }),
    } as unknown as Parameters<typeof materializeTenantHierarchy>[0];
    await expect(materializeTenantHierarchy(db)).rejects.toThrow(
      /requires a database with transaction\(\)/,
    );
    await expect(
      materializeTenantHierarchy(db, { dryRun: true }),
    ).resolves.toMatchObject({ applied: false, total: 0 });
  });

  it('refuses an unsafe table name', async () => {
    dbPath = join(tmpdir(), `smrt-materialize-${randomUUID()}.db`);
    const tenants = await TenantCollection.create({
      db: { type: 'sqlite' as const, url: dbPath },
    });
    await expect(
      materializeTenantHierarchy(tenants.db, {
        tableName: 'tenants; DROP TABLE users',
      }),
    ).rejects.toThrow(/Invalid tenant table name/);
  });

  it('writes nothing while any chain is broken', async () => {
    dbPath = join(tmpdir(), `smrt-materialize-${randomUUID()}.db`);
    const tenants = await TenantCollection.create({
      db: { type: 'sqlite' as const, url: dbPath },
    });
    const network = await tenants.create({ name: 'Network' });
    const fixable = await tenants.create({ name: 'Fixable' });
    const a = await tenants.create({ name: 'A' });
    const b = await tenants.create({ name: 'B' });
    for (const [parent, child] of [
      [network.id, fixable.id],
      [b.id, a.id],
      [a.id, b.id],
    ]) {
      await tenants.db.query(
        'UPDATE tenants SET parent_tenant_id = ? WHERE id = ?',
        parent,
        child,
      );
    }

    const dry = await materializeTenantHierarchy(tenants.db, { dryRun: true });
    expect(dry.problems.map((problem) => problem.code)).toEqual([
      'CIRCULAR_REFERENCE',
      'CIRCULAR_REFERENCE',
    ]);

    const error = await materializeTenantHierarchy(tenants.db).catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TenantHierarchyMaterializationError);
    expect(
      (error as TenantHierarchyMaterializationError).problems,
    ).toHaveLength(2);
    expect(
      (await tenants.get({ id: fixable.id as string }))?.hierarchyPath,
    ).toBe('');
  });
});
