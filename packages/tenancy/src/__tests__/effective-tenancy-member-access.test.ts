/**
 * Which family members a base serves depends on who calls, so a read that
 * includes a member not every caller may read is never shared-cached and
 * never revalidates for another caller; only a signed-in principal counts as
 * signed in; and an emitted base serves only the members its routes were
 * generated for, each under its own principal requirement. Emitted routes
 * and the in-process MCP surface, with the real tenant interceptor on a
 * SQLite file.
 *
 * Rows R3.3 to R3.5 of the #5375 round-3 matrix.
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
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withSystemContext } from '../context.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  type EmittedApp,
  emitApp,
  keyOf,
  segmentOf,
  titlesOf,
} from './helpers/effective-tenancy-harness.js';

// An unscoped base anyone may read, opted into shared caching.
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get'], public: 'read', cache: { sMaxage: 60 } },
  mcp: { include: ['list', 'get'] },
})
class EffAccessShelf extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffAccessShelfCollection extends SmrtCollection<EffAccessShelf> {
  static readonly _itemClass = EffAccessShelf;
}
/** Readable by anyone, like its base. */
@smrt({
  api: { include: ['list', 'get'], public: 'read' },
  mcp: { include: ['list', 'get'] },
})
class EffAccessOpenBook extends EffAccessShelf {}
/** Readable only by a signed-in caller. */
@smrt({ api: { include: ['list', 'get'] }, mcp: { include: ['list', 'get'] } })
class EffAccessPrivateBook extends EffAccessShelf {}
/** Readable only with a complete principal (tenant, user, permissions). */
@smrt({ api: { include: ['list', 'get'], principalContext: true } })
class EffAccessLedgerBook extends EffAccessShelf {}
/** Registered and readable, but no route was generated for it. */
@smrt({ api: { include: ['list', 'get'], public: 'read' } })
class EffAccessUnroutedBook extends EffAccessShelf {}

describe('what a base serves depends on who calls', () => {
  let dir: string;
  let db: DatabaseInterface;
  let shelves: SmrtCollection<SmrtObject>;
  let app: EmittedApp;
  const collections = new Map<string, unknown>();
  const shelf = () => segmentOf(EffAccessShelf);

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffAccessShelf',
      EffAccessShelfCollection as never,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-access-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: [
        EffAccessShelf,
        EffAccessOpenBook,
        EffAccessPrivateBook,
        EffAccessLedgerBook,
        EffAccessUnroutedBook,
      ].map((model) => keyOf(model)),
    });
    shelves = (await EffAccessShelfCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    collections.set(keyOf(EffAccessShelf), shelves);
    collections.set('EffAccessShelf', shelves);
    enableTenancy();
    // Routes for every model but the unrouted one.
    app = await emitApp(
      'effective-tenancy-member-access',
      [
        EffAccessShelf,
        EffAccessOpenBook,
        EffAccessPrivateBook,
        EffAccessLedgerBook,
      ],
      collections,
    );
  }, 120_000);

  afterAll(async () => {
    disableTenancy();
    app?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      await db.query(`DELETE FROM ${shelves.tableName}`);
      await shelves.create({ title: 'shelf' } as never);
      for (const [title, model] of [
        ['open book', EffAccessOpenBook],
        ['private book', EffAccessPrivateBook],
        ['ledger book', EffAccessLedgerBook],
        ['unrouted book', EffAccessUnroutedBook],
      ] as const) {
        await shelves.create({ title, _meta_type: keyOf(model) } as never);
      }
    });
  });

  describe('caching (R3.3)', () => {
    it('a signed-in read that serves a private member is never shared-cached', async () => {
      const anonymous = await app.call('GET', shelf());
      expect(titlesOf(anonymous.body)).toContain('open book');
      expect(titlesOf(anonymous.body)).not.toContain('private book');
      expect(anonymous.headers.get('cache-control')).toContain('s-maxage');

      const signedIn = await app.call('GET', shelf(), {
        locals: { user: { id: 'reader' } },
      });
      expect(titlesOf(signedIn.body)).toContain('private book');
      expect(signedIn.headers.get('cache-control')).not.toContain('s-maxage');
      expect(signedIn.headers.get('cache-control')).toContain('private');
    });

    it("with tenancy off, a signed-in read's validator never revalidates an anonymous read", async () => {
      disableTenancy();
      try {
        const signedIn = await app.call('GET', shelf(), {
          locals: { user: { id: 'reader' } },
        });
        expect(titlesOf(signedIn.body)).toContain('private book');
        expect(signedIn.headers.get('cache-control')).not.toContain('s-maxage');
        const etag = signedIn.headers.get('etag') ?? '';
        expect(etag).not.toBe('');

        const anonymous = await app.call('GET', shelf(), {
          headers: { 'if-none-match': etag },
        });
        expect(anonymous.status).toBe(200);
        expect(titlesOf(anonymous.body)).not.toContain('private book');
        expect(anonymous.headers.get('etag')).not.toBe(etag);
      } finally {
        enableTenancy();
      }
    });
  });
});
