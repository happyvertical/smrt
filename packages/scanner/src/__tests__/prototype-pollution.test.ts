/**
 * Regression tests for prototype-pollution hardening (S5 #1384).
 *
 * The scanner builds plain metadata objects keyed by names taken from
 * developer-authored source (class fields, `@smrt()` / `@field()` config
 * properties, type aliases). A name of `__proto__`, `constructor`, or
 * `prototype` must never mutate the object's prototype or land as a gadget in
 * the emitted manifest. Scanner input is trusted build-time source, so this is
 * defense-in-depth rather than a remotely reachable fix — but a corrupted
 * metadata object would silently break downstream schema generation.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import {
  extractTypeAliases,
  isSafeObjectKey,
  parseSource,
} from '../oxc-parser.js';
import type { RawFieldDefinition, ResolvedClassDefinition } from '../types.js';

/** Own-property check that satisfies biome's noPrototypeBuiltins rule. */
function hasOwn(obj: unknown, key: string): boolean {
  return obj != null && Object.hasOwn(obj as object, key);
}

/** Probe whether anything polluted the global Object prototype. */
function globalProp(key: string): unknown {
  return (Object.prototype as Record<string, unknown>)[key];
}

describe('prototype-pollution hardening', () => {
  afterEach(() => {
    // Ensure no test polluted the global Object prototype.
    expect(globalProp('polluted')).toBeUndefined();
    expect(globalProp('isAdmin')).toBeUndefined();
  });

  describe('isSafeObjectKey', () => {
    it('rejects prototype-pollution keys', () => {
      expect(isSafeObjectKey('__proto__')).toBe(false);
      expect(isSafeObjectKey('constructor')).toBe(false);
      expect(isSafeObjectKey('prototype')).toBe(false);
    });

    it('allows ordinary keys', () => {
      expect(isSafeObjectKey('name')).toBe(true);
      expect(isSafeObjectKey('tableStrategy')).toBe(true);
    });
  });

  describe('@smrt() decorator config (extractObjectLiteral)', () => {
    it('does not pollute prototype via a __proto__ config property', () => {
      const source = `
        @smrt({ "__proto__": { "polluted": true }, tableStrategy: 'sti' })
        class Evil extends SmrtObject {
          name: string = '';
        }
      `;

      const config = parseSource(source).classes[0]?.decoratorConfig;

      // Prototype must be untouched and the forbidden key dropped.
      expect(Object.getPrototypeOf(config)).toBe(Object.prototype);
      expect(hasOwn(config, '__proto__')).toBe(false);
      // Legitimate sibling property is still captured.
      expect(config?.tableStrategy).toBe('sti');
      expect(globalProp('polluted')).toBeUndefined();
    });

    it('drops a constructor config property', () => {
      const source = `
        @smrt({ "constructor": { "evil": 1 } })
        class Evil extends SmrtObject {}
      `;
      const config = parseSource(source).classes[0]?.decoratorConfig;
      expect(hasOwn(config, 'constructor')).toBe(false);
    });
  });

  describe('class field names (extractPropertyDefinition)', () => {
    it('excludes a class field literally named __proto__ (review #1559)', () => {
      const source = `
        @smrt()
        class Doc extends SmrtObject {
          '__proto__': string = '';
          title: string = '';
        }
      `;
      const cls = parseSource(source).classes[0];
      const names = (cls?.fields ?? []).map((f) => f.name);
      expect(names).toContain('title');
      expect(names).not.toContain('__proto__');
    });
  });

  describe('type aliases (extractTypeAliases)', () => {
    it('does not record a type alias named __proto__', () => {
      const result = parseSource(`type __proto__ = 'a' | 'b';`);
      expect(hasOwn(result.typeAliases, '__proto__')).toBe(false);
      expect(Object.getPrototypeOf(result.typeAliases)).toBe(Object.prototype);
    });

    it('skips forbidden alias names but keeps legitimate ones', () => {
      const src = `
        type Status = 'on' | 'off';
        type constructor = 'x' | 'y';
      `;
      const aliases = parseSource(src).typeAliases;
      expect(aliases.Status).toBe("'on' | 'off'");
      expect(hasOwn(aliases, 'constructor')).toBe(false);
      // extractTypeAliases is exported and exercised by the parse path above.
      expect(typeof extractTypeAliases).toBe('function');
    });
  });

  describe('manifest adapter parseLiteralInitializer (sanitizeParsed)', () => {
    const adapter = new ManifestAdapter();

    function fieldWithDecorator(args: string[]): RawFieldDefinition {
      return {
        name: 'value',
        accessibility: 'public',
        typeAnnotation: 'string',
        initializer: "''",
        optional: false,
        hasDecimalPoint: false,
        numericValue: null,
        decorators: [{ name: 'field', arguments: args }],
        isStatic: false,
        readonly: false,
        line: 1,
      };
    }

    it('strips __proto__ from a @field() options object', () => {
      const field = fieldWithDecorator([
        '{ "__proto__": { "isAdmin": true }, required: true }',
      ]);
      const result = adapter.convertField(field);
      expect(result?.required).toBe(true);
      // The polluting key must not appear in _meta or globally.
      expect(hasOwn(result?._meta, '__proto__')).toBe(false);
      expect(globalProp('isAdmin')).toBeUndefined();
    });

    it('strips constructor/prototype from a static uiSlots initializer', () => {
      const staticField: RawFieldDefinition = {
        name: 'uiSlots',
        accessibility: 'public',
        typeAnnotation: null,
        initializer: '{ "constructor": { "x": 1 }, header: { label: "Hi" } }',
        optional: false,
        hasDecimalPoint: false,
        numericValue: null,
        decorators: [],
        isStatic: true,
        readonly: false,
        line: 1,
      };

      const classDef: ResolvedClassDefinition = {
        className: 'Widget',
        filePath: 'Widget.ts',
        extendsClause: 'SmrtObject',
        extendsTypeArg: null,
        decoratorConfig: {},
        hasSmartDecorator: true,
        fields: [staticField],
        methods: [],
        startLine: 1,
        endLine: 1,
        inheritanceChain: ['SmrtObject', 'Widget'],
        stiBase: null,
        effectiveTableStrategy: 'cti',
        isSTI: false,
        isFrameworkBase: false,
        allFields: [staticField],
        packageName: null,
      };

      const def = adapter.toSmartObjectDefinition(classDef);
      const uiSlots = def.staticProperties?.uiSlots as Record<string, unknown>;
      expect(uiSlots).toBeDefined();
      // Legitimate slot preserved, polluting key dropped.
      expect(uiSlots.header).toEqual({ label: 'Hi' });
      expect(hasOwn(uiSlots, 'constructor')).toBe(false);
    });

    it('preserves built-in objects (Date) instead of emptying them (review #1559)', () => {
      // sanitizeParsed must not iterate a built-in's keys — that would turn a
      // `new Date()` default into `{}`. Built-ins carry no attacker-controlled
      // own keys, so they pass through intact.
      const field = fieldWithDecorator([
        '{ sampleDate: new Date(0), required: true }',
      ]);
      const result = adapter.convertField(field);
      expect(result?.required).toBe(true);
      const meta = result?._meta as Record<string, unknown> | undefined;
      expect(meta?.sampleDate).toBeInstanceOf(Date);
      expect((meta?.sampleDate as Date)?.getTime()).toBe(0);
    });
  });
});
