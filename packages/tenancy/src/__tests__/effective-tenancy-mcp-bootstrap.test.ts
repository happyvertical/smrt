/**
 * An emitted MCP server decides tenancy when a tool is called: a server
 * generated while no model was tenant-scoped, in a process that never turned
 * tenancy on, still gates a model whose tenancy is registered after it
 * started. Both server forms, with the real tenant interceptor on a SQLite
 * file.
 *
 * Row R2.15 of the #5375 round-2 matrix.
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
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withSystemContext } from '../context.js';
import { isTenancyEnabled } from '../enabled-state.js';
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

@smrt({ mcp: { include: ['list', 'get'] } })
class EffBootMemo extends SmrtObject {
  @field({ type: 'text' }) title = '';
  @field({ type: 'text', nullable: true }) tenantId: string | null = null;
}
class EffBootMemoCollection extends SmrtCollection<EffBootMemo> {
  static readonly _itemClass = EffBootMemo;
}

type ToolResult = { isError?: boolean; content?: Array<{ text: string }> };
const textOf = (result: ToolResult) =>
  (result.content ?? []).map((part) => part.text).join('\n');

describe('an emitted MCP server decides tenancy when a tool is called', () => {
  let dir: string;
  let db: DatabaseInterface;
  const serverRoot = join(
    import.meta.dirname,
    '../../.smrt/effective-tenancy-mcp-bootstrap',
  );
  const calls: Record<
    string,
    (name: string, args: unknown) => Promise<ToolResult>
  > = {};

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'EffBootMemo',
      EffBootMemoCollection as never,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-effective-mcp-boot-'));
    const dbUrl = join(dir, 'app.db');
    db = await getTestDatabase({
      type: 'sqlite',
      url: dbUrl,
      classes: [keyOf(EffBootMemo)],
    });
    const memos = await EffBootMemoCollection.create({ db });
    // Seeded while tenancy is on, then turned off: the process the servers
    // run in has no tenancy layer turned on.
    enableTenancy();
    await withSystemContext(async () => {
      await memos.create({ title: 'ours', tenantId: TENANT_A } as never);
      await memos.create({ title: 'everyone' } as never);
      await memos.create({ title: 'theirs', tenantId: TENANT_B } as never);
    });
    disableTenancy();

    rmSync(serverRoot, { recursive: true, force: true });
    mkdirSync(serverRoot, { recursive: true });
    for (const modular of [false, true]) {
      await new MCPGenerator({
        classNames: [keyOf(EffBootMemo)],
      } as never).generateServer({
        outputPath: join(
          serverRoot,
          modular ? 'modular/index.ts' : 'single/index.mjs',
        ),
        modular,
        generateClaudeConfigFile: false,
        generateReadme: false,
      } as never);
    }
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
    vi.doMock('@happyvertical/smrt-tenancy', () => import('../index.js'));
    process.env.DATABASE_TYPE = 'sqlite';
    process.env.DATABASE_URL = dbUrl;
    process.env.SMRT_MCP_REGISTER_PATH = join(serverRoot, 'no-register.js');
    delete process.env.SMRT_MCP_TENANT_ID;

    const single = (await import(
      /* @vite-ignore */ pathToFileURL(join(serverRoot, 'single/index.mjs'))
        .href
    )) as {
      createServer(): Promise<{
        handlers: Map<string, (request: unknown) => Promise<unknown>>;
      }>;
    };
    const server = await single.createServer();
    calls.single = (name, args) =>
      server.handlers.get('tools/call')?.({
        params: { name, arguments: args },
      }) as Promise<ToolResult>;
    const handlers = (await import(
      /* @vite-ignore */ pathToFileURL(
        join(serverRoot, 'modular/handlers/index.ts'),
      ).href
    )) as {
      handleToolCall(name: string, args: unknown): Promise<ToolResult>;
    };
    calls.modular = (name, args) => handlers.handleToolCall(name, args);
  }, 180_000);

  afterAll(async () => {
    unregisterTenantScopedClass(keyOf(EffBootMemo));
    disableTenancy();
    vi.doUnmock('@modelcontextprotocol/server');
    vi.doUnmock('@modelcontextprotocol/server/stdio');
    vi.doUnmock('@happyvertical/smrt-config');
    vi.doUnmock('@happyvertical/smrt-tenancy');
    await db?.close?.();
    rmSync(dir, { recursive: true, force: true });
    rmSync(serverRoot, { recursive: true, force: true });
  });

  it('a tool on a model whose tenancy is registered after the server started is gated, in both server forms', async () => {
    const tool = `${EffBootMemo.name.toLowerCase()}_list`;
    // Before any registration both forms serve every row (control).
    for (const form of ['single', 'modular']) {
      const open = textOf(await calls[form](tool, {}));
      expect(open).toContain('theirs');
    }
    registerTenantScopedClass(keyOf(EffBootMemo), { mode: 'optional' });
    expect(isTenancyEnabled()).toBe(false);
    for (const form of ['single', 'modular']) {
      const result = await calls[form](tool, {});
      const text = textOf(result);
      expect(text).not.toContain('theirs');
      expect(text).not.toContain('ours');
    }
  });
});
