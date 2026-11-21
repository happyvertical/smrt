/**
 * A generated tool acts on the row its identifier names, or on none.
 *
 * MCP arguments are untyped JSON. The get, update, delete and item-action
 * tools of all three MCP implementations (in-process, emitted single-file,
 * emitted modular) read `id` / `slug` through one shared check and use it
 * only when it is a non-empty string. `collection.get()` and
 * `collection.delete()` refuse a filter that names no row, for custom actions
 * and application code that reach them directly.
 *
 * The emitted servers are executed over a real SQLite file; nothing is mocked.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { MCPGenerator } from '../generators/mcp.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';
import {
  identifierArgument,
  requireIdentifierArgument,
  ToolArgumentError,
} from '../tool-arguments.js';
import { assertGetFilter } from '../where-keys.js';
import {
  type EmittedProject,
  type EmittedToolResult,
  emitTransports,
} from './fixtures/emitted-transports.js';

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete', 'bump'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'delete', 'bump'] },
})
class ToolIdItem extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';

  @field({ type: 'integer' })
  price: number = 0;

  /** An item-scoped custom action. */
  async bump(): Promise<{ price: number }> {
    this.price += 1;
    await this.save();
    return { price: this.price };
  }
}
class ToolIdItemCollection extends SmrtCollection<ToolIdItem> {
  static readonly _itemClass = ToolIdItem;
}

/** Identifier values that name no row. `null` and `''` count as absent. */
const NOT_AN_IDENTIFIER: Array<[string, unknown]> = [
  ['a number', 42],
  ['zero', 0],
  ['true', true],
  ['false', false],
  ['an empty object', {}],
  ['an object of conditions', { label: 'r3' }],
  ['an empty array', []],
  ['an array', ['r1']],
];

type Call = (name: string, args: unknown) => Promise<EmittedToolResult>;

const IMPLEMENTATIONS = [
  'in-process MCP',
  'emitted MCP server (single file)',
  'emitted MCP server (modular)',
];

describe('tool identifier arguments', () => {
  let dir: string;
  let db: DatabaseInterface;
  let items: ToolIdItemCollection;
  let emitted: EmittedProject;
  const calls: Record<string, Call> = {};
  const ids: Record<string, string> = {};

  const rows = async () =>
    (
      await db.query(
        `SELECT label, price FROM ${items.tableName} ORDER BY label`,
      )
    ).rows.map((row) => `${row.label}:${row.price}`);
  const errorOf = (result: EmittedToolResult) =>
    (
      result.structuredContent as {
        error?: { code?: string; message?: string };
      }
    )?.error;

  beforeAll(async () => {
    ObjectRegistry.registerCollection('ToolIdItem', ToolIdItemCollection);
    dir = mkdtempSync(join(tmpdir(), 'smrt-tool-ids-'));
    const dbUrl = join(dir, 'app.db');
    db = await getTestDatabase({
      type: 'sqlite',
      url: dbUrl,
      classes: ['ToolIdItem'],
    });
    items = await ToolIdItemCollection.create({ db });
    emitted = await emitTransports(['ToolIdItem'], { db, dbUrl });

    const inProcess = new MCPGenerator({}, { db, user: { id: 'user-1' } });
    calls['in-process MCP'] = (name, args) =>
      inProcess.handleToolCall({
        method: 'tools/call',
        params: { name, arguments: args as Record<string, unknown> },
      }) as Promise<EmittedToolResult>;
    calls['emitted MCP server (single file)'] = (
      await emitted.mcp({ modular: false })
    ).call;
    calls['emitted MCP server (modular)'] = (
      await emitted.mcp({ modular: true })
    ).call;
  });

  beforeEach(async () => {
    await db.query(`DELETE FROM ${items.tableName}`);
    for (const label of ['r1', 'r2', 'r3', 'r4']) {
      ids[label] = (await items.create({ label, price: 100 })).id as string;
    }
  });

  afterAll(async () => {
    emitted?.dispose();
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const UNCHANGED = ['r1:100', 'r2:100', 'r3:100', 'r4:100'];

  describe('the check', () => {
    it('reads a non-empty string and nothing else as an identifier', () => {
      expect(identifierArgument({ id: 'abc' }, 'id')).toBe('abc');
      for (const absent of [undefined, null, '']) {
        expect(identifierArgument({ id: absent }, 'id')).toBeUndefined();
      }
      expect(identifierArgument(undefined, 'id')).toBeUndefined();
      for (const [, value] of NOT_AN_IDENTIFIER) {
        expect(() => identifierArgument({ id: value }, 'id')).toThrow(
          ToolArgumentError,
        );
      }
      expect(requireIdentifierArgument({ slug: 's' }, ['id', 'slug'])).toBe(
        's',
      );
      expect(() => requireIdentifierArgument({}, ['id', 'slug'])).toThrow(
        expect.objectContaining({
          status: 400,
          code: 'VALIDATION_INVALID_ARGUMENT',
          publicMessage: "'id' or 'slug' is required.",
        }),
      );
      // A present, unusable `id` is refused; it does not fall back to `slug`.
      expect(() =>
        requireIdentifierArgument({ id: 42, slug: 's' }, ['id', 'slug']),
      ).toThrow(ToolArgumentError);
    });
  });

  describe.each(IMPLEMENTATIONS)('%s', (implementation) => {
    const call: Call = (name, args) => calls[implementation](name, args);

    it.each(
      NOT_AN_IDENTIFIER,
    )('get, update, delete and an item action refuse %s as an id', async (_label, id) => {
      for (const [tool, extra] of [
        ['toolidItem_get', {}],
        ['toolidItem_update', { price: 0 }],
        ['toolidItem_delete', {}],
        ['toolidItem_bump', {}],
      ] as const) {
        const result = await call(tool.toLowerCase(), { id, ...extra });
        expect(result.isError).toBe(true);
        expect(errorOf(result)).toEqual({
          code: 'VALIDATION_INVALID_ARGUMENT',
          message: "'id' must be a non-empty string.",
        });
        expect(JSON.stringify(result)).not.toContain(ids.r1);
      }
      expect(await rows()).toEqual(UNCHANGED);
    });

    it('get refuses a slug that is not a string', async () => {
      const result = await call('toolidItem_get'.toLowerCase(), {
        slug: { label: 'r3' },
      });
      expect(result.isError).toBe(true);
      expect(errorOf(result)?.code).toBe('VALIDATION_INVALID_ARGUMENT');
    });

    it('reports a missing id as before', async () => {
      const cases: Array<[string, string]> = [
        ['toolidItem_get', 'Either id or slug is required'],
        ['toolidItem_update', 'ID is required for update'],
        ['toolidItem_delete', 'ID is required for delete'],
      ];
      for (const [tool, message] of cases) {
        for (const args of [{}, { id: null }, { id: '' }]) {
          const result = await call(tool.toLowerCase(), args);
          expect(result.isError).toBe(true);
          expect(errorOf(result)?.message).toBe(message);
        }
      }
      expect(await rows()).toEqual(UNCHANGED);
    });

    it('acts on the row a string id names', async () => {
      const read = await call('toolidItem_get'.toLowerCase(), { id: ids.r3 });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ label: 'r3' });

      const updated = await call('toolidItem_update'.toLowerCase(), {
        id: ids.r3,
        price: 7,
      });
      expect(updated.isError).not.toBe(true);

      const bumped = await call('toolidItem_bump'.toLowerCase(), {
        id: ids.r2,
      });
      expect(bumped.isError).not.toBe(true);

      const deleted = await call('toolidItem_delete'.toLowerCase(), {
        id: ids.r4,
      });
      expect(deleted.isError).not.toBe(true);
      expect(await rows()).toEqual(['r1:100', 'r2:101', 'r3:7']);
    });

    it('get finds a row by its slug', async () => {
      const row = await items.get(ids.r2);
      const read = await call('toolidItem_get'.toLowerCase(), {
        slug: row?.slug,
      });
      expect(read.isError).not.toBe(true);
      expect(read.structuredContent).toMatchObject({ label: 'r2' });
    });
  });

  describe('collection.get() and collection.delete()', () => {
    const NOT_A_FILTER: Array<[string, unknown]> = [
      ['a number', 42],
      ['true', true],
      ['null', null],
      ['undefined', undefined],
      ['an empty object', {}],
      ['an empty array', []],
      ['an array of conditions', [{ label: 'r3' }]],
      ['a class instance', new Date()],
    ];

    it.each(NOT_A_FILTER)('refuse %s', async (_label, filter) => {
      const refusal = { status: 400, code: 'INVALID_GET_FILTER' };
      expect(() => assertGetFilter(filter)).toThrow(
        expect.objectContaining(refusal),
      );
      await expect(items.get(filter as never)).rejects.toMatchObject(refusal);
      await expect(items.delete(filter as never)).rejects.toMatchObject(
        refusal,
      );
      expect(await rows()).toEqual(UNCHANGED);
    });

    it('serve an id, a slug and an object of conditions', async () => {
      expect((await items.get(ids.r1))?.label).toBe('r1');
      const slug = (await items.get(ids.r2))?.slug as string;
      expect((await items.get(slug))?.label).toBe('r2');
      expect((await items.get({ label: 'r3' }))?.label).toBe('r3');
      expect(await items.get('no-such-row')).toBeNull();
      expect(await items.delete('no-such-row')).toBe(false);
      expect(await items.delete(ids.r4)).toBe(true);
      expect(await rows()).toEqual(['r1:100', 'r2:100', 'r3:100']);
    });
  });
});
