/**
 * A family member of equal tenancy is served through its base only where the
 * member itself is served to the caller: on the server's model list, switched
 * on, readable by the caller, and open for the operation performed. Emitted
 * routes and the in-process MCP surface, with the real tenant interceptor on
 * a SQLite file.
 *
 * Rows R2.13 and R2.14 of the #5375 round-2 matrix.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  setRuntimeModelReadiness,
  smrt,
} from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
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

// An unscoped base anyone may read, and members of the same (no) tenancy.
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get'], public: 'read' },
  mcp: { include: ['list', 'get'] },
})
class EffMemberShelf extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffMemberShelfCollection extends SmrtCollection<EffMemberShelf> {
  static readonly _itemClass = EffMemberShelf;
}
/** Readable by anyone, like its base. */
@smrt({
  api: { include: ['list', 'get'], public: 'read' },
  mcp: { include: ['list', 'get'] },
})
class EffMemberOpenBook extends EffMemberShelf {}
/** Readable only by a signed-in caller. */
@smrt({ api: { include: ['list', 'get'] }, mcp: { include: ['list', 'get'] } })
class EffMemberPrivateBook extends EffMemberShelf {}
/** Switched off in the tests that close it. */
@smrt({
  api: { include: ['list', 'get'], public: 'read' },
  mcp: { include: ['list', 'get'] },
})
class EffMemberClosedBook extends EffMemberShelf {}
/** Listed on MCP, never read by id there. */
@smrt({
  api: { include: ['list', 'get'], public: 'read' },
  mcp: { include: ['list'] },
})
class EffMemberListedBook extends EffMemberShelf {}
/** Read by id on MCP, never listed there. */
@smrt({
  api: { include: ['list', 'get'], public: 'read' },
  mcp: { include: ['get'] },
})
class EffMemberFetchedBook extends EffMemberShelf {}

const ROW = {
  open: 'aaaaaaaa-0000-4000-8000-00000000000a',
  private: 'bbbbbbbb-0000-4000-8000-00000000000b',
  closed: 'cccccccc-0000-4000-8000-00000000000c',
  listed: 'dddddddd-0000-4000-8000-00000000000d',
  fetched: 'eeeeeeee-0000-4000-8000-00000000000e',
};

type ToolResult = { isError?: boolean; content?: Array<{ text: string }> };
const textOf = (result: ToolResult) =>
  (result.content ?? []).map((part) => part.text).join('\n');

describe('a family member is served through its base only where it is served itself', () => {
  let dir: string;
  let db: DatabaseInterface;
  let shelves: SmrtCollection<SmrtObject>;
  let app: EmittedApp;
  const collections = new Map<string, unknown>();
  const models = [
    EffMemberShelf,
    EffMemberOpenBook,
    EffMemberPrivateBook,
    EffMemberClosedBook,
    EffMemberListedBook,
    EffMemberFetchedBook,
  ];

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffMemberShelf',
      EffMemberShelfCollection as never,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-members-'));
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: models.map((model) => keyOf(model)),
    });
    shelves = (await EffMemberShelfCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    collections.set(keyOf(EffMemberShelf), shelves);
    collections.set('EffMemberShelf', shelves);
    enableTenancy();
    app = await emitApp('effective-tenancy-members', models, collections);
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
      for (const [id, title, model] of [
        [ROW.open, 'open book', EffMemberOpenBook],
        [ROW.private, 'private book', EffMemberPrivateBook],
        [ROW.closed, 'closed book', EffMemberClosedBook],
        [ROW.listed, 'listed book', EffMemberListedBook],
        [ROW.fetched, 'fetched book', EffMemberFetchedBook],
      ] as const) {
        await shelves.create({ id, title, _meta_type: keyOf(model) } as never);
      }
    });
  });

  describe('emitted routes (R2.13)', () => {
    it('a base read leaves out a member the caller may not read or that is switched off', async () => {
      const closed = keyOf(EffMemberClosedBook);
      setRuntimeModelReadiness([closed], false);
      try {
        const anonymous = await app.call('GET', segmentOf(EffMemberShelf));
        expect(anonymous.status).toBe(200);
        expect(titlesOf(anonymous.body)).toEqual([
          'fetched book',
          'listed book',
          'open book',
          'shelf',
        ]);
        const hidden = await app.call(
          'GET',
          `${segmentOf(EffMemberShelf)}/[id]`,
          { params: { id: ROW.private } },
        );
        expect(hidden.status).toBe(404);
        // A signed-in caller reads the private member too.
        const signedIn = await app.call('GET', segmentOf(EffMemberShelf), {
          locals: { user: { id: 'reader' } },
        });
        expect(titlesOf(signedIn.body)).toEqual([
          'fetched book',
          'listed book',
          'open book',
          'private book',
          'shelf',
        ]);
      } finally {
        setRuntimeModelReadiness([closed], undefined);
      }
    });
  });

  describe('in-process MCP (R2.14)', () => {
    const call =
      (config: Record<string, unknown>, context: Record<string, unknown>) =>
      (name: string, args: unknown) =>
        new MCPGenerator(config, { db, ...context }).handleToolCall({
          method: 'tools/call',
          params: { name, arguments: args },
        } as never) as Promise<ToolResult>;
    const tool = `${EffMemberShelf.name.toLowerCase()}`;

    it("a base tool leaves out a member outside the server's models, switched off, or private to an anonymous caller", async () => {
      const closed = keyOf(EffMemberClosedBook);
      setRuntimeModelReadiness([closed], false);
      try {
        const scoped = call(
          {
            classNames: [EffMemberShelf, EffMemberOpenBook].map((model) =>
              keyOf(model),
            ),
          },
          { user: { id: 'reader' } },
        );
        const listed = textOf(await scoped(`${tool}_list`, {}));
        expect(listed).toContain('open book');
        expect(listed).toContain('shelf');
        expect(listed).not.toContain('private book');
        expect(listed).not.toContain('closed book');

        const anonymous = textOf(await call({}, {})(`${tool}_list`, {}));
        expect(anonymous).toContain('open book');
        expect(anonymous).not.toContain('private book');
        expect(anonymous).not.toContain('closed book');
      } finally {
        setRuntimeModelReadiness([closed], undefined);
      }
    });

    it('a base point read serves a member open for a read by id, and a base list one open for a list', async () => {
      const signedIn = call({}, { user: { id: 'reader' } });
      const fetched = await signedIn(`${tool}_get`, { id: ROW.fetched });
      expect(textOf(fetched)).toContain('fetched book');
      const listedById = await signedIn(`${tool}_get`, { id: ROW.listed });
      expect(textOf(listedById)).not.toContain('listed book');
      const list = textOf(await signedIn(`${tool}_list`, {}));
      expect(list).toContain('listed book');
      expect(list).not.toContain('fetched book');
    });
  });
});
