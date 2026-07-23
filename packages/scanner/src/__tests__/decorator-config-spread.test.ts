/**
 * Regression tests for spread resolution in `@smrt()` decorator config.
 *
 * Root cause (issue #2100): the parser skipped `SpreadElement` when extracting
 * the decorator config, so a class that declared its surface policy through a
 * shared constant — `@smrt({ ...INTERNAL_SURFACE })` — had `api`/`cli`/`mcp`
 * silently erased from the manifest. Because an ABSENT surface key means
 * default-open full CRUD (only an explicit `false` closes it), that turned a
 * deliberate lockdown into a published surface for every manifest-driven
 * consumer (MCP discovery, codegen, cross-package registration).
 *
 * Two guarantees are covered here:
 *  1. Module-scope `const` object literals in the same file ARE resolved.
 *  2. Anything NOT statically resolvable is reported as a `severity: 'error'`
 *     scan diagnostic rather than silently dropped — fail loud, never quiet.
 *
 * @see https://github.com/happyvertical/smrt/issues/2100
 */

import { describe, expect, it } from 'vitest';
import { parseSource } from '../oxc-parser.js';

const PREAMBLE = `import { SmrtObject, smrt } from '@happyvertical/smrt-core';`;

function configOf(source: string) {
  const result = parseSource(`${PREAMBLE}\n${source}`);
  return {
    config: result.classes[0]?.decoratorConfig,
    errors: result.errors.filter((e) => e.severity === 'error'),
  };
}

describe('@smrt() config spread resolution (#2100)', () => {
  it('resolves a module-scope const spread into the config', () => {
    const { config, errors } = configOf(`
      const INTERNAL_SURFACE = { api: false, cli: false, mcp: false };

      @smrt({ tableName: 'widgets', ...INTERNAL_SURFACE })
      class Widget extends SmrtObject {}
    `);

    expect(errors).toHaveLength(0);
    expect(config).toMatchObject({
      tableName: 'widgets',
      api: false,
      cli: false,
      mcp: false,
    });
  });

  it('resolves a spread through an `as const` assertion', () => {
    // packages/projects/src/models/delivery-control-plane.ts uses this exact
    // shape — the `as const` wrapper must be transparent.
    const { config, errors } = configOf(`
      const INTERNAL_SURFACES = { api: false, cli: false, mcp: false } as const;

      @smrt({ tableName: 'assistance_requests', ...INTERNAL_SURFACES })
      class AssistanceRequest extends SmrtObject {}
    `);

    expect(errors).toHaveLength(0);
    expect(config).toMatchObject({ api: false, cli: false, mcp: false });
  });

  it('resolves a spread of an exported const', () => {
    const { config, errors } = configOf(`
      export const SHARED = { api: false, mcp: false };

      @smrt({ ...SHARED })
      class Widget extends SmrtObject {}
    `);

    expect(errors).toHaveLength(0);
    expect(config).toMatchObject({ api: false, mcp: false });
  });

  it('preserves nested object values from the spread constant', () => {
    // packages/reports spreads a `cli` include-list; the nested object must
    // survive intact, not collapse to a bare `true`.
    const { config, errors } = configOf(`
      const INTERNAL_SURFACE = {
        api: false,
        cli: { include: ['list', 'get'], skipApiCheck: true, http: false },
        mcp: false,
      };

      @smrt({ tableName: '_smrt_report_runs', ...INTERNAL_SURFACE })
      class SmrtReportRun extends SmrtObject {}
    `);

    expect(errors).toHaveLength(0);
    expect(config).toMatchObject({
      tableName: '_smrt_report_runs',
      api: false,
      mcp: false,
      cli: { include: ['list', 'get'], skipApiCheck: true, http: false },
    });
  });

  describe('precedence follows source order, matching runtime semantics', () => {
    it('lets a spread override an earlier explicit key', () => {
      const { config } = configOf(`
        const CFG = { api: false };

        @smrt({ api: true, ...CFG })
        class Widget extends SmrtObject {}
      `);

      expect(config?.api).toBe(false);
    });

    it('lets an explicit key override an earlier spread', () => {
      const { config } = configOf(`
        const CFG = { api: false };

        @smrt({ ...CFG, api: true })
        class Widget extends SmrtObject {}
      `);

      expect(config?.api).toBe(true);
    });
  });

  it('resolves a constant that itself spreads an earlier constant', () => {
    const { config, errors } = configOf(`
      const BASE = { api: false, mcp: false };
      const EXTENDED = { ...BASE, cli: false };

      @smrt({ ...EXTENDED })
      class Widget extends SmrtObject {}
    `);

    expect(errors).toHaveLength(0);
    expect(config).toMatchObject({ api: false, mcp: false, cli: false });
  });

  it('resolves an inline object spread', () => {
    const { config, errors } = configOf(`
      @smrt({ ...{ api: false }, mcp: false })
      class Widget extends SmrtObject {}
    `);

    expect(errors).toHaveLength(0);
    expect(config).toMatchObject({ api: false, mcp: false });
  });

  describe('unresolvable spreads fail loud', () => {
    it('reports an imported constant as a scan error', () => {
      // Cross-file resolution is out of scope; the point is that it must not
      // silently vanish, because the dropped keys default to OPEN.
      const { errors } = configOf(`
        import { IMPORTED_SURFACE } from './shared.js';

        @smrt({ ...IMPORTED_SURFACE })
        class Widget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('IMPORTED_SURFACE');
      expect(errors[0].line).toBeGreaterThan(0);
    });

    it('does not treat `let` as a static constant', () => {
      // A `let` binding could be reassigned between declaration and decorator
      // evaluation, so resolving it would be unsound.
      const { errors } = configOf(`
        let MUTABLE = { api: false };

        @smrt({ ...MUTABLE })
        class Widget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('MUTABLE');
    });

    it('reports a spread inside an include array', () => {
      // Dropping an element silently shrinks an allowlist.
      const { errors } = configOf(`
        const BASE_ACTIONS = ['list', 'get'];

        @smrt({ cli: { include: [...BASE_ACTIONS, 'archive'] } })
        class Widget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('BASE_ACTIONS');
    });

    it('reports a call-expression spread', () => {
      const { errors } = configOf(`
        @smrt({ ...buildSurface() })
        class Widget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(1);
    });
  });

  it('does not let a spread carry prototype-pollution keys', () => {
    const { config } = configOf(`
      const EVIL = { __proto__: { polluted: true }, api: false };

      @smrt({ ...EVIL })
      class Widget extends SmrtObject {}
    `);

    expect(config).toMatchObject({ api: false });
    expect(Object.hasOwn(config, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('leaves a spread-free config unchanged', () => {
    const { config, errors } = configOf(`
      @smrt({ api: { include: ['list'] }, mcp: false })
      class Widget extends SmrtObject {}
    `);

    expect(errors).toHaveLength(0);
    expect(config).toMatchObject({
      api: { include: ['list'] },
      mcp: false,
    });
  });
});
