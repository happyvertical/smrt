/**
 * Both MCP surfaces apply the tenancy a model has when a tool is called:
 * the in-process generator and an emitted server, with the real tenant
 * interceptor on a SQLite file.
 *
 * Rows 10 (MCP), 34 and 35 of the #5375 test-design contract.
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { withSystemContext } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry.js';
import {
  keyOf,
  TENANT_A,
  TENANT_B,
} from './helpers/effective-tenancy-harness.js';

// Tenancy registered at run time, after the emitted server was generated.
@smrt({ mcp: { include: ['list', 'get', 'update', 'delete'] } })
class EffMcpMemo extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffMcpMemoCollection extends SmrtCollection<EffMcpMemo> {
  static readonly _itemClass = EffMcpMemo;
}

// An unscoped STI base with a scoped member.
@smrt({ tableStrategy: 'sti', mcp: { include: ['list', 'get'] } })
class EffMcpNote extends SmrtObject {
  @field({ type: 'text' }) title = '';
}
class EffMcpNoteCollection extends SmrtCollection<EffMcpNote> {
  static readonly _itemClass = EffMcpNote;
}
@smrt({ mcp: { include: ['list', 'get'] } })
@TenantScoped({ mode: 'optional' })
class EffMcpOwnedNote extends EffMcpNote {
  @tenantId({ nullable: true }) tenantId: string | null = null;
}

const ROW = {
  ours: 'aaaaaaaa-0000-4000-8000-00000000000a',
  everyone: 'cccccccc-0000-4000-8000-00000000000c',
  theirs: 'bbbbbbbb-0000-4000-8000-00000000000b',
};

type ToolResult = {
  isError?: boolean;
  content?: Array<{ text: string }>;
};
const textOf = (result: ToolResult) =>
  (result.content ?? []).map((part) => part.text).join('\n');

describe('MCP surfaces apply the tenancy a model has when a tool is called', () => {
  let dir: string;
  let dbUrl: string;
  let db: DatabaseInterface;
  let memos: SmrtCollection<SmrtObject>;
  let notes: SmrtCollection<SmrtObject>;
  let emitted: (name: string, args: unknown) => Promise<ToolResult>;
  const memoTool = () => `${EffMcpMemo.name.toLowerCase()}`;

  const titles = async (table: string) =>
    (await db.query(`SELECT title FROM ${table} ORDER BY title`)).rows.map(
      (row) => String(row.title),
    );
  const inProcess =
    (context: Record<string, unknown>) => (name: string, args: unknown) =>
      new MCPGenerator(
        {},
        { db, user: { id: 'operator' }, ...context },
      ).handleToolCall({
        method: 'tools/call',
        params: { name, arguments: args },
      } as never) as Promise<ToolResult>;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffMcpMemo',
      EffMcpMemoCollection as never,
    );
    ObjectRegistry.registerCollection(
      'EffMcpNote',
      EffMcpNoteCollection as never,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-mcp-'));
    dbUrl = join(dir, 'app.db');
    db = await getTestDatabase({
      type: 'sqlite',
      url: dbUrl,
      classes: [EffMcpMemo, EffMcpNote, EffMcpOwnedNote].map((model) =>
        keyOf(model),
      ),
    });
    memos = (await EffMcpMemoCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    notes = (await EffMcpNoteCollection.create({
      db,
    })) as unknown as SmrtCollection<SmrtObject>;
    enableTenancy();

    // An emitted single-file server, generated while no model is tenant
    // scoped.
    const serverDir = join(
      import.meta.dirname,
      '../../.smrt/effective-tenancy-mcp',
    );
    rmSync(serverDir, { recursive: true, force: true });
    mkdirSync(serverDir, { recursive: true });
    await new MCPGenerator({
      classNames: [keyOf(EffMcpMemo)],
    } as never).generateServer({
      outputPath: join(serverDir, 'index.mjs'),
      modular: false,
      generateClaudeConfigFile: false,
      generateReadme: false,
    } as never);
    vi.doMock('@modelcontextprotocol/server', () => ({
      Server: class {
        handlers = new Map();
        setRequestHandler(name: string, handler: unknown) {
          this.handlers.set(name, handler);
        }
        async sendToolListChanged() {}
      },
    }));
    vi.doMock('@modelcontextprotocol/server/stdio', () => ({
      serveStdio: () => ({ close: async () => {} }),
    }));
    vi.doMock('@happyvertical/smrt-config', () => ({
      loadConfig: async () => ({}),
    }));
    process.env.DATABASE_TYPE = 'sqlite';
    process.env.DATABASE_URL = dbUrl;
    process.env.SMRT_MCP_REGISTER_PATH = join(serverDir, 'no-register.js');
    delete process.env.SMRT_MCP_TENANT_ID;
    const module = (await import(
      /* @vite-ignore */ pathToFileURL(join(serverDir, 'index.mjs')).href
    )) as {
      createServer(): Promise<{
        handlers: Map<string, (request: unknown) => Promise<unknown>>;
      }>;
    };
    const server = await module.createServer();
    emitted = (name, args) =>
      server.handlers.get('tools/call')?.({
        params: { name, arguments: args },
      }) as Promise<ToolResult>;

    registerTenantScopedClass(keyOf(EffMcpMemo), { mode: 'optional' });
  }, 120_000);

  afterAll(async () => {
    unregisterTenantScopedClass(keyOf(EffMcpMemo));
    disableTenancy();
    vi.doUnmock('@modelcontextprotocol/server');
    vi.doUnmock('@modelcontextprotocol/server/stdio');
    vi.doUnmock('@happyvertical/smrt-config');
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(import.meta.dirname, '../../.smrt/effective-tenancy-mcp'), {
      recursive: true,
      force: true,
    });
  });

  beforeEach(async () => {
    await withSystemContext(async () => {
      await db.query(`DELETE FROM ${memos.tableName}`);
      await db.query(`DELETE FROM ${notes.tableName}`);
      await memos.create({
        id: ROW.ours,
        title: 'ours',
        tenantId: TENANT_A,
      } as never);
      await memos.create({ id: ROW.everyone, title: 'everyone' } as never);
      await memos.create({
        id: ROW.theirs,
        title: 'theirs',
        tenantId: TENANT_B,
      } as never);
      await notes.create({ title: 'base note' } as never);
      await notes.create({
        title: 'owned by a',
        tenantId: TENANT_A,
        _meta_type: keyOf(EffMcpOwnedNote),
      } as never);
      await notes.create({
        title: 'owned by b',
        tenantId: TENANT_B,
        _meta_type: keyOf(EffMcpOwnedNote),
      } as never);
    });
  });

  it('a writer with no tenant changes no row of a tenant-scoped model', async () => {
    const call = inProcess({});
    for (const id of [ROW.ours, ROW.everyone, ROW.theirs]) {
      const updated = await call(`${memoTool()}_update`, {
        id,
        title: 'changed',
      });
      expect(updated.isError).toBe(true);
      const deleted = await call(`${memoTool()}_delete`, { id });
      expect(deleted.isError).toBe(true);
    }
    expect(await titles(memos.tableName)).toEqual([
      'everyone',
      'ours',
      'theirs',
    ]);
  });

  it('an emitted tool is gated by tenancy registered after generation', async () => {
    const listed = await emitted(`${memoTool()}_list`, {});
    expect(textOf(listed)).not.toContain('theirs');
    expect(textOf(listed)).not.toContain('ours');
    const updated = await emitted(`${memoTool()}_update`, {
      id: ROW.theirs,
      title: 'changed',
    });
    expect(updated.isError).toBe(true);
    expect(await titles(memos.tableName)).toEqual([
      'everyone',
      'ours',
      'theirs',
    ]);
  });

  it("an in-process tool on an unscoped base excludes a scoped subtype's rows", async () => {
    const listed = await inProcess({ tenantId: TENANT_A })(
      `${EffMcpNote.name.toLowerCase()}_list`,
      {},
    );
    const text = textOf(listed);
    expect(text).toContain('base note');
    expect(text).not.toContain('owned by a');
    expect(text).not.toContain('owned by b');
  });
});
