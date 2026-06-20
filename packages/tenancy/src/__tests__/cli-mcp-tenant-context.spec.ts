/**
 * End-to-end fail-closed tenant-context tests for the generated CLI/MCP surfaces
 * (#1554).
 *
 * The generated SvelteKit routes establish tenant context from the request
 * principal (#1540), but the in-process CLI/MCP generators have none. Without a
 * gate, an `@TenantScoped({ mode: 'optional' })` model queried via CLI/MCP with
 * no active context returns rows across ALL tenants (the interceptor only
 * hard-fails `required` mode). These tests verify the gate, which lives in core
 * but is filled by tenancy's `enableTenancy()`, so they run here (core cannot
 * depend on tenancy).
 *
 * Uses a real in-memory SQLite database — no DB mocking.
 */

import {
  field,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { CLIGenerator } from '@happyvertical/smrt-core/generators/cli';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { withTenant } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

@smrt()
@TenantScoped({ mode: 'optional' })
class TenantDoc extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  @tenantId({ nullable: true })
  tenantId: string | null = null;

  constructor(options: any = {}) {
    super(options);
    if (options.name !== undefined) this.name = options.name;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}

class TenantDocCollection extends SmrtCollection<TenantDoc> {
  static readonly _itemClass = TenantDoc;
}

/** Capture console.log output produced while running `fn`. */
async function captureLog(fn: () => Promise<void>): Promise<string> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs.join('\n');
}

describe('Generated CLI/MCP fail-closed tenant context (#1554)', () => {
  let db: any;

  beforeAll(async () => {
    ObjectRegistry.registerCollection('TenantDoc', TenantDocCollection);
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['TenantDoc'],
    });

    enableTenancy();

    // Seed two tenants. The interceptor stamps tenantId from the active context.
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const c = await TenantDocCollection.create({ db });
      const a1 = await c.create({ name: 'A-One' });
      await a1.save();
      const a2 = await c.create({ name: 'A-Two' });
      await a2.save();
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      const c = await TenantDocCollection.create({ db });
      const b1 = await c.create({ name: 'B-One' });
      await b1.save();
    });
  });

  afterAll(async () => {
    disableTenancy();
    await db?.close?.();
  });

  describe('CLI', () => {
    it('fails closed: list with no --tenant throws rather than ranging across tenants', async () => {
      const gen = new CLIGenerator({}, { db });
      await expect(gen.run(['tenantdoc:list'])).rejects.toThrow(
        /tenant context required/i,
      );
    });

    it('--tenant scopes the list to that tenant only', async () => {
      const gen = new CLIGenerator({}, { db });
      const out = await captureLog(() =>
        gen.run(['tenantdoc:list', '--tenant', 'tenant-a']),
      );
      expect(out).toContain('A-One');
      expect(out).toContain('A-Two');
      expect(out).not.toContain('B-One');
    });

    it('--all-tenants opts into cross-tenant access', async () => {
      const gen = new CLIGenerator({}, { db });
      const out = await captureLog(() =>
        gen.run(['tenantdoc:list', '--all-tenants']),
      );
      expect(out).toContain('A-One');
      expect(out).toContain('B-One');
    });
  });

  describe('MCP', () => {
    async function listViaMcp(context: Record<string, unknown>) {
      const gen = new MCPGenerator({}, { db, user: { id: 'op' }, ...context });
      return gen.handleToolCall({
        method: 'tools/call',
        params: { name: 'tenantdoc_list', arguments: {} },
      });
    }

    it('fails closed: list with no tenant context returns an error', async () => {
      const res = await listViaMcp({});
      const text = res.content.map((c) => c.text).join('\n');
      expect(text).toMatch(/tenant context required/i);
      expect(text).not.toContain('A-One');
      expect(text).not.toContain('B-One');
    });

    it('context.tenantId scopes the list to that tenant only', async () => {
      const res = await listViaMcp({ tenantId: 'tenant-a' });
      const text = res.content.map((c) => c.text).join('\n');
      expect(text).toContain('A-One');
      expect(text).toContain('A-Two');
      expect(text).not.toContain('B-One');
    });

    it('context.allowCrossTenant opts into cross-tenant access', async () => {
      const res = await listViaMcp({ allowCrossTenant: true });
      const text = res.content.map((c) => c.text).join('\n');
      expect(text).toContain('A-One');
      expect(text).toContain('B-One');
    });
  });

  // The emitted stdio MCP servers are separate processes that don't run the
  // host's bootstrap, so they must self-enable tenancy AND wrap tenant-scoped
  // tools in the gate — otherwise the gate is a no-op and the interceptor never
  // filters (codex P1 on #1557).
  describe('emitted MCP server hardening', () => {
    async function generateInto(modular: boolean): Promise<string> {
      const { mkdtemp } = await import('node:fs/promises');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const dir = await mkdtemp(join(tmpdir(), 'mcp-emit-'));
      const gen = new MCPGenerator(
        { name: 'emit-test', version: '1.0.0' },
        { db },
      );
      await gen.generateServer({ outputPath: join(dir, 'index.js'), modular });
      return dir;
    }

    it('single-file server enables tenancy and gates tenant-scoped tools', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const dir = await generateInto(false);
      const code = await readFile(join(dir, 'index.js'), 'utf-8');
      expect(code).toContain('enableTenancy()');
      expect(code).toContain('runTenantScopedEntryPoint');
      expect(code).toContain('tenantdoc');
    });

    it('modular server enables tenancy and gates tenant-scoped tools', async () => {
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const dir = await generateInto(true);
      const handlers = await readFile(
        join(dir, 'handlers', 'index.ts'),
        'utf-8',
      );
      expect(handlers).toContain('enableTenancy()');
      expect(handlers).toContain('runTenantScopedEntryPoint');
      expect(handlers).toContain('tenantdoc');
    });
  });
});
