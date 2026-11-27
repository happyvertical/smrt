/**
 * Guest creates through an opted-in run-time model (#5196, #5197): the
 * ceiling's slug-to-model map feeds the same admission and pipeline a
 * declared model uses, and a run-time model that was not named stays out.
 */

import {
  createGuestRequestPrincipal,
  createGuestRuntime,
  getTestDatabase,
  guestCreateAdmission,
  handleGuestCreate,
  ObjectRegistry,
  registerRuntimeModel,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generatePostgresPermissionSql,
  guestSlugTargets,
} from '../services/index.js';

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

describe('guest create through a run-time model (#5196)', () => {
  let db: DatabaseInterface;
  let collection = '';
  let qualified = '';
  let table = '';
  const audits: unknown[] = [];

  beforeEach(async () => {
    audits.length = 0;
    registerRuntimeModel({
      name: 'RtContact5196',
      packageName: '@test/rtcontact5196',
      collection: undefined,
      tenantScoped: true,
      fields: { name: { type: 'text' }, message: { type: 'text' } },
    } as never);
    const registered = ObjectRegistry.findClassesByName('RtContact5196')[0];
    expect(registered.runtimeModel).toBe(true);
    qualified = registered.qualifiedName as string;
    collection = registered.collection as string;
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [qualified],
    });
    table = new (
      registered.constructor as new (
        o: unknown,
      ) => { tableName: string }
    )({
      db,
    }).tableName;
  });
  afterEach(async () => {
    if (typeof db.close === 'function') await db.close();
  });

  function principal(runtimeModels: string[]) {
    const targets = generatePostgresPermissionSql({ db }).targets;
    const slugs = [`${collection}.create`];
    const admitted = guestSlugTargets(
      slugs,
      {
        collections: [collection],
        createCollections: [collection],
        runtimeModels,
      },
      targets,
    );
    const permissions = [...admitted.keys()];
    const runtime = createGuestRuntime({
      createFields: { [collection]: { allowedFields: ['name', 'message'] } },
      auditWriter: async (entry) => {
        audits.push(entry);
      },
    });
    return {
      tenantId: 't1',
      permissions,
      guestPrincipal: createGuestRequestPrincipal({
        tenantId: 't1',
        permissions,
        runtime,
        slugModels: [...admitted].map(
          ([slug, target]) => [slug, target.qualifiedName as string] as const,
        ),
      }),
    };
  }

  const post = (
    locals: ReturnType<typeof principal>,
    body: Record<string, unknown>,
  ) => {
    const admission = guestCreateAdmission(
      locals,
      qualified,
      collection,
      false,
      qualified,
    );
    if (!admission) return null;
    return handleGuestCreate({
      admission,
      request: new Request('http://t1.test/', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
      db: db as never,
      tableName: table,
      getClientAddress: () => '9.9.9.9',
    });
  };

  it('creates through an opted-in run-time model: empty 201, audited, tenant-bound', async () => {
    const res = await post(principal([qualified]), {
      name: 'Ada',
      message: 'hi',
      tenant_id: 'other',
    });
    expect(res?.status).toBe(201);
    expect(await res?.text()).toBe('');
    const [row] = rowsOf(await db.query(`SELECT * FROM ${table}`));
    expect(row).toMatchObject({ tenant_id: 't1', name: 'Ada', message: 'hi' });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ callerKind: 'guest', tenantId: 't1' });
  });

  it('refuses a run-time model the app did not opt in', async () => {
    const locals = principal([]);
    // The ceiling dropped the slug, so the guest holds nothing and no route
    // admits it.
    expect(locals.permissions).toEqual([]);
    expect(post(locals, { name: 'Ada' })).toBeNull();
    // Even if a host handed over the slug, there is no admitted model for it.
    const forged = {
      tenantId: 't1',
      permissions: [`${collection}.create`],
      guestPrincipal: createGuestRequestPrincipal({
        tenantId: 't1',
        permissions: [`${collection}.create`],
        runtime: locals.guestPrincipal.runtime,
      }),
    };
    expect(post(forged as never, { name: 'Ada' })).toBeNull();
    expect(rowsOf(await db.query(`SELECT * FROM ${table}`))).toHaveLength(0);
  });
});
