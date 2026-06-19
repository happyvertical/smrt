/**
 * Regression tests for the consolidated generator-surface hardening (C3).
 *
 * These cover gaps left after #1540/#1541 wired fail-closed auth +
 * `api.writable` + sensitive serialization into REST/MCP/SvelteKit but NOT into
 * every generation path:
 *
 *  1. MCP honors `mcp: false` — generate NO tools for that class.
 *  2. OpenAPI honors `api: false` — no paths AND no component schemas.
 *  3. Exhaustive `include` on MCP — when an include list is present it is the
 *     COMPLETE allowlist; a custom (non-CRUD) method is exposed ONLY if named.
 *     When no include list is set, custom methods are auto-exposed (default).
 *
 * (CLI applyWritablePolicy + exhaustive `cli.include` are covered in the cli
 * package's own regression suite.)
 */

import { describe, expect, it } from 'vitest';

import { SmrtObject } from '../object';
import { ObjectRegistry } from '../registry';
import { MCPGenerator } from './mcp';
import { generateOpenAPISpec } from './swagger';

function smrt(config?: any) {
  return (target: any) => {
    ObjectRegistry.register(target, config);
    return target;
  };
}

// `mcp: false` — must produce no MCP tools at all, even though it has a public
// custom method that would otherwise auto-expose.
@smrt({ mcp: false })
class C3McpDisabled extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  async dangerousAction(): Promise<any> {
    return { ok: true };
  }
}

// `api: false` — must produce neither OpenAPI paths nor component schemas.
@smrt({ api: false })
class C3ApiDisabled extends SmrtObject {
  name = '';
  secretField = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }
}

// Exhaustive include that names ONLY CRUD verbs — custom methods must NOT leak.
@smrt({ mcp: { include: ['list', 'get'] } })
class C3McpCrudOnly extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  async recordPayment(): Promise<any> {
    return { ok: true };
  }

  async recognizeRevenue(): Promise<any> {
    return { ok: true };
  }
}

// Include that names a custom method — that method (and only it) is exposed.
@smrt({ mcp: { include: ['list', 'get', 'recordPayment'] } })
class C3McpNamedCustom extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  async recordPayment(): Promise<any> {
    return { ok: true };
  }

  async recognizeRevenue(): Promise<any> {
    return { ok: true };
  }
}

// No include list at all — keep the historical default: auto-expose public
// custom methods.
@smrt({ mcp: true })
class C3McpDefault extends SmrtObject {
  name = '';

  constructor(options: any) {
    super(options);
    const { db, ai, fs, ...safe } = options;
    Object.assign(this, safe);
  }

  async syncNow(): Promise<any> {
    return { ok: true };
  }
}

describe('C3 generator-surface hardening', () => {
  describe('MCP honors mcp: false', () => {
    it('generates no tools for a class configured with mcp: false', async () => {
      const generator = new MCPGenerator({}, { user: { id: 'test-user' } });
      const tools = await generator.generateTools();
      const leaked = tools.filter((t) => t.name.startsWith('c3mcpdisabled_'));
      expect(leaked).toEqual([]);
    });
  });

  describe('MCP exhaustive include for custom methods', () => {
    it('include: [list, get] emits NO custom-method tools', async () => {
      const generator = new MCPGenerator({}, { user: { id: 'test-user' } });
      const tools = await generator.generateTools();
      const names = tools
        .filter((t) => t.name.startsWith('c3mcpcrudonly_'))
        .map((t) => t.name);

      expect(names).toContain('c3mcpcrudonly_list');
      expect(names).toContain('c3mcpcrudonly_get');
      expect(names).not.toContain('c3mcpcrudonly_recordpayment');
      expect(names).not.toContain('c3mcpcrudonly_recognizerevenue');
      // No create/update/delete either (not in include list).
      expect(names).not.toContain('c3mcpcrudonly_create');
    });

    it('include naming a custom method emits ONLY that custom method', async () => {
      const generator = new MCPGenerator({}, { user: { id: 'test-user' } });
      const tools = await generator.generateTools();
      const names = tools
        .filter((t) => t.name.startsWith('c3mcpnamedcustom_'))
        .map((t) => t.name);

      expect(names).toContain('c3mcpnamedcustom_recordpayment');
      // The other public custom method is NOT named, so it must not leak.
      expect(names).not.toContain('c3mcpnamedcustom_recognizerevenue');
    });

    it('no include list auto-exposes public custom methods (default)', async () => {
      const generator = new MCPGenerator({}, { user: { id: 'test-user' } });
      const tools = await generator.generateTools();
      const names = tools
        .filter((t) => t.name.startsWith('c3mcpdefault_'))
        .map((t) => t.name);

      expect(names).toContain('c3mcpdefault_syncnow');
    });
  });

  describe('OpenAPI honors api: false', () => {
    it('emits neither paths nor component schemas for an api: false class', () => {
      const spec = generateOpenAPISpec();

      const pathKeys = Object.keys(spec.paths || {});
      const apiDisabledPaths = pathKeys.filter((p) =>
        p.toLowerCase().includes('c3apidisabled'),
      );
      expect(apiDisabledPaths).toEqual([]);

      const schemaKeys = Object.keys(spec.components?.schemas || {});
      const apiDisabledSchemas = schemaKeys.filter((s) =>
        s.toLowerCase().includes('c3apidisabled'),
      );
      expect(apiDisabledSchemas).toEqual([]);
    });
  });
});
