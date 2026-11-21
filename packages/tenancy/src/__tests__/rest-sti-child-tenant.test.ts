/**
 * Runtime REST acts for the request's tenant on a tenant-scoped STI subtype
 * served through a base that is not tenant-scoped: an update, delete or sync
 * item on a subtype row owned by another tenant changes nothing.
 *
 * Real SQLite file, the real tenant interceptor and entry-point gate.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystemContext } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaa1';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbb2';
const ROW_A = 'aaaaaaaa-0000-4000-8000-0000000000a1';
const ROW_B = 'bbbbbbbb-0000-4000-8000-0000000000b1';

@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
})
class ChildTenantNote extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}
class ChildTenantNoteCollection extends SmrtCollection<ChildTenantNote> {
  static readonly _itemClass = ChildTenantNote;
}

@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
@TenantScoped({ mode: 'optional' })
class ChildTenantOwnedNote extends ChildTenantNote {
  @tenantId({ nullable: true })
  tenantId: string | null = null;
}

const SESSIONS: Record<string, { tenantId?: string }> = {
  'user-of-a': { tenantId: TENANT_A },
};
const sessionOf = (req: Request) =>
  SESSIONS[(req.headers.get('authorization') ?? '').replace('Bearer ', '')];

describe('runtime REST, a tenant-scoped subtype through an unscoped base', () => {
  let dir: string;
  let db: DatabaseInterface;
  let notes: ChildTenantNoteCollection;
  let handler: (req: Request) => Promise<Response>;
  const segment = () =>
    ObjectRegistry.getClass('ChildTenantNote')?.collection as string;
  const ownedKey = () => {
    const info = ObjectRegistry.getClass('ChildTenantOwnedNote');
    return info?.qualifiedName || 'ChildTenantOwnedNote';
  };

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'ChildTenantNote',
      ChildTenantNoteCollection as never,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-sti-child-tenant-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: ['ChildTenantNote', 'ChildTenantOwnedNote'],
    });
    notes = await ChildTenantNoteCollection.create({ db });
    enableTenancy();
    const api = new APIGenerator({
      basePath: '/api',
      authMiddleware: () => async (req) =>
        sessionOf(req) ? req : new Response('unauthorized', { status: 401 }),
      resolveTenant: (req) => ({ tenantId: sessionOf(req)?.tenantId }),
    });
    api.registerCollection(segment(), notes as never);
    handler = api.generateHandler();
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      await db.query(`DELETE FROM ${notes.tableName}`);
      await notes.create({
        id: ROW_A,
        title: 'owned by a',
        tenantId: TENANT_A,
        _meta_type: ownedKey(),
      } as never);
      await notes.create({
        id: ROW_B,
        title: 'owned by b',
        tenantId: TENANT_B,
        _meta_type: ownedKey(),
      } as never);
    });
  });

  afterAll(async () => {
    disableTenancy();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const titles = async () =>
    (
      await db.query(`SELECT title FROM ${notes.tableName} ORDER BY title`)
    ).rows.map((row) => row.title);
  const call = (method: string, path: string, body?: unknown) =>
    handler(
      new Request(`http://local/api/${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer user-of-a',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  it('an update of another tenant subtype row changes nothing', async () => {
    const response = await call('PUT', `${segment()}/${ROW_B}`, {
      title: 'changed by a',
    });
    expect(await titles()).toEqual(['owned by a', 'owned by b']);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('an update of the caller tenant subtype row is applied', async () => {
    const response = await call('PUT', `${segment()}/${ROW_A}`, {
      title: 'changed by a',
    });
    expect(response.status).toBe(200);
    expect(await titles()).toEqual(['changed by a', 'owned by b']);
  });

  it('a delete of another tenant subtype row changes nothing', async () => {
    const response = await call('DELETE', `${segment()}/${ROW_B}`);
    expect(await titles()).toEqual(['owned by a', 'owned by b']);
    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('a sync update of another tenant subtype row changes nothing', async () => {
    const response = await call('POST', 'sync/apply', {
      items: [
        {
          itemId: 'item-1',
          object: segment(),
          op: 'update',
          id: ROW_B,
          payload: { title: 'synced by a' },
        },
      ],
    });
    const body = (await response.json()) as {
      results: Array<{ status: string }>;
    };
    expect(await titles()).toEqual(['owned by a', 'owned by b']);
    expect(body.results[0]?.status).toBe('rejected');
  });
});
