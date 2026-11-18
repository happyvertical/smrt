/**
 * A write refused because a row belongs to another tenant is a permission
 * denial on every transport, and says nothing about the other tenant.
 *
 * The save-time ownership check (and the tenancy interceptor) throws
 * `TenantIsolationError`, code `TENANT_ISOLATION_VIOLATION`, whose message
 * names tenants. Runtime REST and the emitted SvelteKit route answer 403
 * `permission_denied` / "Permission denied."; the MCP servers report the same
 * code and text; sync apply rejects the item `forbidden`, which clients do
 * not retry. The fixture model's save throws that error for one title, so the
 * transports are exercised without tenancy. Real SQLite file.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { TenantIsolationError } from '../errors.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import { normalizeTypedHttpError } from '../generators/typed-http-error.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { processSyncApplyBatch } from '../sync/apply.js';
import { getTestDatabase } from '../testing/database.js';
import {
  type EmittedProject,
  type EmittedToolResult,
  emitTransports,
} from './fixtures/emitted-transports.js';

const OTHER_TENANT = 'tenant-of-someone-else';
const FOREIGN_ID = '11111111-2222-4333-8444-555555555555';

const OTHER_TENANT_ROW = '22222222-3333-4444-8555-666666666666';
const TENANTLESS_ROW = '33333333-4444-4555-8666-777777777777';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
})
class IsolationNote extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  /** Stands in for the ownership check refusing another tenant's row. */
  async save(...args: Parameters<SmrtObject['save']>) {
    if (this.title === 'foreign') {
      throw new TenantIsolationError(
        `Tenant isolation violation: row is owned by '${OTHER_TENANT}'`,
        { attemptedTenantId: OTHER_TENANT },
      );
    }
    return super.save(...args);
  }
}
class IsolationNoteCollection extends SmrtCollection<IsolationNote> {
  static readonly _itemClass = IsolationNote;

  /**
   * Stands in for the tenancy interceptor refusing a lookup: a row another
   * tenant owns, and a required-mode model read with no tenant.
   */
  async get(...args: Parameters<SmrtCollection<IsolationNote>['get']>) {
    const [filter] = args;
    const id =
      typeof filter === 'string' ? filter : (filter as { id?: unknown })?.id;
    if (id === OTHER_TENANT_ROW) {
      throw new TenantIsolationError(
        `Tenant isolation violation: row is owned by '${OTHER_TENANT}'`,
      );
    }
    if (id === TENANTLESS_ROW) {
      throw Object.assign(new Error('Tenant context required'), {
        code: 'TENANT_CONTEXT_REQUIRED',
      });
    }
    return super.get(...args);
  }
}

const REFUSAL = {
  code: 'permission_denied',
  message: 'Permission denied.',
  ok: false,
  status: 403,
};

describe('tenant isolation refusals', () => {
  let dir: string;
  let db: DatabaseInterface;
  let notes: IsolationNoteCollection;
  let emitted: EmittedProject;
  let segment: string;
  let rest: (req: Request) => Promise<Response>;
  const tools: Record<string, (args: unknown) => Promise<EmittedToolResult>> =
    {};

  const titles = async () =>
    (await db.query(`SELECT title FROM ${notes.tableName}`)).rows.map(
      (row) => row.title,
    );
  const syncBatch = {
    items: [
      {
        itemId: 'item-1',
        object: '',
        op: 'create',
        id: FOREIGN_ID,
        payload: { title: 'foreign' },
      },
    ],
  };

  beforeAll(async () => {
    ObjectRegistry.registerCollection('IsolationNote', IsolationNoteCollection);
    dir = mkdtempSync(join(tmpdir(), 'smrt-isolation-'));
    const dbUrl = join(dir, 'app.db');
    db = await getTestDatabase({
      type: 'sqlite',
      url: dbUrl,
      classes: ['IsolationNote'],
    });
    notes = await IsolationNoteCollection.create({ db });
    segment = ObjectRegistry.getClass('IsolationNote')?.collection as string;
    syncBatch.items[0].object = segment;
    emitted = await emitTransports(['IsolationNote'], { db, dbUrl });
    rest = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db },
    ).generateHandler();
    const inProcess = new MCPGenerator({}, { db, user: { id: 'user-1' } });
    tools['in-process MCP'] = async (args) =>
      (await inProcess.handleToolCall({
        method: 'tools/call',
        params: {
          name: 'isolationnote_create',
          arguments: args as Record<string, unknown>,
        },
      })) as EmittedToolResult;
    for (const [name, modular] of [
      ['emitted MCP server (single file)', false],
      ['emitted MCP server (modular)', true],
    ] as const) {
      const server = await emitted.mcp({ modular });
      tools[name] = (args) => server.call('isolationnote_create', args);
    }
  });

  afterAll(async () => {
    emitted?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('is rendered as a plain permission denial', () => {
    expect(
      normalizeTypedHttpError(new TenantIsolationError('owned by someone')),
    ).toEqual(REFUSAL);
  });

  it('keeps the public message an isolation error states for the caller', () => {
    const stated = Object.assign(new TenantIsolationError('owned by someone'), {
      status: 403,
      publicMessage: 'Scope is not permitted',
    });
    expect(normalizeTypedHttpError(stated)).toEqual({
      code: 'TENANT_ISOLATION_VIOLATION',
      message: 'Scope is not permitted',
      ok: false,
      status: 403,
    });
  });

  it('the emitted item route answers a refused lookup with 403', async () => {
    const locals = {
      user: { id: 'user-1' },
      permissions: [`${segment}.update`, `${segment}.delete`],
    };
    for (const [id, message] of [
      [OTHER_TENANT_ROW, 'Permission denied.'],
      [TENANTLESS_ROW, 'Tenant context required.'],
    ] as const) {
      for (const method of ['GET', 'PUT', 'DELETE']) {
        const result = await emitted.http(
          `${segment}/[id]/+server.ts`,
          method,
          {
            params: { id },
            body: method === 'PUT' ? { title: 'changed' } : undefined,
            locals,
          },
        );
        expect(result.status).toBe(403);
        expect(JSON.stringify(result.body)).toContain(message);
        expect(JSON.stringify(result.body)).not.toContain(OTHER_TENANT);
      }
    }
  });

  it('runtime REST answers 403 without naming the other tenant', async () => {
    const response = await rest(
      new Request(`http://local/api/${segment}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'foreign' }),
      }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: REFUSAL });
    expect(await titles()).toEqual([]);
  });

  it('the emitted SvelteKit route answers 403 without naming the other tenant', async () => {
    const result = await emitted.http(`${segment}/+server.ts`, 'POST', {
      body: { title: 'foreign' },
      locals: { user: { id: 'user-1' }, permissions: [`${segment}.create`] },
    });
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: REFUSAL });
    expect(await titles()).toEqual([]);
  });

  it.each([
    'in-process MCP',
    'emitted MCP server (single file)',
    'emitted MCP server (modular)',
  ])('%s reports a permission denial without naming the other tenant', async (name) => {
    const result = await tools[name]({ title: 'foreign' });
    expect(result.isError).toBe(true);
    expect(
      (result.structuredContent as { error?: unknown } | undefined)?.error,
    ).toEqual({ code: 'permission_denied', message: 'Permission denied.' });
    expect(JSON.stringify(result)).not.toContain(OTHER_TENANT);
    expect(await titles()).toEqual([]);
  });

  it('sync apply rejects the item as forbidden, on the runtime and emitted routes', async () => {
    const runtime = await rest(
      new Request('http://local/api/sync/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(syncBatch),
      }),
    );
    const routed = await emitted.http('sync/apply/+server.ts', 'POST', {
      body: syncBatch,
      locals: { user: { id: 'user-1' }, permissions: [`${segment}.create`] },
    });
    for (const body of [await runtime.json(), routed.body]) {
      expect(
        (body as { results: Array<Record<string, unknown>> }).results[0],
      ).toMatchObject({ status: 'rejected', reason: 'forbidden' });
      expect(JSON.stringify(body)).not.toContain(OTHER_TENANT);
    }
    expect(await titles()).toEqual([]);
  });

  it('the sync processor treats the refusal as final for any host', async () => {
    const outcome = await processSyncApplyBatch(syncBatch, {
      resolveTarget: async () => ({
        objectName: 'IsolationNote',
        collection: notes as never,
        isOpAllowed: () => true,
        authorize: async () => 'ok' as const,
        prepare: (payload) => payload as Record<string, unknown>,
      }),
    });
    expect(
      (outcome.body as unknown as { results: Array<Record<string, unknown>> })
        .results[0],
    ).toMatchObject({ status: 'rejected', reason: 'forbidden' });
  });
});
