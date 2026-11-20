/**
 * A route to an STI model that is itself a subtype, with subtypes of its own,
 * serves only the descendants the caller may read.
 *
 * The collection of such a model restricts reads to its own subtree; the
 * route's served types hold beside that restriction, so the subtree never
 * widens a read to a descendant the route left out. Three levels: a public
 * root, a public middle model with its own route, and a private grandchild.
 *
 * Real SQLite; nothing is mocked.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { APIGenerator } from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';

@smrt({
  tableStrategy: 'sti',
  api: { public: true, include: ['list', 'get'] },
})
class DepthNote extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}
class DepthNoteCollection extends SmrtCollection<DepthNote> {
  static readonly _itemClass = DepthNote;
}

/** Public, with a route of its own and a subtype below it. */
@smrt({
  collection: 'depth-chapter-notes',
  api: { public: true, include: ['list', 'get'] },
})
class DepthChapterNote extends DepthNote {
  @field({ type: 'text' })
  chapter = '';
}
class DepthChapterNoteCollection extends SmrtCollection<DepthChapterNote> {
  static readonly _itemClass = DepthChapterNote;
}

/** Not public: needs an authenticated caller. */
@smrt({ collection: 'depth-draft-notes', api: { include: ['list', 'get'] } })
class DepthDraftChapterNote extends DepthChapterNote {
  @field({ type: 'text' })
  reviewer = '';
}

const key = (name: string) => {
  const info = ObjectRegistry.getClass(name);
  if (!info) throw new Error(`fixture not registered: ${name}`);
  return info.qualifiedName || info.name;
};
const segmentOf = (name: string) =>
  ObjectRegistry.getClass(name)?.collection as string;

describe('a route to an STI model with subtypes of its own', () => {
  let db: DatabaseInterface;
  const ids: Record<string, string> = {};

  beforeEach(async () => {
    ObjectRegistry.registerCollection('DepthNote', DepthNoteCollection);
    ObjectRegistry.registerCollection(
      'DepthChapterNote',
      DepthChapterNoteCollection,
    );
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['DepthNote', 'DepthChapterNote', 'DepthDraftChapterNote'],
    });
    const notes = await DepthNoteCollection.create({ db });
    for (const [label, model] of [
      ['root', 'DepthNote'],
      ['chapter', 'DepthChapterNote'],
      ['draft', 'DepthDraftChapterNote'],
    ] as const) {
      const created = await notes.create({
        title: label,
        slug: `${label}-note`,
        _meta_type: key(model),
      } as never);
      ids[label] = created.id as string;
    }
  });
  afterEach(async () => {
    await db?.close?.();
  });

  const call = (handler: (req: Request) => Promise<Response>, path: string) =>
    handler(new Request(`http://local/api/${path}`));
  const titlesOf = async (response: Response) => {
    expect(response.status).toBe(200);
    return ((await response.json()) as Array<{ title: string }>)
      .map((row) => row.title)
      .sort();
  };

  it('serves an anonymous caller none of a private descendant rows', async () => {
    const handler = new APIGenerator(
      { basePath: '/api' },
      { db },
    ).generateHandler();
    const segment = segmentOf('DepthChapterNote');
    expect(await titlesOf(await call(handler, segment))).toEqual(['chapter']);
    expect(await (await call(handler, `${segment}/count`)).json()).toEqual({
      count: 1,
    });
    expect((await call(handler, `${segment}/${ids.draft}`)).status).toBe(404);
    expect((await call(handler, `${segment}/draft-note`)).status).toBe(404);
    expect((await call(handler, `${segment}/${ids.chapter}`)).status).toBe(200);
  });

  it('serves none of the rows of a descendant the auth middleware refuses', async () => {
    const handler = new APIGenerator(
      {
        basePath: '/api',
        authMiddleware: (model) => async (req) =>
          model === key('DepthDraftChapterNote')
            ? new Response('forbidden', { status: 403 })
            : req,
      },
      { db },
    ).generateHandler();
    const segment = segmentOf('DepthChapterNote');
    expect(await titlesOf(await call(handler, segment))).toEqual(['chapter']);
    expect((await call(handler, `${segment}/${ids.draft}`)).status).toBe(404);
  });

  it('serves every descendant the caller may read', async () => {
    const handler = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db },
    ).generateHandler();
    const segment = segmentOf('DepthChapterNote');
    expect(await titlesOf(await call(handler, segment))).toEqual([
      'chapter',
      'draft',
    ]);
    expect((await call(handler, `${segment}/${ids.draft}`)).status).toBe(200);
  });
});
