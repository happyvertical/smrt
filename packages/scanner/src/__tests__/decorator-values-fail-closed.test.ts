/**
 * No decorator value reaches the manifest altered, defaulted or dropped
 * without a scan error.
 *
 * Each case pairs a source the scanner must refuse (or read exactly) with a
 * negative control that keeps legitimate use working.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InheritanceResolver } from '../inheritance-resolver.js';
import { ManifestAdapter } from '../manifest-adapter.js';
import { parseSource } from '../oxc-parser.js';
import { OxcScanner } from '../scanner.js';
import type { RawFieldDefinition } from '../types.js';

const FILE = 'src/models/closure-ledger.ts';
const PREAMBLE = `import { SmrtObject, smrt, field, foreignKey, report } from '@happyvertical/smrt-core';\nimport * as core from '@happyvertical/smrt-core';`;

function scan(body: string, header = '', decorator = '@smrt()') {
  const result = parseSource(
    `${PREAMBLE}\n${header}\n${decorator}\nexport class ClosureLedger extends SmrtObject {\n${body}\n}`,
    FILE,
  );
  const errors = result.errors.filter((e) => e.severity === 'error');
  const resolver = new InheritanceResolver();
  resolver.addClasses(result.classes);
  const model = resolver
    .resolveAll()
    .find((entry) => entry.className === 'ClosureLedger');
  if (!model) throw new Error('ClosureLedger was not resolved');
  const definition = new ManifestAdapter().toSmartObjectDefinition(model, {
    packageName: '@fixture/closure',
  });
  return { errors, fields: definition.fields, definition, raw: result };
}

describe('a scalar copied from an object constant', () => {
  it('fails when the object is written anywhere in the module', () => {
    const { errors, fields } = scan(
      `@field({ sensitive: SECRET_FLAG }) apiToken = '';`,
      `const POLICY = { sensitive: false };\nPOLICY.sensitive = true;\nconst SECRET_FLAG = POLICY.sensitive;`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('ClosureLedger.apiToken');
    expect(fields.apiToken.sensitive).not.toBe(false);
  });

  it('reads the member of an object nothing writes', () => {
    const { errors, fields } = scan(
      `@field({ sensitive: SECRET_FLAG }) apiToken = '';`,
      `const POLICY = { sensitive: true };\nconst SECRET_FLAG = POLICY.sensitive;`,
    );

    expect(errors).toHaveLength(0);
    expect(fields.apiToken.sensitive).toBe(true);
  });
});

describe('a constant held by a static property', () => {
  it('fails when another reader shares the constant', () => {
    const { errors } = scan(
      `static uiSlots = SLOTS;\n@field({ default: SLOTS }) layout = {};`,
      `const SLOTS = { sources: { id: 'sources', label: 'Sources' } };`,
    );

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.message).join('\n')).toContain('SLOTS');
  });

  it('reads a constant only the static property holds', () => {
    const { errors, definition } = scan(
      `static uiSlots = SLOTS;`,
      `const SLOTS = { sources: { id: 'sources', label: 'Sources' } };`,
    );

    expect(errors).toHaveLength(0);
    expect(definition.staticProperties?.uiSlots).toEqual({
      sources: { id: 'sources', label: 'Sources' },
    });
  });
});

describe('a field decorator reached through a namespace import', () => {
  it("reads core['field'] like core.field", () => {
    const { errors, fields } = scan(
      `@(core['field'])({ sensitive: true }) apiToken = '';\n@core.field({ sensitive: true }) pin = '';`,
    );

    expect(errors).toHaveLength(0);
    expect(fields.apiToken.sensitive).toBe(true);
    expect(fields.pin.sensitive).toBe(true);
  });

  it('fails on a computed member it cannot name', () => {
    const { errors } = scan(
      `@(core[DECORATOR])({ sensitive: true }) apiToken = '';`,
      `let DECORATOR = 'field';`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('core[DECORATOR]');
    expect(errors[0].message).toContain('ClosureLedger.apiToken');
  });
});

describe('relationship and report targets', () => {
  it('records an aliased class import by its exported name', () => {
    const { errors, fields } = scan(
      `@foreignKey(Owner) ownerId = '';\n@foreignKey(() => Owner) lazyOwnerId = '';`,
      `import { Account as Owner } from '@fixture/accounts';`,
    );

    expect(errors).toHaveLength(0);
    expect(fields.ownerId.related).toBe('Account');
    expect(fields.lazyOwnerId.related).toBe('Account');
  });

  // An imported binding is resolved through the module graph by the scan
  // (module-resolution.test.ts); a binding no import or declaration gives
  // fails in the file itself.
  it.each([
    [
      'a local alias',
      `import { Account } from '@fixture/accounts';\nconst Owner = Account as unknown;`,
      'Owner',
    ],
  ])('fails on a target given as %s', (_label, header, target) => {
    const { errors } = scan(`@foreignKey(${target}) ownerId = '';`, header);

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(target);
    expect(errors[0].message).toContain('ClosureLedger.ownerId');
  });

  it('records a report source by the class the runtime reads', () => {
    const { errors, raw } = scan(
      `customerId = '';`,
      `import { Invoice as Billed } from '@fixture/billing';`,
      `@report({ source: Billed })`,
    );

    expect(errors).toHaveLength(0);
    expect(raw.classes[0].decoratorConfig?.report?.source).toBe('Invoice');
  });
});

describe('numeric values', () => {
  it('reads numeric object keys by their string form', () => {
    const { errors, fields } = scan(
      `@field({ default: { 0: 'draft', 1.5: 'review' } }) states = {};`,
    );

    expect(errors).toHaveLength(0);
    expect(fields.states.default).toEqual({ 0: 'draft', '1.5': 'review' });
  });

  it.each([
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['a non-finite result', '1 / 0'],
    ['a constant holding one', 'LIMIT'],
  ])('fails on %s', (_label, value) => {
    const { errors, fields } = scan(
      `@field({ max: ${value} }) quantity = 0;`,
      `const LIMIT = 2 ** 2000;`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('ClosureLedger.quantity');
    expect(fields.quantity.max).toBeUndefined();
  });

  it('reads finite arithmetic', () => {
    const { errors, fields } = scan(
      `@field({ max: 2 ** 10 - 1 }) quantity = 0;`,
    );

    expect(errors).toHaveLength(0);
    expect(fields.quantity.max).toBe(1023);
  });
});

describe('hand-built field decorators', () => {
  const adapter = new ManifestAdapter();
  const handBuilt = (args: string[], name = 'field'): RawFieldDefinition => ({
    name: 'token',
    accessibility: 'public',
    typeAnnotation: 'string',
    initializer: "''",
    optional: false,
    hasDecimalPoint: false,
    numericValue: null,
    decorators: [{ name, arguments: args }],
    isStatic: false,
    readonly: false,
    line: 1,
  });

  it('throws when the whole options argument is an identifier', () => {
    expect(() => adapter.convertField(handBuilt(['SECRET_OPTIONS']))).toThrow(
      /SECRET_OPTIONS.*@field\(\)/s,
    );
  });

  it('still reads a column name where an aggregate takes one', () => {
    expect(() =>
      adapter.convertField(handBuilt(["'amount'"], 'sum')),
    ).not.toThrow();
  });
});

describe('a scanner run twice', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('gives the same result as the first run', async () => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-rescan-'));
    const file = join(dir, 'src/models/rescan-note.ts');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `import { SmrtObject, smrt } from '@happyvertical/smrt-core';\n@smrt()\nexport class RescanNote extends SmrtObject {\n  body = '';\n}\n`,
    );
    const scanner = new OxcScanner({ cwd: dir, include: ['src/**/*.ts'] });

    const first = await scanner.scanAndResolve();
    const second = await scanner.scanAndResolve();

    expect(first.results.errors).toHaveLength(0);
    expect(second.results.errors).toHaveLength(0);
    expect(second.resolved.map((c) => c.className)).toEqual(['RescanNote']);
    expect(() =>
      new ManifestAdapter().toManifest(second.resolved, {
        packageName: '@fixture/rescan',
      }),
    ).not.toThrow();
  });
});

describe('review round 3', () => {
  describe('computed namespace members on class and method decorators', () => {
    it('fails on a computed tenant decorator on a model class', () => {
      const { errors } = scan(
        `name = '';`,
        `let TENANT = 'TenantScoped';`,
        `@smrt()\n@(core[TENANT])({ field: 'orgId' })`,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('core[TENANT]');
      expect(errors[0].message).toContain('ClosureLedger');
    });

    it('fails on a computed decorator on a method', () => {
      const { errors } = scan(
        `@(core[EXPOSE])({ expose: false }) archive() { return true; }`,
        `let EXPOSE = 'method';`,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('core[EXPOSE]');
      expect(errors[0].message).toContain('archive');
    });

    it("reads core['smrt'] like core.smrt", () => {
      const { errors, raw } = scan(
        `name = '';`,
        '',
        `@(core['smrt'])({ api: false })`,
      );

      expect(errors).toHaveLength(0);
      expect(raw.classes[0].decoratorConfig).toMatchObject({ api: false });
    });
  });

  describe('a static property as a reader of everything it reaches', () => {
    it('fails when another reader shares an object the held constant nests', () => {
      const { errors } = scan(
        `@field(FLAGS) secret = '';`,
        `const FLAGS = { sensitive: false };\nconst SLOTS = { f: FLAGS };\nclass Panel { static uiSlots = SLOTS; }`,
      );

      expect(errors.length).toBeGreaterThan(0);
      expect(errors.map((e) => e.message).join('\n')).toContain('SLOTS');
    });

    it('fails through a spread of a wrapper with nested objects', () => {
      const { errors } = scan(
        `@field(POLICY) secret = '';`,
        `const POLICY = { sensitive: false };\nconst WRAPPER = { inner: POLICY };\nconst SLOTS = { ...WRAPPER };\nclass Panel { static uiSlots = SLOTS; }`,
      );

      expect(errors.length).toBeGreaterThan(0);
    });

    it('reads a nested constant only the static property reaches', () => {
      const { errors } = scan(
        `static uiSlots = SLOTS;`,
        `const FLAGS = { sensitive: false };\nconst SLOTS = { f: FLAGS };`,
      );

      expect(errors).toHaveLength(0);
    });
  });

  it('fails on a relationship target copied from a member written elsewhere', () => {
    const { errors, fields } = scan(
      `@foreignKey(OWNER) ownerId = '';`,
      `const TARGETS = { owner: 'Account' };\nTARGETS.owner = 'Vendor';\nconst OWNER = TARGETS.owner;`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('ClosureLedger.ownerId');
    expect(fields.ownerId.related).not.toBe('Account');
  });

  it('keeps an empty-string key', () => {
    const { errors, fields } = scan(
      `@field({ default: { '': 'draft', open: 'review' } }) states = {};`,
    );

    expect(errors).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(fields.states.default))).toEqual({
      '': 'draft',
      open: 'review',
    });
  });

  describe('hand-built text positions', () => {
    const adapter = new ManifestAdapter();
    const handBuilt = (name: string, args: string[]): RawFieldDefinition => ({
      name: 'total',
      accessibility: 'public',
      typeAnnotation: 'number',
      initializer: '0',
      optional: false,
      hasDecimalPoint: false,
      numericValue: 0,
      decorators: [{ name, arguments: args }],
      isStatic: false,
      readonly: false,
      line: 1,
    });

    it.each([
      ['crossPackageRef', ['QUALIFIED_NAME'], 'QUALIFIED_NAME'],
      ['groupBy', ['STATUS'], 'STATUS'],
      ['month', ['CREATED'], 'CREATED'],
      ['count', ['OPTIONS'], 'OPTIONS'],
      ['sum', ['AMOUNT'], 'AMOUNT'],
    ])('throws on @%s given an identifier', (name, args, expression) => {
      expect(() => adapter.convertField(handBuilt(name, args))).toThrow(
        new RegExp(`${expression}.*@${name}\\(\\)`, 's'),
      );
    });

    it('reads a string column and an options object', () => {
      const column = adapter.convertField(handBuilt('sum', ["'amount'"]));
      const counted = adapter.convertField(
        handBuilt('count', ['{ distinct: true }']),
      );

      expect(JSON.stringify(column)).toContain('amount');
      expect(JSON.stringify(counted)).toContain('"distinct":true');
    });
  });
});

describe('relationship targets imported through a relative path', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function scanProject(files: Record<string, string>) {
    dir = mkdtempSync(join(tmpdir(), 'smrt-targets-'));
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), source);
    }
    const scanner = new OxcScanner({ cwd: dir, include: ['src/**/*.ts'] });
    const { results, resolved } = await scanner.scanAndResolve();
    const errors = results.errors.filter((e) => e.severity === 'error');
    const holder = resolved.find((c) => c.className === 'TargetHolder');
    return { errors, holder };
  }

  const ACCOUNT = `import { SmrtObject, smrt } from '@happyvertical/smrt-core';\n@smrt()\nexport class Account extends SmrtObject {\n  name = '';\n}\n`;
  const holder = (imports: string) =>
    `import { SmrtObject, smrt, foreignKey } from '@happyvertical/smrt-core';\n${imports}\n@smrt()\nexport class TargetHolder extends SmrtObject {\n  @foreignKey(OwnerModel) ownerId = '';\n}\n`;

  it('records the class a barrel re-exports under another name', async () => {
    const { errors, holder: model } = await scanProject({
      'src/models/account.ts': ACCOUNT,
      'src/models/index.ts': `export { Account as OwnerModel } from './account';\n`,
      'src/models/holder.ts': holder(`import { OwnerModel } from './index';`),
    });

    expect(errors).toHaveLength(0);
    const value = model?.fields.find((f) => f.name === 'ownerId')?.decorators[0]
      .argumentValues?.[0]?.value;
    expect(value).toBe('Account');
  });

  it('fails when the imported binding is not a class', async () => {
    const { errors } = await scanProject({
      'src/models/account.ts': ACCOUNT,
      'src/models/targets.ts': `export const OwnerModel = 'Account';\n`,
      'src/models/holder.ts': holder(`import { OwnerModel } from './targets';`),
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('OwnerModel');
    expect(errors[0].message).toContain('TargetHolder.ownerId');
  });
});

describe('review round 4', () => {
  it('fails on a scalar copied from an object after a write through a static property', () => {
    const { errors, fields } = scan(
      `@field({ sensitive: SECRET }) apiToken = '';`,
      `const POLICY = { sensitive: false };\nclass Panel { static uiSlots = POLICY; }\n(Panel.uiSlots as { sensitive: boolean }).sensitive = true;\nconst SECRET = POLICY.sensitive;`,
    );

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.message).join('\n')).toContain(
      'ClosureLedger.apiToken',
    );
    expect(fields.apiToken.sensitive).not.toBe(false);
  });

  it.each([
    ["''", "''"],
    ["'   '", "'   '"],
    ['a constant holding an empty string', 'EMPTY'],
  ])('fails on an empty relationship target (%s)', (_label, value) => {
    const { errors } = scan(
      `@foreignKey(${value}) ownerId = '';`,
      `const EMPTY = '';`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('ClosureLedger.ownerId');
  });

  describe('hand-built object text where the decorator takes none', () => {
    const adapter = new ManifestAdapter();
    const handBuilt = (name: string, args: string[]): RawFieldDefinition => ({
      name: 'opened',
      accessibility: 'public',
      typeAnnotation: 'string',
      initializer: "''",
      optional: false,
      hasDecimalPoint: false,
      numericValue: null,
      decorators: [{ name, arguments: args }],
      isStatic: false,
      readonly: false,
      line: 1,
    });

    it.each([
      ['month', ["{ column: 'createdAt' }"]],
      ['crossPackageRef', ['{ validate: true }']],
    ])('throws on @%s given an options object', (name, args) => {
      expect(() => adapter.convertField(handBuilt(name, args))).toThrow(
        new RegExp(`@${name}\\(\\) takes a string here`),
      );
    });
  });
});
