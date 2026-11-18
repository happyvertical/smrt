/**
 * An update body sets declared fields and settable accessors, and nothing
 * else, on every request-facing update path.
 *
 * A loaded object carries more than fields: its methods, its serialisers and
 * its `constructor` are reachable by name too. Each transport assigns an
 * update through `applyUpdateInput`, which refuses a key that names any of
 * those, or nothing the model declares, with a typed 400 that names the key.
 * Responses are serialised by the serialiser the object's class provides.
 *
 * Every transport is executed: runtime REST, in-process MCP, runtime sync
 * apply, and the emitted SvelteKit route, sync route and both MCP servers.
 * Real SQLite file; nothing is mocked.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import { GlobalInterceptors } from '../interceptors.js';
import { SmrtObject } from '../object.js';
import { publicSerializerOf, toPublicJSONValue } from '../public-json.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { processSyncApplyBatch } from '../sync/apply.js';
import { getTestDatabase } from '../testing/database.js';
import {
  classifyUpdateKey,
  resolveUpdateInput,
  STRUCTURAL_UPDATE_RULES,
  WriteInputError,
} from '../write-input.js';
import {
  type EmittedProject,
  emitTransports,
} from './fixtures/emitted-transports.js';

const SECRET = 'HASH-NEVER-SERVED';
const NOTE = 'NOTE-FOR-HOLDERS-ONLY';

@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
class UpdateInputKey extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';

  @field({ type: 'text', sensitive: true })
  secretHash: string = '';

  @field({ type: 'text', readPermission: 'keys.internal' })
  internalNote: string = '';

  @field({ type: 'text' })
  tagsJson: string = '[]';

  /** Derived input: a getter/setter pair over a declared column. */
  get tags(): string[] {
    return JSON.parse(this.tagsJson) as string[];
  }
  set tags(value: string[]) {
    this.tagsJson = JSON.stringify(value);
  }

  /** An accessor with no setter. */
  get labelLength(): number {
    return this.label.length;
  }

  describeSelf(): string {
    return `key ${this.label}`;
  }
}
class UpdateInputKeyCollection extends SmrtCollection<UpdateInputKey> {
  static readonly _itemClass = UpdateInputKey;
}

// The same shape behind an `api.writable` allowlist.
@smrt({
  api: { include: ['list', 'get', 'create', 'update'], writable: ['label'] },
})
class UpdateInputListed extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';

  @field({ type: 'text', sensitive: true })
  secretHash: string = '';
}
class UpdateInputListedCollection extends SmrtCollection<UpdateInputListed> {
  static readonly _itemClass = UpdateInputListed;
}

// One STI family: a routed subtype and a subtype with no generated surface.
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
class UpdateInputDoc extends SmrtObject {
  @field({ type: 'text' })
  title: string = '';
}
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
class UpdateInputArticle extends UpdateInputDoc {}
@smrt({ api: false, mcp: false })
class UpdateInputPage extends UpdateInputDoc {}
class UpdateInputDocCollection extends SmrtCollection<UpdateInputDoc> {
  static readonly _itemClass = UpdateInputDoc;
}
class UpdateInputArticleCollection extends SmrtCollection<UpdateInputArticle> {
  static readonly _itemClass = UpdateInputArticle;
}
class UpdateInputPageCollection extends SmrtCollection<UpdateInputPage> {
  static readonly _itemClass = UpdateInputPage;
}

const CLASSES = [
  'UpdateInputKey',
  'UpdateInputListed',
  'UpdateInputDoc',
  'UpdateInputArticle',
  'UpdateInputPage',
];

/** Keys an update must refuse, with a value a JSON body can carry. */
const REFUSED: Array<[string, unknown]> = [
  ['toPublicJSON', 0],
  ['toJSON', 0],
  ['transformJSON', 0],
  ['save', 0],
  ['describeSelf', 'x'],
  ['constructor', { name: 'UpdateInputPage' }],
  ['toString', 'x'],
  ['hasOwnProperty', 1],
  ['labelLength', 3],
  ['notDeclaredAnywhere', 1],
];

/** What one transport answered to an update. */
interface Outcome {
  /** The update was applied. */
  applied: boolean;
  /** Error code of a refusal, where the transport carries one. */
  code?: string;
  /** Everything the transport returned, as text. */
  text: string;
}

type Model = 'key' | 'article';
interface Transport {
  name: string;
  update(model: Model, id: string, body: unknown): Promise<Outcome>;
}

describe('update input', () => {
  let dir: string;
  let db: DatabaseInterface;
  let keys: UpdateInputKeyCollection;
  let listed: UpdateInputListedCollection;
  let docs: UpdateInputDocCollection;
  let articles: UpdateInputArticleCollection;
  let rest: (req: Request) => Promise<Response>;
  let mcp: MCPGenerator;
  let emitted: EmittedProject;
  const segment = {} as Record<Model | 'listed', string>;
  const registryKey = {} as Record<Model, string>;
  const transports: Transport[] = [];

  beforeAll(async () => {
    for (const [name, collection] of [
      ['UpdateInputKey', UpdateInputKeyCollection],
      ['UpdateInputListed', UpdateInputListedCollection],
      ['UpdateInputDoc', UpdateInputDocCollection],
      ['UpdateInputArticle', UpdateInputArticleCollection],
      ['UpdateInputPage', UpdateInputPageCollection],
    ] as const) {
      ObjectRegistry.registerCollection(name, collection as never);
    }
    dir = mkdtempSync(join(tmpdir(), 'smrt-update-input-'));
    const dbUrl = join(dir, 'app.db');
    db = await getTestDatabase({
      type: 'sqlite',
      url: dbUrl,
      classes: CLASSES,
    });
    keys = await UpdateInputKeyCollection.create({ db });
    listed = await UpdateInputListedCollection.create({ db });
    docs = await UpdateInputDocCollection.create({ db });
    articles = await UpdateInputArticleCollection.create({ db });

    const named = (name: string) => {
      const info = ObjectRegistry.getClass(name);
      if (!info) throw new Error(`${name} is not registered`);
      return info;
    };
    segment.key = named('UpdateInputKey').collection as string;
    segment.listed = named('UpdateInputListed').collection as string;
    segment.article = named('UpdateInputArticle').collection as string;
    registryKey.key = named('UpdateInputKey').qualifiedName as string;
    registryKey.article = named('UpdateInputArticle').qualifiedName as string;

    const api = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req: Request) => req },
      { db },
    );
    api.registerCollection(segment.key, keys as never);
    api.registerCollection(segment.listed, listed as never);
    api.registerCollection(segment.article, articles as never);
    rest = api.generateHandler();
    mcp = new MCPGenerator({}, { db, user: { id: 'user-1' } });

    emitted = await emitTransports(
      ['UpdateInputKey', 'UpdateInputDoc', 'UpdateInputArticle'],
      { db, dbUrl },
    );
    const single = await emitted.mcp({ modular: false });
    const modular = await emitted.mcp({ modular: true });

    const fromResponse = async (response: Response): Promise<Outcome> => {
      const text = await response.text();
      const body = text
        ? (JSON.parse(text) as { error?: { code?: string } })
        : {};
      return {
        applied: response.status === 200,
        code: body.error?.code,
        text: `${response.status} ${text}`,
      };
    };
    const fromTool = (result: {
      isError?: boolean;
      structuredContent?: unknown;
    }): Outcome => ({
      applied: result.isError !== true,
      code: (
        result.structuredContent as { error?: { code?: string } } | undefined
      )?.error?.code,
      text: JSON.stringify(result),
    });
    const fromSync = (body: unknown): Outcome => {
      const [result] = (
        body as { results: Array<{ status: string; reason?: string }> }
      ).results;
      return {
        applied: result.status === 'applied',
        code: result.reason,
        text: JSON.stringify(body),
      };
    };
    const syncBatch = (model: Model, id: string, payload: unknown) => ({
      items: [
        { itemId: 'item-1', object: segment[model], op: 'update', id, payload },
      ],
    });
    const tool = (model: Model) =>
      `${model === 'key' ? 'updateinputkey' : 'updateinputarticle'}_update`;
    const principal = (model: Model) => ({
      user: { id: 'user-1' },
      permissions: [`${segment[model]}.update`],
    });

    transports.push(
      {
        name: 'runtime REST',
        update: async (model, id, body) =>
          fromResponse(
            await rest(
              new Request(`http://local/api/${segment[model]}/${id}`, {
                method: 'PATCH',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body),
              }),
            ),
          ),
      },
      {
        name: 'in-process MCP',
        update: async (model, id, body) =>
          fromTool(
            await mcp.handleToolCall({
              method: 'tools/call',
              params: {
                name: tool(model),
                arguments: { id, ...(body as object) },
              },
            }),
          ),
      },
      {
        name: 'runtime sync apply',
        update: async (model, id, body) => {
          const response = await rest(
            new Request('http://local/api/sync/apply', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(syncBatch(model, id, body)),
            }),
          );
          return fromSync(await response.json());
        },
      },
      {
        name: 'emitted SvelteKit route',
        update: async (model, id, body) => {
          const result = await emitted.http(
            `${segment[model]}/[id]/+server.ts`,
            'PUT',
            { body, params: { id }, locals: principal(model) },
          );
          return {
            applied: result.status === 200,
            code: (result.body as { error?: { code?: string } } | null)?.error
              ?.code,
            text: `${result.status} ${JSON.stringify(result.body)}`,
          };
        },
      },
      {
        name: 'emitted sync route',
        update: async (model, id, body) => {
          const result = await emitted.http('sync/apply/+server.ts', 'POST', {
            body: syncBatch(model, id, body),
            locals: principal(model),
          });
          return fromSync(result.body);
        },
      },
      {
        name: 'emitted MCP server (single file)',
        update: async (model, id, body) =>
          fromTool(await single.call(tool(model), { id, ...(body as object) })),
      },
      {
        name: 'emitted MCP server (modular)',
        update: async (model, id, body) =>
          fromTool(
            await modular.call(tool(model), { id, ...(body as object) }),
          ),
      },
    );
  });

  afterEach(() => {
    GlobalInterceptors.unregister('update-input-own-serializer');
  });

  afterAll(async () => {
    emitted?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const seedKey = async () =>
    (
      await keys.create({
        label: 'original',
        secretHash: SECRET,
        internalNote: NOTE,
      })
    ).id as string;
  const seedArticle = async () =>
    (await articles.create({ title: 'original' })).id as string;
  const keyRow = async (id: string) =>
    (
      await db.query(
        `SELECT label, tags_json FROM ${keys.tableName} WHERE id = $1`,
        [id],
      )
    ).rows[0] as { label: string; tags_json: string };
  const docRow = async (id: string) =>
    (
      await db.query(
        `SELECT title, _meta_type FROM ${docs.tableName} WHERE id = $1`,
        [id],
      )
    ).rows[0] as { title: string; _meta_type: string };

  // Run a case once per transport. The list is filled in `beforeAll`, so the
  // names are fixed here and resolved when a case runs.
  const TRANSPORTS = [
    'runtime REST',
    'in-process MCP',
    'runtime sync apply',
    'emitted SvelteKit route',
    'emitted sync route',
    'emitted MCP server (single file)',
    'emitted MCP server (modular)',
  ];
  const transport = (name: string) => {
    const found = transports.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`No transport named ${name}`);
    return found;
  };

  describe('the rule', () => {
    it('classifies what an assignment would reach', () => {
      const instance = new UpdateInputKey({ db, _skipRegistration: true });
      expect(classifyUpdateKey(instance, 'label')).toBe('data');
      expect(classifyUpdateKey(instance, 'tags')).toBe('accessor');
      expect(classifyUpdateKey(instance, 'slug')).toBe('accessor');
      expect(classifyUpdateKey(instance, 'labelLength')).toBe('refused');
      expect(classifyUpdateKey(instance, 'describeSelf')).toBe('refused');
      expect(classifyUpdateKey(instance, 'toPublicJSON')).toBe('refused');
      expect(classifyUpdateKey(instance, 'constructor')).toBe('refused');
      expect(classifyUpdateKey(instance, '__proto__')).toBe('refused');
      expect(classifyUpdateKey(instance, 'valueOf')).toBe('refused');
      expect(classifyUpdateKey(instance, 'neverHeardOf')).toBe('absent');
    });

    it('checks every key before assigning any', () => {
      const row = { title: 'a', count: 1, save() {} };
      expect(() =>
        resolveUpdateInput(
          row,
          { title: 'b', save: 0 },
          STRUCTURAL_UPDATE_RULES,
        ),
      ).toThrow(WriteInputError);
      expect(row.title).toBe('a');
      expect(
        resolveUpdateInput(
          row,
          { title: 'b', count: 2 },
          STRUCTURAL_UPDATE_RULES,
        ),
      ).toEqual(['title', 'count']);
    });

    it('never treats a service option or the options bag as row data', () => {
      const row = { title: 'a', options: {}, db: 'handle' };
      for (const key of ['options', 'db', 'ai']) {
        expect(() =>
          resolveUpdateInput(row, { [key]: {} }, STRUCTURAL_UPDATE_RULES),
        ).toThrow(WriteInputError);
      }
    });

    it('reads the public serialiser from the class, not the instance', () => {
      const instance = new UpdateInputKey({ db, _skipRegistration: true });
      const inherited = publicSerializerOf(instance);
      expect(inherited).toBeTypeOf('function');
      (instance as unknown as Record<string, unknown>).toPublicJSON = 0;
      expect(publicSerializerOf(instance)).toBeTypeOf('function');
      (instance as unknown as Record<string, unknown>).toPublicJSON = () => ({
        everything: true,
      });
      expect(toPublicJSONValue(instance)).not.toHaveProperty('everything');
      // A value object with no class behind it may carry its own serialiser.
      expect(
        toPublicJSONValue({ toPublicJSON: () => ({ shaped: true }) }),
      ).toEqual({ shaped: true });
      expect(toPublicJSONValue({ plain: 1 })).toEqual({ plain: 1 });
      expect(toPublicJSONValue(null)).toBeNull();
    });
  });

  describe.each(TRANSPORTS)('%s', (name) => {
    it('sets a declared field and a settable accessor', async () => {
      const id = await seedKey();
      const outcome = await transport(name).update('key', id, {
        label: 'renamed',
        tags: ['a', 'b'],
      });
      expect(outcome.text).not.toContain(SECRET);
      expect(outcome.text).not.toContain(NOTE);
      expect(outcome.applied).toBe(true);
      expect(await keyRow(id)).toEqual({
        label: 'renamed',
        tags_json: '["a","b"]',
      });
    });

    it.each(REFUSED)('refuses %s and changes nothing', async (key, value) => {
      const id = await seedKey();
      const outcome = await transport(name).update('key', id, {
        label: 'changed',
        [key]: value,
      });
      expect(outcome.applied).toBe(false);
      expect(outcome.text).not.toContain(SECRET);
      expect(outcome.text).not.toContain(NOTE);
      if (name.includes('sync')) {
        expect(outcome.code).toBe('invalid_payload');
      } else {
        expect(outcome.code).toBe('VALIDATION_UNKNOWN_FIELD');
        expect(outcome.text).toContain(`Field '${key}' cannot be set.`);
      }
      expect((await keyRow(id)).label).toBe('original');
    });

    it('keeps a subtype row the type it was created as', async () => {
      const id = await seedArticle();
      const before = (await docRow(id))._meta_type;
      const outcome = await transport(name).update('article', id, {
        title: 'moved',
        constructor: { name: 'UpdateInputPage' },
      });
      expect(outcome.applied).toBe(false);
      expect(await docRow(id)).toEqual({
        title: 'original',
        _meta_type: before,
      });

      // The same row is still updated through its own route.
      const control = await transport(name).update('article', id, {
        title: 'edited',
      });
      expect(control.applied).toBe(true);
      expect(await docRow(id)).toEqual({ title: 'edited', _meta_type: before });
    });
  });

  describe('runtime REST', () => {
    const patch = (path: string, body: unknown) =>
      rest(
        new Request(`http://local/api/${path}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );

    it('answers a refused key with a 400 that names it', async () => {
      const id = await seedKey();
      const response = await patch(`${segment.key}/${id}`, { save: 0 });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: {
          code: 'VALIDATION_UNKNOWN_FIELD',
          message: "Field 'save' cannot be set.",
          ok: false,
          status: 400,
        },
      });
    });

    it('still drops the keys a body may carry back from a read', async () => {
      const id = await seedKey();
      const read = await rest(
        new Request(`http://local/api/${segment.key}/${id}`),
      );
      const body = (await read.json()) as Record<string, unknown>;
      const response = await patch(`${segment.key}/${id}`, {
        ...body,
        label: 'round trip',
      });
      expect(response.status).toBe(200);
      expect((await keyRow(id)).label).toBe('round trip');
    });

    it('a model with an api.writable allowlist keeps dropping other keys', async () => {
      const created = await listed.create({ label: 'a', secretHash: SECRET });
      const response = await patch(`${segment.listed}/${created.id}`, {
        label: 'b',
        toPublicJSON: 0,
        secretHash: 'replaced',
      });
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(SECRET);
      expect(JSON.parse(text).label).toBe('b');
    });

    it('serialises through the class when an instance carries its own property', async () => {
      const id = await seedKey();
      GlobalInterceptors.register({
        name: 'update-input-own-serializer',
        afterGet(_className, instance) {
          if (instance) {
            (instance as unknown as Record<string, unknown>).toPublicJSON = 0;
          }
          return instance;
        },
      });
      const response = await rest(
        new Request(`http://local/api/${segment.key}/${id}`),
      );
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(NOTE);
      expect(JSON.parse(text).label).toBe('original');
    });
  });

  describe('in-process MCP', () => {
    it('serialises through the class when an instance carries its own property', async () => {
      const id = await seedKey();
      GlobalInterceptors.register({
        name: 'update-input-own-serializer',
        afterGet(_className, instance) {
          if (instance) {
            (instance as unknown as Record<string, unknown>).toPublicJSON = 0;
          }
          return instance;
        },
      });
      const result = await mcp.handleToolCall({
        method: 'tools/call',
        params: { name: 'updateinputkey_get', arguments: { id } },
      });
      const text = JSON.stringify(result);
      expect(result.isError).not.toBe(true);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(NOTE);
      expect(text).toContain('original');
    });
  });

  describe('emitted transports', () => {
    it('serialise through the class when an instance carries its own property', async () => {
      const id = await seedKey();
      GlobalInterceptors.register({
        name: 'update-input-own-serializer',
        afterGet(_className, instance) {
          if (instance) {
            (instance as unknown as Record<string, unknown>).toPublicJSON = 0;
          }
          return instance;
        },
      });
      const route = await emitted.http(
        `${segment.key}/[id]/+server.ts`,
        'GET',
        {
          params: { id },
          locals: { user: { id: 'user-1' } },
        },
      );
      expect(route.status).toBe(200);
      expect(JSON.stringify(route.body)).not.toContain(SECRET);
      expect((route.body as { label: string }).label).toBe('original');

      for (const modular of [false, true]) {
        const server = await emitted.mcp({ modular });
        const result = await server.call('updateinputkey_get', { id });
        expect(result.isError).not.toBe(true);
        expect(JSON.stringify(result)).not.toContain(SECRET);
        expect(JSON.stringify(result)).toContain('original');
      }
    });
  });

  describe('collection.update()', () => {
    it.each([
      'constructor',
      'toString',
      'hasOwnProperty',
      'valueOf',
      'notDeclaredAnywhere',
    ])('refuses %s', async (key) => {
      const id = await seedArticle();
      const before = await docRow(id);
      await expect(
        articles.update(id, { [key]: { name: 'UpdateInputPage' } } as never),
      ).rejects.toMatchObject({
        code: 'VALIDATION_UNKNOWN_FIELD',
        status: 400,
        message: `Collection update cannot assign field '${key}'`,
      });
      expect(await docRow(id)).toEqual(before);
    });

    it('updates a declared field', async () => {
      const id = await seedArticle();
      const updated = await articles.update(id, { title: 'edited' });
      expect(updated?.title).toBe('edited');
      expect((await docRow(id)).title).toBe('edited');
    });
  });

  describe('the structural sync processor', () => {
    it('assigns a row with no host mutation seam by the same rule', async () => {
      const saved: string[] = [];
      const row = {
        id: '0f8fad5b-d9cb-469f-a165-70867728950e',
        title: 'a',
        updated_at: null,
        async save() {
          saved.push(this.title);
        },
        async delete() {},
      };
      const host = {
        resolveTarget: () => ({
          objectName: 'Row',
          collection: {
            get: async () => row,
            create: async () => row,
          },
          isOpAllowed: () => true,
          authorize: () => 'ok' as const,
          prepare: (payload: Record<string, unknown>) => payload,
        }),
      };
      const apply = async (payload: unknown) =>
        (
          await processSyncApplyBatch(
            {
              items: [
                {
                  itemId: 'i',
                  object: 'rows',
                  op: 'update',
                  id: row.id,
                  payload,
                },
              ],
            },
            host,
          )
        ).body;

      expect(await apply({ title: 'b', save: 0 })).toMatchObject({
        results: [{ status: 'rejected', reason: 'invalid_payload' }],
      });
      expect(row.title).toBe('a');
      expect(await apply({ title: 'b' })).toMatchObject({
        results: [{ status: 'applied' }],
      });
      expect(saved).toEqual(['b']);
    });
  });
});
