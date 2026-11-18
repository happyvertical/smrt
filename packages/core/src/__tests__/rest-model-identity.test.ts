/**
 * A request reaches one model, and that model's own policy decides it.
 *
 * - Runtime REST looks up every policy (auth middleware, public access,
 *   enabled actions, writable fields, sync items) by the model's qualified
 *   name, so two packages' same-named models keep their own policies whatever
 *   order they registered in.
 * - A collection segment that resolves to two models is refused when a
 *   request names it, never served by registration order.
 * - `createRestServer(objects)` serves `objects` and no other model, and
 *   refuses to start when two of them share a segment.
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators/index.js';
import { ConfigurationError } from '../errors.js';
import { APIGenerator, createRestServer } from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

const LEDGERS = '@identity-fixture/ledgers';
const MESSAGES = '@identity-fixture/messages';
const LEDGER_ROW = '11111111-1111-4111-8111-111111111111';
const MESSAGE_ROW = '22222222-2222-4222-8222-222222222222';

/** A public-read model of one package. */
function defineLedgerAccount(collection?: string, api?: unknown) {
  @smrt({
    packageName: LEDGERS,
    tableName: 'identity_ledger_accounts',
    ...(collection ? { collection } : {}),
    api: api ?? { public: 'read' },
  } as never)
  class IdentityAccount extends SmrtObject {
    @field({ type: 'text' }) label = '';
  }
  return IdentityAccount;
}

/** A same-named, non-public, read-only model of another package. */
function defineMessageAccount(collection?: string, api?: unknown) {
  @smrt({
    packageName: MESSAGES,
    tableName: 'identity_message_accounts',
    ...(collection ? { collection } : {}),
    api: api ?? { include: ['list', 'get'] },
  } as never)
  class IdentityAccount extends SmrtObject {
    @field({ type: 'text' }) label = '';
  }
  return IdentityAccount;
}

const keyOf = (ctor: typeof SmrtObject) => {
  const info = ObjectRegistry.getClassByConstructor(ctor as never);
  if (!info) throw new Error('fixture not registered');
  return info.qualifiedName || info.name;
};

async function openDatabase(
  ...ctors: Array<typeof SmrtObject>
): Promise<DatabaseInterface> {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: ':memory:',
    classes: ctors.map(keyOf),
  });
  await db.query(
    `INSERT INTO identity_ledger_accounts (id, slug, context, label) VALUES ('${LEDGER_ROW}', 'ledger-row', '', 'ledger')`,
  );
  await db.query(
    `INSERT INTO identity_message_accounts (id, slug, context, label) VALUES ('${MESSAGE_ROW}', 'message-row', '', 'message')`,
  );
  return db;
}

const send = (
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

const labels = async (db: DatabaseInterface, table: string) =>
  (await db.query(`SELECT label FROM ${table} ORDER BY label`)).rows.map(
    (row) => row.label,
  );

/** Run a server factory without its startup banner. */
function quietly<T>(start: () => T): T {
  const log = console.log;
  console.log = () => {};
  try {
    return start();
  } finally {
    console.log = log;
  }
}

/** The port a server listens on, once it does. */
async function listening(server: Server): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once('listening', resolve));
  }
  return (server.address() as AddressInfo).port;
}

describe('runtime REST model identity', () => {
  let restore: () => void;
  let db: DatabaseInterface | undefined;

  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(async () => {
    await db?.close?.();
    db = undefined;
    restore();
  });

  describe('same-named models of two packages', () => {
    it.each([
      ['the public model registered first', true],
      ['the closed model registered first', false],
    ])('each is served under its own policy with %s', async (_label, publicFirst) => {
      const [ledger, message] = publicFirst
        ? [
            defineLedgerAccount('identity-ledger-accounts'),
            defineMessageAccount('identity-message-accounts'),
          ]
        : (() => {
            const closed = defineMessageAccount('identity-message-accounts');
            return [defineLedgerAccount('identity-ledger-accounts'), closed];
          })();
      db = await openDatabase(ledger, message);
      const handler = new APIGenerator(
        { basePath: '/api' },
        { db },
      ).generateHandler();

      // The public-read model reads without a principal.
      const ledgerList = await send(handler, 'GET', 'identity-ledger-accounts');
      expect(ledgerList.status).toBe(200);
      expect(JSON.stringify(await ledgerList.json())).toContain('ledger');
      // The closed model does not, by list or by id.
      for (const path of [
        'identity-message-accounts',
        `identity-message-accounts/${MESSAGE_ROW}`,
      ]) {
        const response = await send(handler, 'GET', path);
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain('message-row');
      }
    });

    it('auth middleware receives the qualified name, and actions a model excludes stay closed', async () => {
      const ledger = defineLedgerAccount('identity-ledger-accounts', {});
      const message = defineMessageAccount('identity-message-accounts');
      db = await openDatabase(ledger, message);
      const seen: string[] = [];
      const handler = new APIGenerator(
        {
          basePath: '/api',
          authMiddleware: (name, action) => async (req) => {
            seen.push(`${name}/${action}`);
            return req;
          },
        },
        { db },
      ).generateHandler();

      expect(
        (
          await send(handler, 'POST', 'identity-message-accounts', {
            label: 'created',
          })
        ).status,
      ).toBe(405);
      expect(
        (
          await send(
            handler,
            'PUT',
            `identity-message-accounts/${MESSAGE_ROW}`,
            { label: 'updated' },
          )
        ).status,
      ).toBe(405);
      expect(
        (
          await send(
            handler,
            'DELETE',
            `identity-message-accounts/${MESSAGE_ROW}`,
          )
        ).status,
      ).toBe(405);
      expect(await labels(db, 'identity_message_accounts')).toEqual([
        'message',
      ]);
      // Negative control: the full-CRUD model of the other package writes.
      expect(
        (
          await send(handler, 'POST', 'identity-ledger-accounts', {
            label: 'created',
          })
        ).status,
      ).toBe(201);
      expect(seen).toEqual([
        `${MESSAGES}:IdentityAccount/post`,
        `${MESSAGES}:IdentityAccount/put`,
        `${MESSAGES}:IdentityAccount/delete`,
        `${LEDGERS}:IdentityAccount/post`,
      ]);
    });

    it('a sync item is checked against the policy of the model it names', async () => {
      const ledger = defineLedgerAccount('identity-ledger-accounts', {});
      const message = defineMessageAccount('identity-message-accounts');
      db = await openDatabase(ledger, message);
      const seen: string[] = [];
      const handler = new APIGenerator(
        {
          basePath: '/api',
          authMiddleware: (name, action) => async (req) => {
            seen.push(`${name}/${action}`);
            return req;
          },
        },
        { db },
      ).generateHandler();
      const item = (object: string, id: string) => ({
        object,
        op: 'update',
        id,
        itemId: `item-${object}`,
        payload: { label: 'synced' },
      });

      const response = await send(handler, 'POST', 'sync/apply', {
        items: [
          item('identity-message-accounts', MESSAGE_ROW),
          item('identity-ledger-accounts', LEDGER_ROW),
        ],
      });
      const results = (
        (await response.json()) as { results: Array<{ status: string }> }
      ).results;
      // `update` is not an enabled action of the read-only model.
      expect(results[0]).toMatchObject({ status: 'rejected' });
      expect(results[1]).toMatchObject({ status: 'applied' });
      expect(await labels(db, 'identity_message_accounts')).toEqual([
        'message',
      ]);
      expect(await labels(db, 'identity_ledger_accounts')).toEqual(['synced']);
      expect(seen).toEqual([
        `${MESSAGES}:IdentityAccount/put`,
        `${LEDGERS}:IdentityAccount/put`,
      ]);
    });
  });

  describe('collection segments', () => {
    it('refuses a request to a segment that resolves to two models', async () => {
      // Neither model names a collection, so both derive the same segment.
      const ledger = defineLedgerAccount(undefined, {});
      const message = defineMessageAccount(undefined, {});
      const segment = ObjectRegistry.getClassByConstructor(ledger as never)
        ?.collection as string;
      expect(
        ObjectRegistry.getClassByConstructor(message as never)?.collection,
      ).toBe(segment);
      db = await openDatabase(ledger, message);
      const seen: string[] = [];
      const handler = new APIGenerator(
        {
          basePath: '/api',
          authMiddleware: (name, action) => async (req) => {
            seen.push(`${name}/${action}`);
            return req;
          },
        },
        { db },
      ).generateHandler();

      for (const [method, path, body] of [
        ['GET', segment, undefined],
        ['GET', `${segment}/${MESSAGE_ROW}`, undefined],
        ['POST', segment, { label: 'created' }],
        ['DELETE', `${segment}/${LEDGER_ROW}`, undefined],
      ] as const) {
        const response = await send(handler, method, path, body);
        expect(response.status).toBe(500);
        const text = await response.text();
        expect(text).not.toContain('ledger-row');
        expect(text).not.toContain('message-row');
      }
      // Refused before any model's policy ran.
      expect(seen).toEqual([]);
      expect(await labels(db, 'identity_ledger_accounts')).toEqual(['ledger']);
      expect(await labels(db, 'identity_message_accounts')).toEqual([
        'message',
      ]);
    });

    it('refuses a request to a segment that became ambiguous after the generator was built', async () => {
      const ledger = defineLedgerAccount('identity-accounts');
      db = await getTestDatabase({
        type: 'sqlite',
        url: ':memory:',
        classes: [keyOf(ledger)],
      });
      const handler = new APIGenerator(
        { basePath: '/api' },
        { db },
      ).generateHandler();
      expect((await send(handler, 'GET', 'identity-accounts')).status).toBe(
        200,
      );

      defineMessageAccount('identity-accounts');
      const response = await send(handler, 'GET', 'identity-accounts');
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('ledger');
    });

    it('does not count a model with `api: false` as a second owner', async () => {
      const ledger = defineLedgerAccount('identity-accounts');
      const message = defineMessageAccount('identity-accounts', false);
      db = await openDatabase(ledger, message);
      const handler = new APIGenerator(
        { basePath: '/api' },
        { db },
      ).generateHandler();
      const response = await send(handler, 'GET', 'identity-accounts');
      expect(response.status).toBe(200);
      const body = JSON.stringify(await response.json());
      expect(body).toContain('ledger-row');
      expect(body).not.toContain('message-row');
    });
  });

  describe('createRestServer(objects)', () => {
    it('serves the models it was given and no other', async () => {
      const ledger = defineLedgerAccount('identity-ledger-accounts');
      const message = defineMessageAccount('identity-message-accounts', {
        public: 'read',
      });
      db = await openDatabase(ledger, message);
      const { server } = quietly(() =>
        createRestServer([ledger], { db }, { port: 0, basePath: '/api' }),
      );
      try {
        const port = await listening(server);
        const get = (path: string) =>
          fetch(`http://127.0.0.1:${port}/api/${path}`);

        const served = await get('identity-ledger-accounts');
        expect(served.status).toBe(200);
        expect(await served.text()).toContain('ledger-row');
        for (const path of [
          'identity-message-accounts',
          `identity-message-accounts/${MESSAGE_ROW}`,
        ]) {
          const response = await get(path);
          expect(response.status).toBe(404);
          expect(await response.text()).not.toContain('message-row');
        }
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('serves the given model when an unlisted one shares its segment', async () => {
      const ledger = defineLedgerAccount();
      const message = defineMessageAccount(undefined, { public: 'read' });
      db = await openDatabase(ledger, message);
      const segment = ObjectRegistry.getClassByConstructor(ledger as never)
        ?.collection as string;
      const server = quietly(() =>
        createRestServer([ledger], { db }, { port: 0, basePath: '/api' }),
      ).server;
      try {
        const port = await listening(server);
        const response = await fetch(`http://127.0.0.1:${port}/api/${segment}`);
        expect(response.status).toBe(200);
        const text = await response.text();
        expect(text).toContain('ledger-row');
        expect(text).not.toContain('message-row');
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

    it('refuses to start when two given models share a segment', () => {
      const ledger = defineLedgerAccount();
      const message = defineMessageAccount();
      const segment = ObjectRegistry.getClassByConstructor(ledger as never)
        ?.collection as string;
      let failure: unknown;
      try {
        quietly(() => createRestServer([ledger, message], {}, { port: 0 }));
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ConfigurationError);
      expect(failure).toMatchObject({
        code: 'REST_COLLECTION_SEGMENT_AMBIGUOUS',
        details: { segments: { [segment]: [keyOf(ledger), keyOf(message)] } },
      });
    });
  });
});
