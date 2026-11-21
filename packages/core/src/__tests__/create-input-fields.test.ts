/**
 * Create input names declared fields and settable accessors only.
 *
 * A model constructor may copy its options onto the instance, so a request
 * key that is not a field would become an own property of the new object.
 * Every request-facing create refuses such a key with
 * `VALIDATION_UNKNOWN_FIELD` (a typed 400; a sync item `rejected` /
 * `invalid_payload`) and writes nothing: runtime REST, the emitted SvelteKit
 * route, the in-process and both emitted MCP servers, runtime and emitted
 * sync apply. A sync update payload is checked before replay or staleness is
 * answered.
 *
 * Real SQLite file; nothing is mocked.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { MCPGenerator } from '../generators/mcp.js';
import { APIGenerator } from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';
import {
  type EmittedProject,
  type EmittedToolResult,
  emitTransports,
} from './fixtures/emitted-transports.js';

const ROW_ID = '11111111-2222-4333-8444-555555555555';

@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create', 'update'] },
})
class CreateInputNote extends SmrtObject {
  @field({ type: 'text' })
  title = '';
}
class CreateInputNoteCollection extends SmrtCollection<CreateInputNote> {
  static readonly _itemClass = CreateInputNote;
}

type Outcome = { created: boolean; code?: string };

describe('create input fields', () => {
  let dir: string;
  let db: DatabaseInterface;
  let notes: CreateInputNoteCollection;
  let emitted: EmittedProject;
  let segment: string;
  const creates: Record<
    string,
    (body: Record<string, unknown>) => Promise<Outcome>
  > = {};

  const titles = async () =>
    (
      await db.query(`SELECT title FROM ${notes.tableName} ORDER BY title`)
    ).rows.map((row) => row.title);
  const syncCreate = (body: Record<string, unknown>) => ({
    items: [
      {
        itemId: 'item-1',
        object: segment,
        op: 'create',
        id: crypto.randomUUID(),
        payload: body,
      },
    ],
  });
  const fromSync = (body: unknown): Outcome => {
    const [result] = (
      body as { results: Array<{ status: string; reason?: string }> }
    ).results;
    return { created: result.status === 'applied', code: result.reason };
  };
  const fromTool = (result: EmittedToolResult): Outcome => ({
    created: !result.isError,
    code: (
      result.structuredContent as { error?: { code?: string } } | undefined
    )?.error?.code,
  });

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'CreateInputNote',
      CreateInputNoteCollection,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-create-input-'));
    const dbUrl = join(dir, 'app.db');
    db = await getTestDatabase({
      type: 'sqlite',
      url: dbUrl,
      classes: ['CreateInputNote'],
    });
    notes = await CreateInputNoteCollection.create({ db });
    segment = ObjectRegistry.getClass('CreateInputNote')?.collection as string;
    emitted = await emitTransports(['CreateInputNote'], { db, dbUrl });
    const rest = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req) => req },
      { db },
    ).generateHandler();
    const post = (path: string, body: unknown) =>
      rest(
        new Request(`http://local/api/${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    const locals = {
      user: { id: 'user-1' },
      permissions: [`${segment}.create`, `${segment}.update`],
    };
    creates['runtime REST'] = async (body) => {
      const response = await post(segment, body);
      const payload = (await response.json()) as { error?: { code?: string } };
      return { created: response.status === 201, code: payload.error?.code };
    };
    creates['emitted SvelteKit route'] = async (body) => {
      const result = await emitted.http(`${segment}/+server.ts`, 'POST', {
        body,
        locals,
      });
      return {
        created: result.status === 201,
        code: (result.body as { error?: { code?: string } } | null)?.error
          ?.code,
      };
    };
    creates['runtime sync apply'] = async (body) =>
      fromSync(await (await post('sync/apply', syncCreate(body))).json());
    creates['emitted sync route'] = async (body) =>
      fromSync(
        (
          await emitted.http('sync/apply/+server.ts', 'POST', {
            body: syncCreate(body),
            locals,
          })
        ).body,
      );
    const inProcess = new MCPGenerator({}, { db, user: { id: 'user-1' } });
    creates['in-process MCP'] = async (body) =>
      fromTool(
        (await inProcess.handleToolCall({
          method: 'tools/call',
          params: { name: 'createinputnote_create', arguments: body },
        })) as EmittedToolResult,
      );
    for (const [name, modular] of [
      ['emitted MCP server (single file)', false],
      ['emitted MCP server (modular)', true],
    ] as const) {
      const server = await emitted.mcp({ modular });
      creates[name] = async (body) =>
        fromTool(await server.call('createinputnote_create', body));
    }
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM ${notes.tableName}`);
  });

  afterAll(async () => {
    emitted?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  describe.each([
    'runtime REST',
    'emitted SvelteKit route',
    'in-process MCP',
    'emitted MCP server (single file)',
    'emitted MCP server (modular)',
    'runtime sync apply',
    'emitted sync route',
  ])('%s', (transport) => {
    it.each([
      ['a key the model does not declare', { title: 'x', notAField: 'y' }],
      ['a method name', { title: 'x', save: 'y' }],
      ['the public serialiser name', { title: 'x', toPublicJSON: 1 }],
    ])('refuses %s and writes nothing', async (_label, body) => {
      const outcome = await creates[transport](body);
      expect(outcome.created).toBe(false);
      expect(outcome.code).toBe(
        transport.includes('sync')
          ? 'invalid_payload'
          : 'VALIDATION_UNKNOWN_FIELD',
      );
      expect(await titles()).toEqual([]);
    });

    it('creates from declared fields', async () => {
      expect((await creates[transport]({ title: 'ok' })).created).toBe(true);
      expect(await titles()).toEqual(['ok']);
    });
  });

  describe('a sync update payload', () => {
    const update = async (payload: Record<string, unknown>, extra = {}) => {
      const rest = new APIGenerator(
        { basePath: '/api', authMiddleware: () => async (req) => req },
        { db },
      ).generateHandler();
      const response = await rest(
        new Request('http://local/api/sync/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            items: [
              {
                itemId: 'item-1',
                object: segment,
                op: 'update',
                id: ROW_ID,
                payload,
                ...extra,
              },
            ],
          }),
        }),
      );
      return ((await response.json()) as { results: unknown[] }).results[0];
    };

    beforeEach(async () => {
      await notes.create({ id: ROW_ID, title: 'stored' } as never);
    });

    it('is refused before it is reported as a replay', async () => {
      expect(await update({ notAField: 'y' })).toMatchObject({
        status: 'rejected',
        reason: 'invalid_payload',
      });
    });

    it('is refused before it is reported as stale', async () => {
      expect(
        await update(
          { title: 'stored', notAField: 'y' },
          { baseUpdatedAt: '2000-01-01T00:00:00.000Z' },
        ),
      ).toMatchObject({ status: 'rejected', reason: 'invalid_payload' });
    });
  });
});
