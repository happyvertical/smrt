/**
 * A read validator that hashes the response body still changes when only
 * the tenancy the read was served under changed, on runtime REST and the
 * emitted routes, with the real tenant interceptor on a SQLite file.
 *
 * Row R2.16 of the #5375 round-2 matrix.
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystemContext } from '../context.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';
import {
  type EmittedApp,
  emitApp,
  keyOf,
  restCall,
  segmentOf,
  titlesOf,
} from './helpers/effective-tenancy-harness.js';

// A field only some callers may read: reads validate the rendered body.
@smrt({ api: { include: ['list', 'get'], public: 'read' } })
class EffValidatorCard extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
  @field({ type: 'text', nullable: true, readPermission: 'cards.secret' })
  secret: string | null = null;
}
class EffValidatorCardCollection extends SmrtCollection<EffValidatorCard> {
  static readonly _itemClass = EffValidatorCard;
}

describe('a body-hash validator changes with the tenancy a read was served under', () => {
  let dir: string;
  let db: DatabaseInterface;
  let handler: (req: Request) => Promise<Response>;
  let app: EmittedApp;
  const collections = new Map<string, unknown>();
  const key = () => keyOf(EffValidatorCard);

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffValidatorCard',
      EffValidatorCardCollection as never,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-validators-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: [key()],
    });
    const cards = await EffValidatorCardCollection.create({ db });
    collections.set(key(), cards);
    collections.set('EffValidatorCard', cards);
    enableTenancy();
    // Only a row without an owner: a read held to such rows renders the
    // same body before and after the model becomes tenant-scoped.
    await withSystemContext(async () => {
      await cards.create({ title: 'everyone', secret: 'hidden' } as never);
    });
    handler = new APIGenerator({ basePath: '/api' }, { db }).generateHandler();
    app = await emitApp(
      'effective-tenancy-validators',
      [EffValidatorCard],
      collections,
    );
  }, 120_000);

  afterAll(async () => {
    disableTenancy();
    app?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a tenancy registration that leaves the body unchanged still changes its validator', async () => {
    const restRead = (etag?: string) =>
      restCall(handler, 'GET', segmentOf(EffValidatorCard), {
        headers: etag ? { 'if-none-match': etag } : {},
      });
    const emittedRead = (etag?: string) =>
      app.call('GET', segmentOf(EffValidatorCard), {
        headers: etag ? { 'if-none-match': etag } : {},
      });
    const before = { rest: await restRead(), emitted: await emittedRead() };
    expect(titlesOf(before.rest.body)).toEqual(['everyone']);
    expect(titlesOf(before.emitted.body)).toEqual(['everyone']);
    registerTenantScopedClass(key(), { mode: 'optional' });
    try {
      for (const [read, previous] of [
        [restRead, before.rest],
        [emittedRead, before.emitted],
      ] as const) {
        const etag = String(previous.headers.get('etag'));
        const after = await read(etag);
        expect(after.status).toBe(200);
        expect(titlesOf(after.body)).toEqual(['everyone']);
        expect(after.headers.get('etag')).not.toBe(etag);
      }
    } finally {
      unregisterTenantScopedClass(key());
    }
  });
});
