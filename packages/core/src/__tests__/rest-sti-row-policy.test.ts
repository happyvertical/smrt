/**
 * Rows of a shared table (STI) obey their own model's policy through a base
 * route on runtime REST.
 *
 * - A create through the base that selects a subtype runs the subtype's
 *   authorization as well as the base's.
 * - A server given its models serves rows of the subtypes it was given only:
 *   list, count, get, update and delete through the base never reach a row of
 *   another subtype.
 * - An update or delete through the base of a subtype row needs the
 *   subtype's own action and authorization; sync items too.
 * - `createRestServer([Provider])` keeps serving a provider class an app
 *   replaced.
 * - OpenAPI offers only the create targets REST accepts.
 *
 * Real SQLite; nothing is mocked.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { APIGenerator, createRestServer } from '../generators/rest.js';
import { generateOpenAPISpec } from '../generators/swagger.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { setRuntimeExposureGate } from '../runtime-exposure.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';
import {
  type EmittedProject,
  emitTransports,
} from './fixtures/emitted-transports.js';

@smrt({
  tableStrategy: 'sti',
  api: {
    public: true,
    include: ['list', 'get', 'create', 'update', 'delete'],
  },
})
class RowPolicyDoc extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}
class RowPolicyDocCollection extends SmrtCollection<RowPolicyDoc> {
  static readonly _itemClass = RowPolicyDoc;
}

/** Not public: needs an authenticated caller on every operation. */
@smrt({ api: { include: ['list', 'get', 'create', 'update', 'delete'] } })
class RowPolicyPrivateDoc extends RowPolicyDoc {
  @field({ type: 'text' })
  note = '';
}

/** Public, read-only: no create, update or delete. */
@smrt({ api: { public: true, include: ['list', 'get'] } })
class RowPolicyReadOnlyDoc extends RowPolicyDoc {
  @field({ type: 'text' })
  note = '';
}

@smrt({
  packageName: '@row-policy-fixture/provider',
  collection: 'row-policy-replaced',
  api: { public: 'read' },
})
class RowPolicyReplaced extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}

const key = (name: string) => {
  const info = ObjectRegistry.getClass(name);
  if (!info) throw new Error(`fixture not registered: ${name}`);
  return info.qualifiedName || info.name;
};
const segment = () =>
  ObjectRegistry.getClass('RowPolicyDoc')?.collection as string;

function quietly<T>(start: () => T): T {
  const log = console.log;
  console.log = () => {};
  try {
    return start();
  } finally {
    console.log = log;
  }
}

async function serve(
  objects: Array<typeof SmrtObject>,
  db: DatabaseInterface,
  run: (port: number) => Promise<void>,
  authMiddleware: NonNullable<
    Parameters<typeof createRestServer>[2]
  >['authMiddleware'] = () => async (req) => req,
): Promise<void> {
  const { server } = quietly(() =>
    createRestServer(
      objects,
      { db },
      {
        port: 0,
        basePath: '/api',
        authMiddleware,
      },
    ),
  ) as { server: Server };
  try {
    if (!server.listening) {
      await new Promise<void>((resolve) => server.once('listening', resolve));
    }
    await run((server.address() as AddressInfo).port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('STI rows through a base route on runtime REST', () => {
  let db: DatabaseInterface;
  const ids: Record<string, string> = {};

  const rows = async () =>
    (
      await db.query('SELECT title, note FROM row_policy_docs ORDER BY title')
    ).rows.map((row) => `${row.title}:${row.note ?? ''}`);

  beforeEach(async () => {
    ObjectRegistry.registerCollection('RowPolicyDoc', RowPolicyDocCollection);
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['RowPolicyDoc', 'RowPolicyPrivateDoc', 'RowPolicyReadOnlyDoc'],
    });
    const docs = await RowPolicyDocCollection.create({ db });
    for (const [label, model] of [
      ['base', 'RowPolicyDoc'],
      ['private', 'RowPolicyPrivateDoc'],
      ['readonly', 'RowPolicyReadOnlyDoc'],
    ] as const) {
      const created = await docs.create({
        title: label,
        slug: `${label}-doc`,
        ...(model === 'RowPolicyDoc' ? {} : { note: 'n' }),
        _meta_type: key(model),
      } as never);
      ids[label] = created.id as string;
    }
  });
  afterEach(async () => {
    await db?.close?.();
  });

  const call = (
    handler: (req: Request) => Promise<Response>,
    method: string,
    path: string,
    body?: unknown,
  ) =>
    handler(
      new Request(`http://local/api/${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );

  describe('a create that selects a subtype', () => {
    it('needs the subtype authorization when the base is public', async () => {
      const handler = new APIGenerator(
        { basePath: '/api' },
        { db },
      ).generateHandler();
      const refused = await call(handler, 'POST', segment(), {
        title: 'anonymous child',
        note: 'x',
        createType: key('RowPolicyPrivateDoc'),
      });
      expect(refused.status).toBe(401);
      expect(
        (await call(handler, 'POST', segment(), { title: 'anonymous base' }))
          .status,
      ).toBe(201);
      expect(await rows()).not.toContain('anonymous child:x');
    });

    it('asks the auth middleware about the subtype', async () => {
      const asked: string[] = [];
      const handler = new APIGenerator(
        {
          basePath: '/api',
          authMiddleware: (name, action) => async (req) => {
            asked.push(`${name}/${action}`);
            return name === key('RowPolicyPrivateDoc')
              ? new Response('forbidden', { status: 403 })
              : req;
          },
        },
        { db },
      ).generateHandler();
      const refused = await call(handler, 'POST', segment(), {
        title: 'child',
        note: 'x',
        createType: key('RowPolicyPrivateDoc'),
      });
      expect(refused.status).toBe(403);
      expect(asked).toEqual([
        `${key('RowPolicyDoc')}/post`,
        `${key('RowPolicyPrivateDoc')}/post`,
      ]);
      expect(await rows()).not.toContain('child:x');
    });
  });

  describe('a server given only the base', () => {
    it('serves none of the subtype rows', async () => {
      await serve([RowPolicyDoc], db, async (port) => {
        const url = (path: string) => `http://127.0.0.1:${port}/api/${path}`;
        const listed = await (await fetch(url(segment()))).json();
        expect(
          (listed as Array<{ title: string }>).map((row) => row.title),
        ).toEqual(['base']);
        expect(await (await fetch(url(`${segment()}/count`))).json()).toEqual({
          count: 1,
        });
        for (const label of ['private', 'readonly']) {
          expect((await fetch(url(`${segment()}/${ids[label]}`))).status).toBe(
            404,
          );
          expect(
            (
              await fetch(url(`${segment()}/${ids[label]}`), {
                method: 'PUT',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ title: 'changed' }),
              })
            ).status,
          ).toBe(404);
          expect(
            (
              await fetch(url(`${segment()}/${ids[label]}`), {
                method: 'DELETE',
              })
            ).status,
          ).toBe(404);
        }
        const synced = (await (
          await fetch(url('sync/apply'), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              items: [
                {
                  itemId: 'item-1',
                  object: segment(),
                  op: 'update',
                  id: ids.private,
                  payload: { title: 'synced' },
                },
              ],
            }),
          })
        ).json()) as { results: unknown[] };
        expect(synced.results[0]).toMatchObject({
          status: 'rejected',
          reason: 'not_found',
        });
      });
      expect(await rows()).toEqual(['base:', 'private:n', 'readonly:n']);
    });

    it('asks its auth middleware and exposure gate about no model it does not serve', async () => {
      const asked: string[] = [];
      const exposed: string[] = [];
      setRuntimeExposureGate({
        isEnabled: (model) => {
          exposed.push(String(model.qualifiedName));
          return true;
        },
      });
      try {
        await serve(
          [RowPolicyDoc],
          db,
          async (port) => {
            const url = (path: string) =>
              `http://127.0.0.1:${port}/api/${path}`;
            const listed = await fetch(url(segment()));
            expect(listed.status).toBe(200);
            expect(
              ((await listed.json()) as Array<{ title: string }>).map(
                (row) => row.title,
              ),
            ).toEqual(['base']);
            expect((await fetch(url(`${segment()}/${ids.base}`))).status).toBe(
              200,
            );
          },
          (model) => async (req) => {
            asked.push(model);
            if (model !== key('RowPolicyDoc')) {
              throw new Error(`no policy configured for ${model}`);
            }
            return req;
          },
        );
      } finally {
        setRuntimeExposureGate(undefined);
      }
      expect(asked.length).toBeGreaterThan(0);
      for (const subtype of ['RowPolicyPrivateDoc', 'RowPolicyReadOnlyDoc']) {
        expect(asked).not.toContain(key(subtype));
        expect(exposed).not.toContain(key(subtype));
      }
    });

    it('answers a sync create on a subtype row it does not serve as an id conflict', async () => {
      await serve([RowPolicyDoc], db, async (port) => {
        const create = async (id: string, payload: Record<string, unknown>) =>
          (
            (await (
              await fetch(`http://127.0.0.1:${port}/api/sync/apply`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  items: [
                    {
                      itemId: 'item-1',
                      object: segment(),
                      op: 'create',
                      id,
                      payload,
                    },
                  ],
                }),
              })
            ).json()) as { results: Array<Record<string, unknown>> }
          ).results[0];
        const unserved = await create(ids.private, { title: 'private' });
        expect(unserved).toMatchObject({
          status: 'rejected',
          reason: 'id_conflict',
        });
        expect(unserved).not.toHaveProperty('updatedAt');
        // A served row's replay checks the payload before it is compared.
        expect(
          await create(ids.base, { title: 'base', notAField: 'y' }),
        ).toMatchObject({ status: 'rejected', reason: 'invalid_payload' });
        expect(await create(ids.base, { title: 'base' })).toMatchObject({
          status: 'applied',
        });
      });
      expect(await rows()).toEqual(['base:', 'private:n', 'readonly:n']);
    });

    it('finds a served row by its slug', async () => {
      await serve([RowPolicyDoc], db, async (port) => {
        const response = await fetch(
          `http://127.0.0.1:${port}/api/${segment()}/base-doc`,
        );
        expect(response.status).toBe(200);
        expect(((await response.json()) as { title: string }).title).toBe(
          'base',
        );
        expect(
          (await fetch(`http://127.0.0.1:${port}/api/${segment()}/private-doc`))
            .status,
        ).toBe(404);
      });
    });

    it('keeps a type filter of the caller within the served types', async () => {
      await serve([RowPolicyDoc, RowPolicyReadOnlyDoc], db, async (port) => {
        const url = (path: string, types: string[]) =>
          `http://127.0.0.1:${port}/api/${path}?_meta_type[in]=${types
            .map(encodeURIComponent)
            .join(',')}`;
        const titles = async (types: string[]) =>
          (
            (await (await fetch(url(segment(), types))).json()) as Array<{
              title: string;
            }>
          )
            .map((row) => row.title)
            .sort();
        const count = async (types: string[]) =>
          (
            (await (await fetch(url(`${segment()}/count`, types))).json()) as {
              count: number;
            }
          ).count;
        expect(await titles([key('RowPolicyReadOnlyDoc')])).toEqual([
          'readonly',
        ]);
        expect(await count([key('RowPolicyReadOnlyDoc')])).toBe(1);
        expect(await titles([key('RowPolicyPrivateDoc')])).toEqual([]);
        expect(await count([key('RowPolicyPrivateDoc')])).toBe(0);
        expect(
          await titles([key('RowPolicyDoc'), key('RowPolicyPrivateDoc')]),
        ).toEqual(['base']);
      });
    });

    it('serves the subtype rows of the subtypes it was given', async () => {
      await serve(
        [RowPolicyDoc, RowPolicyPrivateDoc, RowPolicyReadOnlyDoc],
        db,
        async (port) => {
          const listed = (await (
            await fetch(`http://127.0.0.1:${port}/api/${segment()}`)
          ).json()) as Array<{ title: string }>;
          expect(listed.map((row) => row.title).sort()).toEqual([
            'base',
            'private',
            'readonly',
          ]);
        },
      );
    });
  });

  describe('a read through a public base', () => {
    const titlesOf = async (response: Response) =>
      ((await response.json()) as Array<{ title: string }>)
        .map((row) => row.title)
        .sort();

    it('serves an anonymous caller none of a private subtype rows', async () => {
      const handler = new APIGenerator(
        { basePath: '/api' },
        { db },
      ).generateHandler();
      expect(await titlesOf(await call(handler, 'GET', segment()))).toEqual([
        'base',
        'readonly',
      ]);
      expect(
        await (await call(handler, 'GET', `${segment()}/count`)).json(),
      ).toEqual({ count: 2 });
      expect(
        (await call(handler, 'GET', `${segment()}/${ids.private}`)).status,
      ).toBe(404);
      expect(
        (await call(handler, 'GET', `${segment()}/${ids.readonly}`)).status,
      ).toBe(200);
    });

    it('serves none of the rows of a subtype the auth middleware refuses', async () => {
      const handler = new APIGenerator(
        {
          basePath: '/api',
          authMiddleware: (model) => async (req) =>
            model === key('RowPolicyPrivateDoc')
              ? new Response('forbidden', { status: 403 })
              : req,
        },
        { db },
      ).generateHandler();
      expect(await titlesOf(await call(handler, 'GET', segment()))).toEqual([
        'base',
        'readonly',
      ]);
      expect(
        (await call(handler, 'GET', `${segment()}/${ids.private}`)).status,
      ).toBe(404);
    });

    describe('with a subtype switched off for the request', () => {
      beforeEach(() => {
        setRuntimeExposureGate({
          isEnabled: (model) =>
            model.qualifiedName !== key('RowPolicyPrivateDoc'),
        });
      });
      afterEach(() => {
        setRuntimeExposureGate(undefined);
      });

      it('serves none of its rows and writes none of them', async () => {
        const handler = new APIGenerator(
          { basePath: '/api', authMiddleware: () => async (req) => req },
          { db },
        ).generateHandler();
        expect(await titlesOf(await call(handler, 'GET', segment()))).toEqual([
          'base',
          'readonly',
        ]);
        expect(
          await (await call(handler, 'GET', `${segment()}/count`)).json(),
        ).toEqual({ count: 2 });
        const path = `${segment()}/${ids.private}`;
        expect((await call(handler, 'GET', path)).status).toBe(404);
        expect(
          (await call(handler, 'PUT', path, { title: 'changed' })).status,
        ).toBe(404);
        expect((await call(handler, 'DELETE', path)).status).toBe(404);
        const synced = (await (
          await call(handler, 'POST', 'sync/apply', {
            items: [
              {
                itemId: 'item-1',
                object: segment(),
                op: 'update',
                id: ids.private,
                payload: { title: 'synced' },
              },
            ],
          })
        ).json()) as { results: unknown[] };
        expect(synced.results[0]).toMatchObject({
          status: 'rejected',
          reason: 'not_found',
        });
        expect(await rows()).toContain('private:n');
      });
    });
  });

  describe('an update or delete of a subtype row', () => {
    it('needs the subtype to allow the action', async () => {
      const handler = new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req) => req },
        { db },
      ).generateHandler();
      const path = `${segment()}/${ids.readonly}`;
      expect(
        (await call(handler, 'PUT', path, { title: 'changed' })).status,
      ).toBe(405);
      expect((await call(handler, 'DELETE', path)).status).toBe(405);
      const synced = (await (
        await call(handler, 'POST', 'sync/apply', {
          items: [
            {
              itemId: 'item-1',
              object: segment(),
              op: 'update',
              id: ids.readonly,
              payload: { title: 'synced' },
            },
          ],
        })
      ).json()) as { results: unknown[] };
      expect(synced.results[0]).toMatchObject({
        status: 'rejected',
        reason: 'op_not_allowed',
      });
      expect(await rows()).toContain('readonly:n');
      // Control: a subtype that allows update is updated through the base.
      expect(
        (
          await call(handler, 'PUT', `${segment()}/${ids.private}`, {
            title: 'private2',
          })
        ).status,
      ).toBe(200);
    });

    it('needs the subtype authorization when the base is public', async () => {
      const handler = new APIGenerator(
        { basePath: '/api' },
        { db },
      ).generateHandler();
      const path = `${segment()}/${ids.private}`;
      expect(
        (await call(handler, 'PUT', path, { title: 'changed' })).status,
      ).toBe(401);
      expect((await call(handler, 'DELETE', path)).status).toBe(401);
      expect(await rows()).toContain('private:n');
    });
  });

  it('OpenAPI offers only the subtypes REST creates', () => {
    const spec = generateOpenAPISpec({ basePath: '/api' });
    const post = (
      spec.paths as Record<string, { post?: { requestBody?: unknown } }>
    )[`/api/${'rowpolicydocs'}`]?.post;
    const body = JSON.stringify(post?.requestBody ?? {});
    expect(body).toContain(key('RowPolicyPrivateDoc'));
    expect(body).not.toContain(key('RowPolicyReadOnlyDoc'));
  });
});

describe('the emitted SvelteKit create route with a public base', () => {
  let dir: string;
  let db: DatabaseInterface;
  let emitted: EmittedProject;

  beforeAll(async () => {
    ObjectRegistry.registerCollection('RowPolicyDoc', RowPolicyDocCollection);
    dir = mkdtempSync(join(tmpdir(), 'smrt-row-policy-'));
    const dbUrl = join(dir, 'app.db');
    db = await getTestDatabase({
      type: 'sqlite',
      url: dbUrl,
      classes: ['RowPolicyDoc', 'RowPolicyPrivateDoc', 'RowPolicyReadOnlyDoc'],
    });
    emitted = await emitTransports(['RowPolicyDoc'], { db, dbUrl });
  });
  afterAll(async () => {
    emitted?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('needs the subtype authorization for a subtype create', async () => {
    const post = (body: unknown, locals: Record<string, unknown> = {}) =>
      emitted.http(`${segment()}/+server.ts`, 'POST', { body, locals });
    const refused = await post({
      title: 'anonymous child',
      note: 'x',
      createType: key('RowPolicyPrivateDoc'),
    });
    expect(refused.status).toBe(401);
    expect((await post({ title: 'anonymous base' })).status).toBe(201);
    const allowed = await post(
      {
        title: 'signed-in child',
        note: 'x',
        createType: key('RowPolicyPrivateDoc'),
      },
      { user: { id: 'user-1' }, permissions: [`${segment()}.create`] },
    );
    expect(allowed.status).toBe(201);
    const titles = (
      await db.query('SELECT title FROM row_policy_docs ORDER BY title')
    ).rows.map((row) => row.title);
    expect(titles).toEqual(['anonymous base', 'signed-in child']);
  });
});

describe('createRestServer with a replaced provider class', () => {
  let restore: () => void;
  let db: DatabaseInterface | undefined;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(async () => {
    await db?.close?.();
    restore();
  });

  it('serves the replacement of the class it was given', async () => {
    const Provider = RowPolicyReplaced;
    ObjectRegistry.register(class RowPolicyReplaced extends Provider {}, {
      packageName: '@row-policy-fixture/app',
      replaceParent: true,
    } as never);
    const replacement = ObjectRegistry.getExposureModel(
      '@row-policy-fixture/provider:RowPolicyReplaced',
    );
    expect(replacement?.qualifiedName).toBe(
      '@row-policy-fixture/app:RowPolicyReplaced',
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['@row-policy-fixture/app:RowPolicyReplaced'],
    });
    const { server } = quietly(() =>
      createRestServer([Provider], { db }, { port: 0, basePath: '/api' }),
    ) as { server: Server };
    try {
      if (!server.listening) {
        await new Promise<void>((resolve) => server.once('listening', resolve));
      }
      const { port } = server.address() as AddressInfo;
      const response = await fetch(
        `http://127.0.0.1:${port}/api/row-policy-replaced`,
      );
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
