/**
 * #5143: the run-time REST router reads exposure, public-route and auth
 * policy from the exact class a route selected (its registry key), never from
 * the simple name a same-named subtype shares with its parent. A public parent
 * does not open a same-named subtype that requires authentication.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators';
import { SmrtObject } from '../../object';
import { ObjectRegistry } from '../../registry';
import { snapshotObjectRegistryState } from '../../test-utils';
import { getTestDatabase } from '../../testing/database';
import { APIGenerator } from '../rest';

const BASE = '@fixture/r5143-video:Scene';
const SUB = '@fixture/r5143-histrio:Scene';
const APP = '@fixture/r5143-app:Scene';
const ALL = ['list', 'get', 'create', 'update', 'delete'];

function family() {
  class VideoScene extends SmrtObject {
    title = '';
  }
  class HistrioScene extends VideoScene {
    mood = '';
  }
  class AppScene extends VideoScene {
    pose = '';
  }
  field({ type: 'text' })(VideoScene.prototype, 'title');
  field({ type: 'text' })(HistrioScene.prototype, 'mood');
  field({ type: 'text' })(AppScene.prototype, 'pose');
  return {
    base: () =>
      ObjectRegistry.register(VideoScene, {
        name: 'Scene',
        packageName: '@fixture/r5143-video',
        tableName: 'r5143_scenes',
        tableStrategy: 'sti',
        collection: 'scenes',
        api: { include: ALL, public: true },
      }),
    // Authenticated-only: no `public`.
    sub: () =>
      ObjectRegistry.register(HistrioScene, {
        name: 'Scene',
        packageName: '@fixture/r5143-histrio',
        tableName: 'r5143_scenes',
        replaceParent: false,
        collection: 'histrio_scenes',
        api: { include: ALL },
      }),
    app: () =>
      ObjectRegistry.register(AppScene, {
        name: 'Scene',
        packageName: '@fixture/r5143-app',
        tableName: 'r5143_scenes',
        replaceParent: true,
        collection: 'scenes',
        api: { include: ALL, public: true },
      }),
  };
}

const get = (path: string) =>
  new Request(`http://local/api${path}`, { method: 'GET' });

function syncApply(object: string) {
  return new Request('http://local/api/sync/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      items: [
        {
          itemId: 'one',
          object,
          op: 'create',
          id: '11111111-1111-4111-8111-111111111111',
          payload: { title: 't' },
        },
      ],
    }),
  });
}

const databaseType = process.env.SMRT_TEST_PGLITE === '1' ? 'pglite' : 'sqlite';
let restore: () => void;
let db: DatabaseInterface | undefined;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(async () => {
  await db?.close?.();
  db = undefined;
  restore();
});

/** A router over a database holding the family's shared table. */
async function router(config: ConstructorParameters<typeof APIGenerator>[0]) {
  db ??= await getTestDatabase({
    type: databaseType,
    classes: [BASE],
  });
  return new APIGenerator(config, { db }).generateHandler();
}

describe('run-time REST policy of a same-named subtype next to a public parent', () => {
  it('refuses an anonymous read of the authenticated-only subtype route; the public parent route is not refused', async () => {
    const fixture = family();
    fixture.base();
    const handler = await router({ basePath: '/api' });
    expect((await handler(get('/scenes'))).status).toBe(200);
    fixture.sub();
    expect(ObjectRegistry.findClassesByName('Scene')).toHaveLength(2);
    const sub = await handler(get('/histrio_scenes'));
    expect(sub.status).toBe(401);
    const subItem = await handler(
      get('/histrio_scenes/11111111-1111-4111-8111-111111111111'),
    );
    expect(subItem.status).toBe(401);
    expect((await handler(get('/scenes'))).status).toBe(200);
  });

  it('refuses a sync/apply item for the authenticated-only subtype without auth', async () => {
    const fixture = family();
    fixture.base();
    fixture.sub();
    const handler = await router({ basePath: '/api' });
    const res = await handler(syncApply('histrio_scenes'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      results: Array<{ status: string; reason?: string }>;
    };
    expect(body.results[0]).toMatchObject({
      status: 'rejected',
      reason: 'auth_required',
    });
  });

  it('names the subtype by its registry key to the auth middleware on CRUD and sync/apply routes', async () => {
    const fixture = family();
    fixture.base();
    fixture.sub();
    const seen: string[] = [];
    const handler = await router({
      basePath: '/api',
      authMiddleware: (objectName) => async () => {
        seen.push(objectName);
        return new Response('{}', { status: 401 });
      },
    });
    expect((await handler(get('/histrio_scenes'))).status).toBe(401);
    await handler(syncApply('histrio_scenes'));
    expect(seen).toEqual([SUB, SUB]);
  });

  it('keeps the simple name for the auth middleware when no other class shares it', async () => {
    family().base();
    const seen: string[] = [];
    const handler = await router({
      basePath: '/api',
      authMiddleware: (objectName) => async () => {
        seen.push(objectName);
        return new Response('{}', { status: 401 });
      },
    });
    await handler(get('/scenes'));
    expect(seen).toEqual(['Scene']);
  });

  it('control: a public replacement (replaceParent: true) still serves the parent route without auth', async () => {
    const fixture = family();
    fixture.base();
    const handler = await router({ basePath: '/api' });
    expect((await handler(get('/scenes'))).status).toBe(200);
    fixture.app();
    expect(ObjectRegistry.getClass(BASE)?.qualifiedName).toBe(APP);
    expect((await handler(get('/scenes'))).status).toBe(200);
  });
});
