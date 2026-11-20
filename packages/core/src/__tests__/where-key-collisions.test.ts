/**
 * A `where` record never holds two keys for the same column and operator.
 *
 * `ownerId`, `owner_id`, `OwnerId` and `ownerId =` all resolve to the column
 * `owner_id`. The collection refuses a record in which two keys resolve to the
 * same column and operator, so a predicate added by an interceptor or by the
 * collection itself (an STI child's discriminator) is either in the query or
 * the query does not run. Two operators on one column are a range and stay
 * legal.
 *
 * Real in-memory SQLite; nothing is mocked. The tenant interceptor's side of
 * the same guarantee is covered in smrt-tenancy
 * (`tenant-filter-key-spellings.test.ts`).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field, foreignKey, oneToMany } from '../decorators/index.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import { GlobalInterceptors } from '../interceptors.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';
import {
  applyWhereScope,
  mergeOwnedWhere,
  normalizeWhereKey,
  resolveWhereKey,
  WhereClauseError,
  whereColumnName,
} from '../where-keys.js';

@smrt({ api: { include: ['list', 'get'] }, mcp: { include: ['list', 'get'] } })
class CollisionTicket extends SmrtObject {
  @field({ type: 'text' })
  title = '';

  @field({ type: 'text' })
  ownerId = '';

  @field({ type: 'integer' })
  priority = 0;

  @oneToMany('CollisionTicketNote')
  notes: CollisionTicketNote[] = [];
}

@smrt({ api: false, mcp: false })
class CollisionTicketNote extends SmrtObject {
  @foreignKey(CollisionTicket)
  ticketId = '';

  @field({ type: 'integer' })
  sequence = 0;

  @field({ type: 'text' })
  note = '';
}

class CollisionTicketCollection extends SmrtCollection<CollisionTicket> {
  static readonly _itemClass = CollisionTicket;
}
class CollisionTicketNoteCollection extends SmrtCollection<CollisionTicketNote> {
  static readonly _itemClass = CollisionTicketNote;
}

// One STI table: Page and Note are siblings, Feature is a descendant of
// Article. Only some members are routed.
@smrt({ tableStrategy: 'sti', api: { include: ['list', 'get'] } })
class CollisionContent extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}

@smrt({ api: { include: ['list', 'get'] } })
class CollisionPage extends CollisionContent {}

@smrt({ api: false })
class CollisionNote extends CollisionContent {}

@smrt({ api: { include: ['list', 'get'] } })
class CollisionArticle extends CollisionContent {}

@smrt({ api: false })
class CollisionFeature extends CollisionArticle {}

class CollisionContentCollection extends SmrtCollection<CollisionContent> {
  static readonly _itemClass = CollisionContent;
}
class CollisionPageCollection extends SmrtCollection<CollisionPage> {
  static readonly _itemClass = CollisionPage;
}
class CollisionNoteCollection extends SmrtCollection<CollisionNote> {
  static readonly _itemClass = CollisionNote;
}
class CollisionArticleCollection extends SmrtCollection<CollisionArticle> {
  static readonly _itemClass = CollisionArticle;
}
class CollisionFeatureCollection extends SmrtCollection<CollisionFeature> {
  static readonly _itemClass = CollisionFeature;
}

const titles = (rows: Array<{ title?: unknown }>) =>
  rows.map((row) => String(row.title)).sort();

/** Spellings that all resolve to the column `owner_id` for equality. */
const OWNER_KEY_SPELLINGS = [
  'ownerId',
  'owner_id',
  'OwnerId',
  'ownerId =',
  'owner_id =',
  ' owner_id ',
] as const;

describe('where key resolution helpers', () => {
  it('resolves every spelling of a key to one column and operator', () => {
    for (const key of OWNER_KEY_SPELLINGS) {
      expect(resolveWhereKey(key)).toMatchObject({
        column: 'owner_id',
        operator: '=',
        path: null,
      });
      expect(normalizeWhereKey(key, 'a')).toBe('owner_id');
    }
    expect(resolveWhereKey('ownerId not in')).toMatchObject({
      column: 'owner_id',
      operator: 'not in',
    });
    expect(resolveWhereKey('_metaType')).toMatchObject({
      column: '_meta_type',
    });
    expect(resolveWhereKey('metadata.ownerId >')).toMatchObject({
      column: 'metadata',
      path: '.ownerId',
      operator: '>',
    });
    expect(whereColumnName('_metaType')).toBe('_meta_type');
  });

  it('treats an array under the default operator as an in-list', () => {
    expect(normalizeWhereKey('ownerId', ['a'])).toBe('owner_id in');
    expect(normalizeWhereKey('owner_id in', ['a'])).toBe('owner_id in');
    expect(normalizeWhereKey('ownerId', 'a')).not.toBe(
      normalizeWhereKey('ownerId', ['a']),
    );
  });

  it('an owned predicate replaces every spelling of its own key and nothing else', () => {
    expect(
      mergeOwnedWhere(
        { OwnerId: 'x', 'owner_id =': 'y', title: 't', 'owner_id !=': 'z' },
        { ownerId: 'mine' },
      ),
    ).toEqual({ title: 't', 'owner_id !=': 'z', ownerId: 'mine' });
    expect(mergeOwnedWhere(undefined, { ownerId: 'mine' })).toEqual({
      ownerId: 'mine',
    });
  });

  it('keeps a caller key written like an owned key when its operator differs', () => {
    // An in-list under the owned key's own spelling stays as its own condition.
    expect(
      mergeOwnedWhere({ _meta_type: ['a', 'b'] }, { _meta_type: 'x' }),
    ).toEqual({ '_meta_type in': ['a', 'b'], _meta_type: 'x' });
    // And the reverse: equality beside an owned in-list.
    expect(
      mergeOwnedWhere({ _meta_type: 'a' }, { _meta_type: ['x', 'y'] }),
    ).toEqual({ '_meta_type =': 'a', _meta_type: ['x', 'y'] });
    // Equality written `field =` beside an owned in-list written the same way
    // stays one condition: it moves to the bare spelling.
    expect(
      mergeOwnedWhere({ 'status =': 'a' }, { 'status =': ['x', 'y'] }),
    ).toEqual({ status: 'a', 'status =': ['x', 'y'] });
    // Two caller keys for that column and operator are still refused.
    expect(() =>
      mergeOwnedWhere(
        { _meta_type: ['a'], '_meta_type in': ['b'] },
        { _meta_type: 'x' },
      ),
    ).toThrow(WhereClauseError);
  });

  it('a forced scope removes every caller filter on its column', () => {
    expect(
      applyWhereScope(
        {
          ownerId: 'x',
          owner_id: 'y',
          'OwnerId !=': 'z',
          ' owner_id in': ['q'],
          title: 't',
        },
        { ownerId: null },
      ),
    ).toEqual({ title: 't', ownerId: null });
    const untouched = { owner_id: 'y' };
    expect(applyWhereScope(untouched, undefined)).toBe(untouched);
    expect(applyWhereScope(undefined, { ownerId: null })).toEqual({
      ownerId: null,
    });
  });
});

describe('where key collisions', () => {
  let db: DatabaseInterface;
  let tickets: CollisionTicketCollection;
  let contents: CollisionContentCollection;
  let pages: CollisionPageCollection;
  let articles: CollisionArticleCollection;
  let handler: (req: Request) => Promise<Response>;
  let ticketOfB: string;
  let noteId: string;
  const typeOf = (name: string) =>
    ObjectRegistry.getClass(name)?.qualifiedName as string;

  beforeAll(async () => {
    for (const [name, collection] of [
      ['CollisionTicket', CollisionTicketCollection],
      ['CollisionTicketNote', CollisionTicketNoteCollection],
      ['CollisionContent', CollisionContentCollection],
      ['CollisionPage', CollisionPageCollection],
      ['CollisionNote', CollisionNoteCollection],
      ['CollisionArticle', CollisionArticleCollection],
      ['CollisionFeature', CollisionFeatureCollection],
    ] as const) {
      ObjectRegistry.registerCollection(name, collection as never);
    }
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: [
        'CollisionTicket',
        'CollisionTicketNote',
        'CollisionContent',
        'CollisionPage',
        'CollisionNote',
        'CollisionArticle',
        'CollisionFeature',
      ],
    });
    tickets = await CollisionTicketCollection.create({ db });
    contents = await CollisionContentCollection.create({ db });
    pages = await CollisionPageCollection.create({ db });
    articles = await CollisionArticleCollection.create({ db });
    const notes = await CollisionNoteCollection.create({ db });
    const features = await CollisionFeatureCollection.create({ db });

    await tickets.create({ title: 'a low', ownerId: 'a', priority: 1 });
    await tickets.create({ title: 'a high', ownerId: 'a', priority: 5 });
    ticketOfB = (
      await tickets.create({ title: 'b low', ownerId: 'b', priority: 1 })
    ).id as string;

    await pages.create({ title: 'page' });
    noteId = (await notes.create({ title: 'unrouted note' })).id as string;
    await articles.create({ title: 'article' });
    await features.create({ title: 'feature' });

    const api = new APIGenerator(
      {
        basePath: '/api',
        authMiddleware: () => async (req: Request) => req,
      },
      { db },
    );
    api.registerCollection('tickets', tickets as never);
    api.registerCollection('contents', contents as never);
    api.registerCollection('pages', pages as never);
    api.registerCollection('articles', articles as never);
    handler = api.generateHandler();
  });

  afterEach(() => {
    GlobalInterceptors.unregister('where-key-collisions');
  });

  afterAll(async () => {
    await db?.close?.();
  });

  const get = (path: string) =>
    handler(new Request(`http://local/api/${path}`));
  const enc = encodeURIComponent;

  describe('collection reads', () => {
    const pairs: Array<[string, Record<string, unknown>]> = [];
    for (const first of OWNER_KEY_SPELLINGS) {
      for (const second of OWNER_KEY_SPELLINGS) {
        if (first === second) continue;
        pairs.push([
          `'${first}' then '${second}'`,
          { [first]: 'a', [second]: 'b' },
        ]);
      }
    }

    it.each(pairs)('list, count and get refuse %s', async (_label, where) => {
      await expect(tickets.list({ where })).rejects.toThrow(WhereClauseError);
      await expect(tickets.count({ where })).rejects.toMatchObject({
        code: 'INVALID_WHERE_CLAUSE',
        status: 400,
      });
      await expect(tickets.get({ ...where, id: ticketOfB })).rejects.toThrow(
        WhereClauseError,
      );
      await expect(
        tickets.facets({ fields: ['priority'], where }),
      ).rejects.toThrow(WhereClauseError);
    });

    it('refuses two keys that both become an in-list on one column', async () => {
      const where = { ownerId: ['a'], 'owner_id in': ['b'] };
      await expect(tickets.list({ where })).rejects.toThrow(WhereClauseError);
      await expect(tickets.count({ where })).rejects.toThrow(WhereClauseError);
    });

    it('refuses the same record on every other read that takes a where', async () => {
      const where = { ownerId: 'a', owner_id: 'b' };
      // Projection rows and the projection query plan.
      await expect(tickets.list({ select: ['title'], where })).rejects.toThrow(
        WhereClauseError,
      );
      await expect(
        tickets.buildProjectionQuery({ select: ['title'], where }),
      ).rejects.toThrow(WhereClauseError);
      // Total and filtered counts.
      await expect(tickets.counts({ where })).rejects.toThrow(WhereClauseError);
      // Parents with their latest related row.
      await expect(
        tickets.listWithLatestRelated({
          latestRelated: { relation: 'notes', orderBy: 'sequence DESC' },
          where,
        }),
      ).rejects.toThrow(WhereClauseError);
    });

    it('serves those reads for a range on one column', async () => {
      const where = { ownerId: 'a', 'priority >=': 1, 'priority <': 5 };
      expect(await tickets.list({ select: ['title'], where })).toEqual([
        { title: 'a low' },
      ]);
      expect(await tickets.counts({ where })).toEqual({
        total: 3,
        filtered: 1,
      });
      const latest = await tickets.listWithLatestRelated({
        latestRelated: { relation: 'notes', orderBy: 'sequence DESC' },
        where,
      });
      expect(
        latest.map((row) => (row.parent as CollisionTicket).title),
      ).toEqual(['a low']);
    });

    it('refuses one operator written twice for a column', async () => {
      await expect(
        tickets.list({ where: { 'priority >': 0, 'priority  >': 4 } }),
      ).rejects.toThrow(WhereClauseError);
    });

    it('names both keys and the column in the refusal', async () => {
      await expect(
        tickets.list({ where: { ownerId: 'a', owner_id: 'b' } }),
      ).rejects.toThrow(/'ownerId' and 'owner_id' both filter 'owner_id'/);
    });

    it('checks each condition record of a DNF filter', async () => {
      await expect(
        tickets.list({ where: [[{ ownerId: 'a', owner_id: 'b' }]] }),
      ).rejects.toThrow(WhereClauseError);
      await expect(
        tickets.count({
          where: [[{ title: 'a low' }], [{ ownerId: 'a', OwnerId: 'b' }]],
        }),
      ).rejects.toThrow(WhereClauseError);
      // Separate records of one branch are ANDed, never merged.
      expect(
        await tickets.list({ where: [[{ ownerId: 'a' }, { owner_id: 'b' }]] }),
      ).toEqual([]);
    });

    it('serves a range: two different operators on one column', async () => {
      const where = { 'priority >=': 1, 'priority <': 5, ownerId: 'a' };
      expect(titles(await tickets.list({ where }))).toEqual(['a low']);
      expect(await tickets.count({ where })).toBe(1);
      expect(
        titles(
          await tickets.list({
            where: { ownerId: 'a', 'owner_id !=': 'b', 'owner_id in': ['a'] },
          }),
        ),
      ).toEqual(['a high', 'a low']);
    });

    it.each(
      OWNER_KEY_SPELLINGS,
    )('serves a single filter written as %j', async (key) => {
      expect(titles(await tickets.list({ where: { [key]: 'b' } }))).toEqual([
        'b low',
      ]);
    });
  });

  describe('predicates added by an interceptor', () => {
    const scopeToOwnerA = () =>
      GlobalInterceptors.register({
        name: 'where-key-collisions',
        beforeList(className, options) {
          if (className !== 'CollisionTicket') return;
          return { ...options, where: { ...options.where, ownerId: 'a' } };
        },
        beforeGet(className, filter) {
          if (className !== 'CollisionTicket') return;
          return typeof filter === 'string'
            ? { id: filter, ownerId: 'a' }
            : { ...filter, ownerId: 'a' };
        },
      });

    it.each(
      OWNER_KEY_SPELLINGS.filter((key) => key !== 'ownerId'),
    )('cannot be replaced by a caller key written as %j', async (key) => {
      scopeToOwnerA();
      const where = { [key]: 'b' };
      await expect(tickets.list({ where })).rejects.toThrow(WhereClauseError);
      await expect(tickets.count({ where })).rejects.toThrow(WhereClauseError);
      await expect(tickets.get({ ...where, id: ticketOfB })).rejects.toThrow(
        WhereClauseError,
      );
    });

    it('still apply to plain reads and to hydration by id', async () => {
      scopeToOwnerA();
      expect(titles(await tickets.list({}))).toEqual(['a high', 'a low']);
      expect(await tickets.get(ticketOfB)).toBeNull();
      const hydrated = new CollisionTicket({ db, id: ticketOfB });
      await hydrated.initialize();
      expect(hydrated.title).toBe('');
    });

    it('refuse a hydration filter that names one column twice', async () => {
      GlobalInterceptors.register({
        name: 'where-key-collisions',
        beforeGet(className, filter) {
          if (className !== 'CollisionTicket' || typeof filter === 'string')
            return;
          return { ...filter, ownerId: 'a', owner_id: 'b' };
        },
      });
      await expect(
        new CollisionTicket({ db, id: ticketOfB }).initialize(),
      ).rejects.toThrow(WhereClauseError);
    });
  });

  describe('STI child collections', () => {
    it.each([
      [
        'two spellings',
        () => ({ _meta_type: 'x', _metaType: typeOf('CollisionNote') }),
      ],
      [
        'two spellings, reversed',
        () => ({ _metaType: typeOf('CollisionNote'), _meta_type: 'x' }),
      ],
      ['the alias alone', () => ({ _metaType: typeOf('CollisionNote') })],
      [
        'the canonical key alone',
        () => ({ _meta_type: typeOf('CollisionNote') }),
      ],
      [
        'an explicit equality operator',
        () => ({ '_meta_type =': typeOf('CollisionNote') }),
      ],
      ['a padded key', () => ({ ' _metaType ': typeOf('CollisionNote') })],
    ])('read only their own type when the filter carries %s', async (_label, build) => {
      const where = build();
      expect(titles(await pages.list({ where }))).toEqual(['page']);
      expect(await pages.count({ where })).toBe(1);
      expect(await pages.get({ ...where, id: noteId })).toBeNull();
    });

    it('never widen through an operator filter on the discriminator', async () => {
      for (const where of [
        { '_metaType in': [typeOf('CollisionNote')] },
        { _metaType: [typeOf('CollisionNote')] },
        { '_meta_type !=': typeOf('CollisionPage') },
      ]) {
        expect(await pages.list({ where })).toEqual([]);
        expect(await pages.count({ where })).toBe(0);
      }
    });

    it('apply an in-list on the discriminator the same way under either spelling', async () => {
      const cases: Array<[string[], string[]]> = [
        [[typeOf('CollisionNote')], []],
        [[typeOf('CollisionPage')], ['page']],
        [[typeOf('CollisionPage'), typeOf('CollisionNote')], ['page']],
      ];
      for (const [types, expected] of cases) {
        for (const where of [{ _meta_type: types }, { _metaType: types }]) {
          expect(titles(await pages.list({ where }))).toEqual(expected);
          expect(await pages.count({ where })).toBe(expected.length);
        }
      }
      await expect(
        pages.list({
          where: {
            _meta_type: [typeOf('CollisionPage')],
            '_meta_type in': [typeOf('CollisionNote')],
          },
        }),
      ).rejects.toBeInstanceOf(WhereClauseError);
    });

    it('apply an equality on the discriminator beside their own in-list under either spelling', async () => {
      for (const where of [
        { _meta_type: typeOf('CollisionFeature') },
        { _metaType: typeOf('CollisionFeature') },
      ]) {
        expect(titles(await articles.list({ where }))).toEqual(['feature']);
        expect(await articles.count({ where })).toBe(1);
      }
      for (const where of [
        { _meta_type: typeOf('CollisionNote') },
        { _metaType: typeOf('CollisionNote') },
      ]) {
        expect(await articles.list({ where })).toEqual([]);
      }
    });

    it('with descendants keep their own in-list of types', async () => {
      const own = ['article', 'feature'];
      for (const where of [
        { '_metaType in': [typeOf('CollisionNote')] },
        { _metaType: [typeOf('CollisionNote')] },
        { ' _meta_type  in': [typeOf('CollisionNote')] },
      ]) {
        expect(titles(await articles.list({ where }))).toEqual(own);
        expect(await articles.count({ where })).toBe(2);
      }
      // A narrower caller filter stays in force beside the owned in-list.
      expect(
        titles(
          await articles.list({
            where: { _metaType: typeOf('CollisionFeature') },
          }),
        ),
      ).toEqual(['feature']);
      expect(
        await articles.list({ where: { _metaType: typeOf('CollisionNote') } }),
      ).toEqual([]);
    });

    it('serve only their own type over REST for every spelling', async () => {
      const note = enc(typeOf('CollisionNote'));
      for (const query of [
        `_meta_type=x&_metaType=${note}`,
        `_metaType=${note}&_meta_type=x`,
        `_metaType=${note}`,
        `${enc('_meta_type[=]')}=${note}`,
      ]) {
        const list = await get(`pages?${query}`);
        expect(list.status).toBe(200);
        expect(titles(await list.json())).toEqual(['page']);
        const count = await get(`pages/count?${query}`);
        expect(await count.json()).toEqual({ count: 1 });
      }
    });

    it('the base collection refuses two spellings of the discriminator', async () => {
      const where = {
        _meta_type: typeOf('CollisionPage'),
        _metaType: typeOf('CollisionNote'),
      };
      await expect(contents.list({ where })).rejects.toThrow(WhereClauseError);
      const response = await get(
        `contents?_meta_type=${enc(typeOf('CollisionPage'))}&_metaType=${enc(typeOf('CollisionNote'))}`,
      );
      expect(response.status).toBe(400);
      // One spelling is an ordinary filter on the base collection.
      expect(
        titles(
          await contents.list({
            where: { _metaType: typeOf('CollisionNote') },
          }),
        ),
      ).toEqual(['unrouted note']);
    });
  });

  describe('runtime REST', () => {
    it.each([
      'ownerId=a&owner_id=b',
      'owner_id=b&ownerId=a',
      'ownerId=a&OwnerId=b',
      `ownerId=a&${enc('owner_id =')}=b`,
      `ownerId=a&${enc('owner_id[=]')}=b`,
      `${enc('ownerId[in]')}=a&${enc('owner_id[in]')}=b`,
    ])('answers 400 for ?%s on list and count', async (query) => {
      for (const path of [`tickets?${query}`, `tickets/count?${query}`]) {
        const response = await get(path);
        expect(response.status).toBe(400);
        const body = await response.json();
        expect(body.error).toMatchObject({
          code: 'INVALID_WHERE_CLAUSE',
          ok: false,
          status: 400,
        });
      }
    });

    it('serves a range and a single aliased filter', async () => {
      const ranged = await get(
        `tickets?owner_id=a&${enc('priority[gte]')}=1&${enc('priority[lt]')}=5`,
      );
      expect(ranged.status).toBe(200);
      expect(titles(await ranged.json())).toEqual(['a low']);
      const aliased = await get('tickets/count?OwnerId=b');
      expect(await aliased.json()).toEqual({ count: 1 });
    });
  });

  describe('in-process MCP', () => {
    it('reports a refused where as a tool failure and serves a range', async () => {
      const generator = new MCPGenerator(
        { classNames: ['CollisionTicket'] } as never,
        { db, user: { id: 'reader' } } as never,
      );
      const tools = await generator.generateTools();
      const listTool = tools.find((tool) => tool.name.endsWith('_list'))?.name;
      const call = (where: Record<string, unknown>) =>
        generator.handleToolCall({
          method: 'tools/call',
          params: { name: listTool, arguments: { where } },
        } as never);

      const refused = await call({ ownerId: 'a', owner_id: 'b' });
      expect(refused.isError).toBe(true);
      expect(JSON.stringify(refused.content)).not.toContain('b low');

      const ranged = await call({ 'priority >=': 1, 'priority <': 5 });
      expect(ranged.isError).toBeFalsy();
      expect(titles(JSON.parse(ranged.content[0].text as string).data)).toEqual(
        ['a low', 'b low'],
      );
    });
  });
});
