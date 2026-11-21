/**
 * Class and method decorator arguments that are not an inline object literal.
 *
 * A decorator config reaches the manifest in exactly one of two states: read
 * in full, or rejected with a scan error that names the file, the class and
 * the option. A supplied argument never reads as `{}`, and a value never
 * reads as the name of the identifier that held it — either would publish a
 * manifest that disagrees with what the runtime decorator received.
 *
 * Resolution is static and same-file: literals, module-scope `const`
 * literals (objects, arrays, scalars), their members, same-file enum members,
 * and constant folding over those.
 */

import { describe, expect, it } from 'vitest';
import { parseSource } from '../oxc-parser.js';

const PREAMBLE = `import { SmrtObject, smrt, method } from '@happyvertical/smrt-core';
import { TenantScoped } from '@happyvertical/smrt-tenancy';
import { report, SmrtReport } from '@happyvertical/smrt-reports';`;
const FILE = 'src/models/widget.ts';

function scan(source: string) {
  const result = parseSource(`${PREAMBLE}\n${source}`, FILE);
  return {
    classes: result.classes,
    config: result.classes[0]?.decoratorConfig,
    errors: result.errors.filter((e) => e.severity === 'error'),
  };
}

describe('decorator config given as a reference', () => {
  describe('@smrt(CONFIG)', () => {
    it('reads a module constant passed as the whole argument', () => {
      const { config, errors } = scan(`
        const CLOSED = {
          tableName: 'reference_widgets',
          api: false,
          mcp: false,
          cli: { include: ['list'] },
        };

        @smrt(CLOSED)
        class ReferenceWidget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(0);
      expect(config).toEqual({
        tableName: 'reference_widgets',
        api: false,
        mcp: false,
        cli: { include: ['list'] },
      });
    });

    it('reads the same config whether the constant is passed or spread', () => {
      const constant = `const CLOSED = { api: false, mcp: false, cli: false } as const;`;
      const passed = scan(
        `${constant}\n@smrt(CLOSED)\nclass ReferenceWidget extends SmrtObject {}`,
      );
      const spread = scan(
        `${constant}\n@smrt({ ...CLOSED })\nclass ReferenceWidget extends SmrtObject {}`,
      );

      expect(passed.errors).toHaveLength(0);
      expect(passed.config).toEqual(spread.config);
    });

    it('keeps an argument-free decorator distinct from an unreadable one', () => {
      const { config, errors } = scan(`
        @smrt()
        class ReferenceWidget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(0);
      expect(config).toEqual({});
    });

    it.each([
      ['a call', '@smrt(buildConfig())', 'buildConfig()'],
      [
        'an imported constant',
        `import { SHARED } from './shared.js';\n@smrt(SHARED)`,
        'SHARED',
      ],
      [
        'a `let` binding',
        'let MUTABLE = { api: false };\n@smrt(MUTABLE)',
        'MUTABLE',
      ],
      [
        'a member of an unknown object',
        '@smrt(policies.closed)',
        'policies.closed',
      ],
      ['a non-object value', `@smrt('reference_widgets')`, 'reference_widgets'],
    ])('fails on %s and names the file and class', (_label, decorator, expression) => {
      const { errors } = scan(`
        function buildConfig() { return { api: false }; }
        ${decorator}
        class ReferenceWidget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(1);
      expect(errors[0].filePath).toBe(FILE);
      expect(errors[0].line).toBeGreaterThan(0);
      expect(errors[0].message).toContain(expression);
      expect(errors[0].message).toContain('@smrt()');
      expect(errors[0].message).toContain('ReferenceWidget');
    });

    it('fails when the passed constant is changed after its declaration', () => {
      // The decorator receives the constant itself, so its declaration is not
      // what the runtime sees, wherever the change is written.
      for (const mutation of [
        `CLOSED.api = true;\n@smrt(CLOSED)\nclass ReferenceWidget extends SmrtObject {}`,
        `@smrt(CLOSED)\nclass ReferenceWidget extends SmrtObject {}\nCLOSED.api = true;`,
        `consume(CLOSED);\n@smrt(CLOSED)\nclass ReferenceWidget extends SmrtObject {}`,
      ]) {
        const { errors } = scan(`const CLOSED = { api: false };\n${mutation}`);

        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('CLOSED');
        expect(errors[0].message).toContain('ReferenceWidget');
      }
    });

    it('fails when the passed constant was built from an unreadable value', () => {
      const { errors } = scan(`
        import { IMPORTED } from './shared.js';
        const CLOSED = { ...IMPORTED, mcp: false };

        @smrt(CLOSED)
        class ReferenceWidget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('IMPORTED');
    });

    it('gives each class its own copy of a shared constant', () => {
      const { classes, errors } = scan(`
        const SHARED = { cli: { include: ['list'] } };

        @smrt(SHARED)
        class ReferenceWidget extends SmrtObject {}

        @smrt({ ...SHARED })
        class ReferenceGadget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(0);
      const [widget, gadget] = classes.map((c) => c.decoratorConfig);
      expect(widget?.cli).toEqual(gadget?.cli);
      expect(widget?.cli).not.toBe(gadget?.cli);
    });
  });

  describe('referenced values inside a config', () => {
    it('reads scalar, array, object, member and enum references', () => {
      const { config, errors } = scan(`
        enum Strategy { Single = 'sti', Class = 'cti' }
        const TABLE = 'reference_widgets';
        const READ_ACTIONS = ['list', 'get'] as const;
        const MCP = { include: ['list'] };
        const LIMITS = { cli: { include: ['list', 'get'] } };
        const closed = false;

        @smrt({
          tableName: TABLE,
          tableStrategy: Strategy.Single,
          api: { include: READ_ACTIONS },
          mcp: MCP,
          cli: LIMITS.cli,
          ai: closed,
          closed,
        })
        class ReferenceWidget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(0);
      expect(config).toEqual({
        tableName: 'reference_widgets',
        tableStrategy: 'sti',
        api: { include: ['list', 'get'] },
        mcp: { include: ['list'] },
        cli: { include: ['list', 'get'] },
        ai: false,
        closed: false,
      });
    });

    it('reads a spread of a same-file array constant', () => {
      const { config, errors } = scan(`
        const BASE_ACTIONS = ['list', 'get'];

        @smrt({ cli: { include: [...BASE_ACTIONS, 'archive'] } })
        class ReferenceWidget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(0);
      expect(config?.cli).toEqual({ include: ['list', 'get', 'archive'] });
    });

    it('folds constant expressions over static values', () => {
      const { config, errors } = scan(`
        const PREFIX = 'reference';
        const HOUR = 60 * 60;

        @smrt({
          tableName: \`\${PREFIX}_widgets\`,
          collection: PREFIX + '-widgets',
          ttl: HOUR * 24,
          offset: -HOUR,
        })
        class ReferenceWidget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(0);
      expect(config).toEqual({
        tableName: 'reference_widgets',
        collection: 'reference-widgets',
        ttl: 86400,
        offset: -3600,
      });
    });

    it.each([
      [
        'an imported identifier',
        `api: IMPORTED_POLICY`,
        'IMPORTED_POLICY',
        'api',
      ],
      ['a call', `api: { include: actions() }`, 'actions()', 'api.include'],
      [
        'a member of an import',
        `mcp: policies.closed`,
        'policies.closed',
        'mcp',
      ],
      [
        'a conditional',
        `cli: FLAG ? true : false`,
        'FLAG ? true : false',
        'cli',
      ],
      ['a function', `api: () => false`, '() => false', 'api'],
      ['a missing member', `cli: LIMITS.missing`, 'LIMITS.missing', 'cli'],
    ])('fails on %s and names the option', (_label, property, expression, option) => {
      const { config, errors } = scan(`
        import { IMPORTED_POLICY, policies } from './policy.js';
        const LIMITS = { cli: false };

        @smrt({ tableName: 'reference_widgets', ${property} })
        class ReferenceWidget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(1);
      expect(errors[0].filePath).toBe(FILE);
      expect(errors[0].message).toContain(expression);
      expect(errors[0].message).toContain('ReferenceWidget');
      expect(errors[0].message).toContain(`option \`${option}\``);
      // The unreadable key is absent, never a string standing in for a value.
      expect(JSON.stringify(config)).not.toContain(expression);
      expect(config?.tableName).toBe('reference_widgets');
    });

    it('fails when a referenced object or array constant is changed', () => {
      for (const body of [
        `const POLICY = { include: ['list'] };\nPOLICY.include.push('delete');\n@smrt({ api: POLICY })`,
        `const POLICY = { include: ['list'] };\n@smrt({ api: POLICY })\nclass Other extends SmrtObject {}\nPOLICY.include.push('delete');\n@smrt({ mcp: false })`,
        `const ACTIONS = ['list'];\nACTIONS.push('delete');\n@smrt({ api: { include: ACTIONS } })`,
        `const POLICY = { include: ['list'] };\nconst alias = POLICY;\n@smrt({ api: POLICY })`,
        `const POLICY = { api: { include: ['list'] } };\nextend(POLICY.api);\n@smrt({ api: POLICY.api })`,
      ]) {
        const { errors } = scan(
          `${body}\nclass ReferenceWidget extends SmrtObject {}`,
        );

        expect(errors.length).toBeGreaterThanOrEqual(1);
        expect(errors[0].message).toMatch(/POLICY|ACTIONS/);
      }
    });

    it('follows a constant that holds another constant by reference', () => {
      const declared = `
        const API = { include: ['list'] };
        const POLICY = { api: API, mcp: false };
      `;
      const clean = scan(`${declared}
        @smrt({ ...POLICY })
        class ReferenceWidget extends SmrtObject {}
      `);
      expect(clean.errors).toHaveLength(0);
      expect(clean.config).toEqual({ api: { include: ['list'] }, mcp: false });

      for (const mutation of [
        `API.include.push('delete');`,
        `POLICY.api.include.pop();`,
      ]) {
        const changed = scan(`${declared}
          ${mutation}
          @smrt({ ...POLICY })
          class ReferenceWidget extends SmrtObject {}
        `);
        expect(changed.errors.length).toBeGreaterThanOrEqual(1);
      }
    });

    it('does not treat a scalar constant as changeable', () => {
      const { config, errors } = scan(`
        const TABLE = 'reference_widgets';
        log(TABLE);
        const alias = TABLE;

        @smrt({ tableName: TABLE })
        class ReferenceWidget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(0);
      expect(config?.tableName).toBe('reference_widgets');
    });
  });

  describe('@TenantScoped()', () => {
    it('reads the tenant field from a constant, not the identifier name', () => {
      const { config, errors } = scan(`
        const TENANT_FIELD = 'orgId';

        @TenantScoped({ field: TENANT_FIELD, mode: 'optional' })
        @smrt({ api: false })
        class ReferenceWidget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(0);
      expect(config?.tenantScoped).toEqual({
        field: 'orgId',
        mode: 'optional',
      });
    });

    it('reads options passed as a constant', () => {
      const { config, errors } = scan(`
        const SCOPE = { field: 'orgId' };

        @TenantScoped(SCOPE)
        @smrt({ api: false })
        class ReferenceWidget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(0);
      expect(config?.tenantScoped).toEqual({ field: 'orgId' });
    });

    it.each([
      [
        'an imported field name',
        '@TenantScoped({ field: TENANT_FIELD })',
        'TENANT_FIELD',
      ],
      ['imported options', '@TenantScoped(SCOPE)', 'SCOPE'],
      ['computed options', '@TenantScoped(scopeFor("org"))', 'scopeFor("org")'],
    ])('fails on %s', (_label, decorator, expression) => {
      const { config, errors } = scan(`
        import { TENANT_FIELD, SCOPE } from './tenancy.js';

        ${decorator}
        @smrt({ api: false })
        class ReferenceWidget extends SmrtObject {}
      `);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain(expression);
      expect(errors[0].message).toContain('@TenantScoped()');
      expect(errors[0].message).toContain('ReferenceWidget');
      expect(JSON.stringify(config?.tenantScoped)).not.toContain(
        'TENANT_FIELD',
      );
    });
  });

  describe('@report()', () => {
    it('records a source model by class name and reads the rest statically', () => {
      const { config, errors } = scan(`
        import { ReferenceOrder, ReferenceCustomer } from './orders.js';
        const TTL = 60 * 5;

        @report({
          source: ReferenceOrder,
          joins: { customer: { source: ReferenceCustomer, on: 'customerId' } },
          refresh: { ttl: TTL },
        })
        @smrt()
        class ReferenceWidget extends SmrtReport {}
      `);

      expect(errors).toHaveLength(0);
      expect(config?.report).toEqual({
        source: 'ReferenceOrder',
        joins: { customer: { source: 'ReferenceCustomer', on: 'customerId' } },
        refresh: { ttl: 300 },
      });
    });

    it('reads a source named through a string constant', () => {
      const { config, errors } = scan(`
        const SOURCE = 'ReferenceOrder';

        @report({ source: SOURCE })
        @smrt()
        class ReferenceWidget extends SmrtReport {}
      `);

      expect(errors).toHaveLength(0);
      expect(config?.report).toEqual({ source: 'ReferenceOrder' });
    });

    it('fails on an unreadable value outside the model references', () => {
      const { config, errors } = scan(`
        import { ReferenceOrder, ACTIVE } from './orders.js';

        @report({ source: ReferenceOrder, where: { status: ACTIVE } })
        @smrt()
        class ReferenceWidget extends SmrtReport {}
      `);

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('ACTIVE');
      expect(errors[0].message).toContain('@report()');
      expect(errors[0].message).toContain('option `where.status`');
      expect(config?.report).toEqual({ source: 'ReferenceOrder', where: {} });
    });
  });

  describe('@method()', () => {
    function methodConfig(body: string) {
      const { classes, errors } = scan(`
        const WITHHELD = { expose: false, reason: 'internal' };
        @smrt()
        class ReferenceWidget extends SmrtObject {
          ${body}
        }
      `);
      return { config: classes[0]?.methods[0]?.decoratorConfig, errors };
    }

    it('reads options passed as a constant', () => {
      const { config, errors } = methodConfig(`
        @method(WITHHELD)
        async review(): Promise<void> {}
      `);

      expect(errors).toHaveLength(0);
      expect(config).toEqual({ expose: false, reason: 'internal' });
    });

    it.each([
      ['a call', '@method(withheld())', 'withheld()'],
      ['an unknown identifier', '@method(OPTIONS)', 'OPTIONS'],
    ])('fails on %s and names the method', (_label, decorator, expression) => {
      const { errors } = methodConfig(`
        ${decorator}
        async review(): Promise<void> {}
      `);

      expect(errors).toHaveLength(1);
      expect(errors[0].filePath).toBe(FILE);
      expect(errors[0].message).toContain(expression);
      expect(errors[0].message).toContain('@method()');
      expect(errors[0].message).toContain('ReferenceWidget.review');
    });
  });

  describe('decorators reached through a namespace import', () => {
    it('does not read a member of an unrelated local object as a decorator', () => {
      const result = parseSource(
        `const helpers = { smrt: () => (target: unknown) => target };

         @helpers.smrt({ api: false })
         class ReferenceWidget {}`,
        FILE,
      );

      expect(result.classes[0].hasSmartDecorator).toBe(false);
    });
  });
});
