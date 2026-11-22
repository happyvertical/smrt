/**
 * Field decorator arguments are read from the AST, never evaluated.
 *
 * An options object reaches the manifest in full, or the scan fails with a
 * diagnostic naming the file, the class, the field and the option. A single
 * value the scanner cannot read never takes the rest of the object with it:
 * `sensitive`, `transient`, `unique`, `maxLength` and a relationship's
 * `onDelete` are schema and exposure facts that every manifest reader
 * depends on.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InheritanceResolver } from '../inheritance-resolver.js';
import { ManifestAdapter } from '../manifest-adapter.js';
import { parseSource, RUNTIME_ONLY_OPTION } from '../oxc-parser.js';
import { OxcScanner } from '../scanner.js';
import type { RawFieldDefinition } from '../types.js';

const FILE = 'src/models/option-account.ts';
const PREAMBLE = `import { SmrtObject, smrt, field, meta, foreignKey, crossPackageRef, oneToMany } from '@happyvertical/smrt-core';`;

function scanModel(body: string, header = '') {
  const result = parseSource(
    `${PREAMBLE}\n${header}\n@smrt()\nexport class OptionAccount extends SmrtObject {\n${body}\n}`,
    FILE,
  );
  const errors = result.errors.filter((e) => e.severity === 'error');
  const resolver = new InheritanceResolver();
  resolver.addClasses(result.classes);
  const model = resolver
    .resolveAll()
    .find((entry) => entry.className === 'OptionAccount');
  if (!model) throw new Error('OptionAccount was not resolved');
  const definition = new ManifestAdapter().toSmartObjectDefinition(model, {
    packageName: '@fixture/options',
  });
  return { errors, fields: definition.fields, definition, raw: result };
}

describe('field decorator options', () => {
  it('reads literal options', () => {
    const { errors, fields } = scanModel(`
      @field({ sensitive: true, maxLength: 64 }) apiSecret = '';
      @field({ transient: true }) scratch = '';
      @field({ unique: true, required: true, min: -5, max: 10 }) rank = 0;
    `);

    expect(errors).toHaveLength(0);
    expect(fields.apiSecret).toMatchObject({ sensitive: true, maxLength: 64 });
    expect(fields.scratch.transient).toBe(true);
    expect(fields.rank).toMatchObject({ required: true, min: -5, max: 10 });
    expect(fields.rank._meta?.unique).toBe(true);
  });

  it('fails on an element read from an array constant with a hole', () => {
    // At runtime FLAGS[1] is `true`; dropping the hole would read `false`.
    const { errors, fields } = scanModel(
      `@field({ sensitive: FLAGS[1] }) apiSecret = '';`,
      'const FLAGS = [, true, false] as const;',
    );

    expect(errors.length).toBeGreaterThan(0);
    expect(errors.map((e) => e.message).join('\n')).toContain('FLAGS');
    expect(fields.apiSecret?.sensitive).not.toBe(false);
  });

  it('fails on an element of a same-file array constant read by its index', () => {
    const { errors } = scanModel(
      `@field({ sensitive: FLAGS[1] }) apiSecret = '';`,
      'const FLAGS = [false, true, false] as const;',
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('FLAGS');
  });

  it('reads a string-literal computed key in a single-table child override like a plain key', () => {
    const result = parseSource(
      `${PREAMBLE}
@smrt({ tableStrategy: 'sti' })
export class OptionBase extends SmrtObject {
  secret = '';
}
@smrt()
export class OptionChild extends OptionBase {
  @field({ sensitive: true }) override ['secret'] = '';
}`,
      FILE,
    );
    const resolver = new InheritanceResolver();
    resolver.addClasses(result.classes);
    const child = resolver
      .resolveAll()
      .find((entry) => entry.className === 'OptionChild');
    if (!child) throw new Error('OptionChild was not resolved');
    const definition = new ManifestAdapter().toSmartObjectDefinition(child, {
      packageName: '@fixture/options',
    });

    expect(result.errors.filter((e) => e.severity === 'error')).toEqual([]);
    expect(definition.fields.secret?.sensitive).toBe(true);
  });

  it('fails on a decorated field whose computed key cannot be named', () => {
    const { errors } = scanModel(
      `@field({ sensitive: true }) [KEY] = '';`,
      `const KEY = 'secret' as string;\nlet other = KEY;`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('`[KEY]`');
    expect(errors[0].message).toContain('identifier or a string literal key');
  });

  it.each([
    ["['']", "''"],
    ["['__proto__']", "'__proto__'"],
  ])('fails on a decorated field named %s instead of dropping it', (key, expression) => {
    // An undecorated member of that name carries no options; it is skipped
    // as before.
    const { errors, fields } = scanModel(
      `@field({ sensitive: true }) ${key} = '';\nplain = '';\nstatic ${key} = '';`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain(expression);
    expect(errors[0].message).toContain('OptionAccount');
    expect(errors[0].message).toContain('non-empty name');
    expect(fields.plain).toBeDefined();
  });

  it('reads values declared as same-file constants', () => {
    const { errors, fields } = scanModel(
      `
      @field({ sensitive: true, maxLength: MAX_SECRET_LENGTH }) apiSecret = '';
      @field({ unique: true, required: true, maxLength: MAX_SECRET_LENGTH * 2 }) handle = '';
      @field({ default: Tier.Free, description: \`Tier, one of \${TIER_COUNT}\` }) tier = '';
      @field({ ...SECRET, maxLength: 12 }) token = '';
      @field({ ui: { ...WIDE, group: GROUP }, readPermission }) notes = '';
    `,
      `
      enum Tier { Free = 'free', Paid = 'paid' }
      const MAX_SECRET_LENGTH = 64;
      const TIER_COUNT = 2;
      const SECRET = { sensitive: true, readonly: true };
      const WIDE = { widget: 'textarea' };
      const GROUP = 'details';
      const readPermission = 'accounts.notes.read';
    `,
    );

    expect(errors).toHaveLength(0);
    expect(fields.apiSecret).toMatchObject({ sensitive: true, maxLength: 64 });
    expect(fields.handle).toMatchObject({ required: true, maxLength: 128 });
    expect(fields.handle._meta?.unique).toBe(true);
    expect(fields.tier).toMatchObject({
      default: 'free',
      description: 'Tier, one of 2',
    });
    expect(fields.token).toMatchObject({
      sensitive: true,
      readonly: true,
      maxLength: 12,
    });
    expect(fields.notes._meta?.ui).toEqual({
      widget: 'textarea',
      group: 'details',
    });
    expect(fields.notes.readPermission).toBe('accounts.notes.read');
  });

  it('fails on a member of an object constant or a constant passed as the whole options', () => {
    const { errors } = scanModel(
      `
      @field({ transient: true, maxLength: LIMITS.scratch }) scratch = '';
      @field(SECRET) recoveryCode = '';
    `,
      `
      const LIMITS = { scratch: 32 } as const;
      const SECRET = { sensitive: true, readonly: true };
    `,
    );

    const messages = errors.map((e) => e.message).join('\n');
    expect(messages).toContain('LIMITS');
    expect(messages).toContain('SECRET');
  });

  it.each([
    [
      'an identifier that is not a same-file constant',
      '@field({ sensitive: true, maxLength: MAX_SECRET_LENGTH }) apiSecret = "";',
      'MAX_SECRET_LENGTH',
      'maxLength',
    ],
    [
      'a call expression',
      '@field({ sensitive: true, description: describe("secret") }) apiSecret = "";',
      'describe("secret")',
      'description',
    ],
    [
      'a value imported from another module',
      '@field({ transient: true, maxLength: LIMITS.secret }) apiSecret = "";',
      'LIMITS.secret',
      'maxLength',
    ],
    [
      'an imported options object',
      '@field(SECRET_OPTIONS) apiSecret = "";',
      'SECRET_OPTIONS',
      undefined,
    ],
    [
      'a spread of an imported object',
      '@field({ ...SECRET_OPTIONS, maxLength: 5 }) apiSecret = "";',
      '...SECRET_OPTIONS',
      undefined,
    ],
    [
      'a nested unreadable value',
      '@field({ unique: true, ui: { group: currentGroup() } }) apiSecret = "";',
      'currentGroup()',
      'ui.group',
    ],
    [
      'a default computed when the class is defined',
      '@field({ default: new Date() }) apiSecret = "";',
      'new Date()',
      'default',
    ],
    [
      'a function where the option is a value',
      '@field({ default: () => "generated", maxLength: 8 }) apiSecret = "";',
      '() => "generated"',
      'default',
    ],
  ])('fails on %s and names the file, class, field and option', (_label, declaration, expression, option) => {
    const { errors, fields } = scanModel(
      declaration,
      `import { LIMITS, SECRET_OPTIONS } from './limits.js';`,
    );

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toBe(FILE);
    expect(errors[0].line).toBeGreaterThan(0);
    expect(errors[0].message).toContain(expression);
    expect(errors[0].message).toContain('@field()');
    expect(errors[0].message).toContain('OptionAccount.apiSecret');
    if (option) {
      expect(errors[0].message).toContain(`option \`${option}\``);
    }
    // Nothing stands in for the unread value.
    expect(JSON.stringify(fields.apiSecret)).not.toContain(expression);
  });

  it('keeps every readable option beside one it cannot read', () => {
    const { errors, fields } = scanModel(
      `@field({ sensitive: true, unique: true, maxLength: MAX_SECRET_LENGTH }) apiSecret = '';`,
      `import { MAX_SECRET_LENGTH } from './limits.js';`,
    );

    expect(errors).toHaveLength(1);
    expect(fields.apiSecret.sensitive).toBe(true);
    expect(fields.apiSecret._meta?.unique).toBe(true);
    expect(fields.apiSecret.maxLength).toBeUndefined();
  });

  it('does not run the option source while scanning', () => {
    const marker = '__optionAccountScanRan';
    const globals = globalThis as Record<string, unknown>;
    delete globals[marker];

    const { errors } = scanModel(
      `@field({ description: (globalThis.${marker} = 'ran') }) note = '';`,
    );

    expect(globals[marker]).toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('OptionAccount.note');
  });

  it('reads options written with TypeScript-only syntax', () => {
    const { errors, fields } = scanModel(`
      @field({ sensitive: true as boolean, maxLength: 32 satisfies number, description: <string>'Key' })
      apiSecret = '';
    `);

    expect(errors).toHaveLength(0);
    expect(fields.apiSecret).toMatchObject({
      sensitive: true,
      maxLength: 32,
      description: 'Key',
    });
  });

  describe('regular-expression and date values', () => {
    it('keeps a pattern literal as the same RegExp, without evaluating it', () => {
      const { errors, fields } = scanModel(`
        @field({ pattern: /^(draft|published)$/i, maxLength: 16 }) status = '';
      `);

      expect(errors).toHaveLength(0);
      const pattern = fields.status._meta?.pattern as RegExp;
      expect(pattern).toBeInstanceOf(RegExp);
      expect(pattern.source).toBe('^(draft|published)$');
      expect(pattern.flags).toBe('i');
      expect(fields.status.maxLength).toBe(16);
      // A manifest file carries the pattern as it always has.
      expect(JSON.parse(JSON.stringify(fields.status))._meta.pattern).toEqual(
        {},
      );
    });

    it('keeps a default built from literal date arguments', () => {
      const { errors, fields } = scanModel(`
        @field({ default: new Date(0), description: 'Opened' }) openedAt: Date = new Date(0);
      `);

      expect(errors).toHaveLength(0);
      expect(fields.openedAt.default).toBeInstanceOf(Date);
      expect((fields.openedAt.default as Date).getTime()).toBe(0);
      expect(fields.openedAt.description).toBe('Opened');
    });
  });

  describe('runtime callbacks', () => {
    it('records a validator as stated and keeps the options around it', () => {
      const { errors, fields, raw } = scanModel(
        `
        @field({ maxLength: 40, validate: (value: string) => value.length > MINIMUM, customMessage: 'Too short' })
        handle = '';
        @field({ validate: isHandle, unique: true }) alias = '';
        @field({ sensitive: true, validate(value: string) { return value !== ''; } }) pin = '';
      `,
        `import { isHandle } from './validators.js';\nconst MINIMUM = 3;`,
      );

      expect(errors).toHaveLength(0);
      expect(fields.handle).toMatchObject({ maxLength: 40 });
      expect(fields.handle._meta).toEqual({
        maxLength: 40,
        customMessage: 'Too short',
        __statedOptions: ['maxLength', 'validate', 'customMessage'],
      });
      expect(fields.alias._meta).toEqual({
        unique: true,
        __statedOptions: ['validate', 'unique'],
      });
      expect(fields.pin.sensitive).toBe(true);
      // The raw scan marks where the callback was; no function is carried.
      const options = raw.classes[0].fields[0].decorators[0].argumentValues?.[0]
        ?.value as Record<string, unknown>;
      expect(options.validate).toBe(RUNTIME_ONLY_OPTION);
    });

    it('still reads a static value under the same option name', () => {
      const { errors, fields } = scanModel(`
        @crossPackageRef('@fixture/profiles:Profile', { validate: true }) profileId = '';
      `);

      expect(errors).toHaveLength(0);
      expect(fields.profileId._meta?.validate).toBe(true);
    });

    it('reads a reference check flag declared as a same-file constant', () => {
      const { errors, fields } = scanModel(
        `@crossPackageRef('@fixture/profiles:Profile', { validate: CHECK_PROFILE }) profileId = '';`,
        `const CHECK_PROFILE = true;`,
      );

      expect(errors).toHaveLength(0);
      expect(fields.profileId._meta?.validate).toBe(true);
    });

    it.each([
      [
        'an imported flag',
        `import { CHECK_PROFILE } from './flags.js';`,
        'CHECK_PROFILE',
      ],
      ['a let binding', `let CHECK_PROFILE = true;`, 'CHECK_PROFILE'],
      [
        'a call',
        `import { checkProfiles } from './flags.js';`,
        'checkProfiles()',
      ],
      ['a function', '', '() => true'],
    ])('fails on a reference check flag given as %s', (_label, header, expression) => {
      const { errors, fields } = scanModel(
        `@crossPackageRef('@fixture/profiles:Profile', { validate: ${expression} }) profileId = '';`,
        header,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0].filePath).toBe(FILE);
      expect(errors[0].message).toContain(expression);
      expect(errors[0].message).toContain('@crossPackageRef()');
      expect(errors[0].message).toContain('OptionAccount.profileId');
      expect(errors[0].message).toContain('option `validate`');
      expect(fields.profileId._meta?.validate).toBeUndefined();
    });

    it('fails on a validator given to a decorator that takes none', () => {
      const { errors } = scanModel(
        `@foreignKey('OptionAccount', { validate: isOwner }) ownerId = '';`,
        `import { isOwner } from './validators.js';`,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('@foreignKey()');
      expect(errors[0].message).toContain('option `validate`');
    });
  });

  describe('relationship decorators', () => {
    const header = `
      import { ProductionRun } from '@fixture/manufacturing';
      import * as catalog from './catalog.js';
      const POLICY = 'CASCADE';
      const TARGET_NAME = 'OptionLedger';
      const PROFILE = '@fixture/profiles:Profile';
      const lazyOwner = () => OptionOwner;
      class OptionOwner extends SmrtObject {}
    `;

    it('identifies a target given as a name, a class reference or a thunk', () => {
      const { errors, fields } = scanModel(
        `
        @foreignKey(ProductionRun, { nullable: true, onDelete: 'RESTRICT' }) productionRunId: string | null = null;
        @foreignKey(OptionOwner) ownerId = '';
        @foreignKey('OptionOwner') namedOwnerId = '';
        @foreignKey(() => OptionOwner) lazyOwnerId = '';
        @foreignKey(lazyOwner) namedLazyOwnerId = '';
        @foreignKey(TARGET_NAME) ledgerId = '';
        @foreignKey(catalog.Sku) skuId = '';
        @oneToMany(() => ProductionRun, { foreignKey: 'accountId' }) runs: unknown[] = [];
        @crossPackageRef(PROFILE, { onDelete: POLICY }) profileId = '';
      `,
        header,
      );

      expect(errors).toHaveLength(0);
      expect(fields.productionRunId).toMatchObject({
        type: 'foreignKey',
        related: 'ProductionRun',
        required: false,
      });
      expect(fields.productionRunId._meta).toMatchObject({
        nullable: true,
        onDelete: 'RESTRICT',
      });
      expect(fields.ownerId.related).toBe('OptionOwner');
      expect(fields.namedOwnerId.related).toBe('OptionOwner');
      expect(fields.lazyOwnerId.related).toBe('OptionOwner');
      expect(fields.namedLazyOwnerId.related).toBe('OptionOwner');
      expect(fields.ledgerId.related).toBe('OptionLedger');
      // The runtime reads the constructor's own name, not the namespace path.
      expect(fields.skuId.related).toBe('Sku');
      expect(fields.runs).toMatchObject({
        type: 'oneToMany',
        related: 'ProductionRun',
      });
      expect(fields.profileId).toMatchObject({
        type: 'crossPackageRef',
        related: '@fixture/profiles:Profile',
      });
      expect(fields.profileId._meta?.onDelete).toBe('CASCADE');
    });

    it('reads a delete policy declared as a constant', () => {
      const { errors, fields } = scanModel(
        `
        @foreignKey(OptionOwner, { onDelete: 'CASCADE' }) literalOwnerId = '';
        @foreignKey(OptionOwner, { onDelete: POLICY }) constantOwnerId = '';
      `,
        header,
      );

      expect(errors).toHaveLength(0);
      expect(fields.constantOwnerId._meta).toEqual(fields.literalOwnerId._meta);
      expect(fields.constantOwnerId._meta?.onDelete).toBe('CASCADE');
    });

    it.each([
      [
        'an unreadable delete policy',
        '@foreignKey(OptionOwner, { onDelete: importedPolicy }) ownerId = "";',
        '@foreignKey()',
        'importedPolicy',
      ],
      [
        'a target no class can be read from',
        '@foreignKey(pickTarget()) ownerId = "";',
        '@foreignKey()',
        'pickTarget()',
      ],
      [
        'a qualified name that is not a readable string',
        '@crossPackageRef(importedName) ownerId = "";',
        '@crossPackageRef()',
        'importedName',
      ],
    ])('fails on %s', (_label, declaration, decorator, expression) => {
      const { errors, fields } = scanModel(
        declaration,
        `${header}\nimport { importedPolicy, importedName } from './policy.js';`,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain(expression);
      expect(errors[0].message).toContain(decorator);
      expect(errors[0].message).toContain('OptionAccount.ownerId');
      expect(fields.ownerId.related).not.toBe(expression);
    });
  });

  describe('report field decorators', () => {
    it('reads column names and options through constants', () => {
      const result = parseSource(
        `import { SmrtReport, groupBy, sum, count, month } from '@happyvertical/smrt-reports';
         import { smrt } from '@happyvertical/smrt-core';
         const STATUS = 'status';
         const DISTINCT = true;

         @smrt()
         export class OptionAccount extends SmrtReport {
           @groupBy(STATUS) status = '';
           @month('createdAt') period = '';
           @sum('amountCents', { distinct: DISTINCT }) total = 0;
           @count({ distinct: DISTINCT }) rows = 0;
         }`,
        FILE,
      );
      const resolver = new InheritanceResolver();
      resolver.addClasses(result.classes);
      const { fields } = new ManifestAdapter().toSmartObjectDefinition(
        resolver.resolveAll()[0],
      );

      expect(result.errors).toHaveLength(0);
      expect(fields.status._meta?.__report).toEqual({
        kind: 'group',
        sourceColumn: 'status',
      });
      expect(fields.period._meta?.__report).toEqual({
        kind: 'bucket',
        unit: 'month',
        sourceColumn: 'createdAt',
      });
      expect(fields.total._meta?.__report).toEqual({
        kind: 'aggregate',
        fn: 'sum',
        column: 'amountCents',
        distinct: true,
      });
      expect(fields.rows._meta?.__report).toEqual({
        kind: 'aggregate',
        fn: 'count',
        distinct: true,
      });
    });

    it('fails on a column the scanner cannot read instead of recording its identifier', () => {
      const result = parseSource(
        `import { SmrtReport, groupBy } from '@happyvertical/smrt-reports';
         import { smrt } from '@happyvertical/smrt-core';
         import { STATUS } from './columns.js';

         @smrt()
         export class OptionAccount extends SmrtReport {
           @groupBy(STATUS) status = '';
         }`,
        FILE,
      );

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('@groupBy()');
      expect(result.errors[0].message).toContain('OptionAccount.status');
    });
  });

  describe('static properties carried in the manifest', () => {
    it('reads a literal or scalar-constant initializer and fails on an object constant', () => {
      const { errors, definition } = scanModel(
        `
        static uiSlots = SLOTS;
        static adminRoutes = [{ path: ROUTE, component: 'SourcesPanel' }];
      `,
        `const ROUTE = 'sources';\nconst SLOTS = { sources: { id: 'sources', label: 'Sources', order: 1 } };`,
      );

      expect(errors).toHaveLength(1);
      expect(errors[0].message).toContain('SLOTS');
      expect(definition.staticProperties?.adminRoutes).toEqual([
        { path: 'sources', component: 'SourcesPanel' },
      ]);
    });

    it('fails on an initializer it cannot read and names the class', () => {
      const { errors, definition } = scanModel(
        `static adminRoutes = buildRoutes();\nstatic uiSlots = { sources: { id: 'sources', label: labelFor('sources') } };`,
      );

      expect(errors).toHaveLength(2);
      expect(errors[0].message).toContain('buildRoutes()');
      expect(errors[0].message).toContain('static adminRoutes');
      expect(errors[0].message).toContain('OptionAccount');
      expect(errors[1].message).toContain(`labelFor('sources')`);
      expect(definition.staticProperties?.adminRoutes).toBeUndefined();
    });

    it('leaves other static properties alone', () => {
      const { errors } = scanModel(`static defaults = loadDefaults();`);

      expect(errors).toHaveLength(0);
    });
  });
});

describe('field decorator diagnostics on classes without @smrt()', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  async function scanProject(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), 'smrt-field-options-'));
    roots.push(root);
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
    const scanner = new OxcScanner({ cwd: root, include: ['src/**/*.ts'] });
    const { results, resolved } = await scanner.scanAndResolve();
    return {
      root,
      errors: results.errors.filter((e) => e.severity === 'error'),
      resolved,
      rerun: () => scanner.resolve(),
      results,
    };
  }

  const UNREADABLE = `@field({ sensitive: true, maxLength: LIMIT }) token = '';`;
  const IMPORTS = `import { SmrtObject, smrt, field } from '@happyvertical/smrt-core';\nimport { LIMIT } from './limits.js';`;

  it('fails for an undecorated class that reaches the manifest', async () => {
    const { errors, root, rerun, results } = await scanProject({
      'src/models/OptionBase.ts': `${IMPORTS}\nexport abstract class OptionBase extends SmrtObject {\n  ${UNREADABLE}\n}`,
    });

    expect(errors).toHaveLength(1);
    expect(errors[0].filePath).toBe(join(root, 'src/models/OptionBase.ts'));
    expect(errors[0].message).toContain('OptionBase.token');
    expect(errors[0].message).toContain('option `maxLength`');

    // Resolving again reports the same diagnostic once, not twice.
    rerun();
    expect(results.errors.filter((e) => e.severity === 'error')).toHaveLength(
      1,
    );
  });

  it('fails for an undecorated ancestor whose fields a single-table model merges', async () => {
    const { errors } = await scanProject({
      'src/models/OptionMixin.ts': `${IMPORTS}\nexport class OptionMixin {\n  ${UNREADABLE}\n}`,
      'src/models/OptionRecord.ts': `import { smrt } from '@happyvertical/smrt-core';\nimport { OptionMixin } from './OptionMixin.js';\n@smrt({ tableStrategy: 'sti' })\nexport class OptionRecord extends OptionMixin {}`,
    });

    // The field diagnostic, and the plain class in the model's chain.
    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.message).join('\n')).toContain(
      'OptionMixin.token',
    );
    expect(errors.map((e) => e.message).join('\n')).toContain(
      'OptionRecord extends OptionMixin',
    );
  });

  it('stays quiet for a class that is not part of any model', async () => {
    const { errors, resolved, results } = await scanProject({
      'src/forms/OptionForm.ts': `import { field, max } from './form-decorators.js';\nimport { LIMIT } from './limits.js';\nexport class OptionForm {\n  @field({ label: translate('token'), maxLength: LIMIT }) token = '';\n  @max(LIMIT) size = 0;\n  static adminRoutes = buildRoutes();\n}`,
    });

    expect(errors).toHaveLength(0);
    expect(resolved).toHaveLength(0);
    // The parser still holds what it found, for whoever resolves the class.
    expect(results.classes[0].configErrors?.length).toBe(4);
  });
});

describe('ManifestAdapter with hand-built decorators', () => {
  const adapter = new ManifestAdapter();
  function handBuilt(args: string[], name = 'field'): RawFieldDefinition {
    return {
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
    };
  }

  it('reads literal option text', () => {
    const result = adapter.convertField(
      handBuilt(['{ sensitive: true, maxLength: 16, pattern: /^[a-z]+$/ }']),
    );

    expect(result).toMatchObject({ sensitive: true, maxLength: 16 });
    const pattern = result?._meta?.pattern;
    expect(pattern).toBeInstanceOf(RegExp);
    expect(String(pattern)).toBe('/^[a-z]+$/');
  });

  it('throws on option text it cannot read instead of discarding the object', () => {
    expect(() =>
      adapter.convertField(
        handBuilt(['{ sensitive: true, maxLength: MAX_LENGTH }']),
      ),
    ).toThrow(/MAX_LENGTH.*@field\(\)/s);
  });

  it('records a validator in field option text and throws on an unreadable reference check flag', () => {
    const meta = adapter.convertField(
      handBuilt(['{ validate: isHandle, unique: true }']),
    )?._meta;
    expect(meta?.unique).toBe(true);
    expect(meta?.__statedOptions).toContain('validate');
    expect(meta).not.toHaveProperty('validate');
    expect(() =>
      adapter.convertField(
        handBuilt(
          ["'@fixture/profiles:Profile'", '{ validate: CHECK_PROFILE }'],
          'crossPackageRef',
        ),
      ),
    ).toThrow(/CHECK_PROFILE.*@crossPackageRef\(\)/s);
  });

  it('names the class and field when a definition is converted', () => {
    const field = handBuilt(['{ transient: true, description: describe() }']);
    expect(() =>
      adapter.toSmartObjectDefinition({
        className: 'OptionAccount',
        filePath: FILE,
        extendsClause: 'SmrtObject',
        extendsTypeArg: null,
        decoratorConfig: {},
        hasSmartDecorator: true,
        fields: [field],
        methods: [],
        startLine: 1,
        endLine: 1,
        inheritanceChain: ['SmrtObject', 'OptionAccount'],
        stiBase: null,
        effectiveTableStrategy: 'cti',
        isSTI: false,
        isFrameworkBase: false,
        allFields: [field],
        packageName: null,
      }),
    ).toThrow(/option-account\.ts: OptionAccount\.token: .*describe\(\)/s);
  });

  it('does not run option text', () => {
    const marker = '__optionAccountAdapterRan';
    const globals = globalThis as Record<string, unknown>;
    delete globals[marker];

    expect(() =>
      adapter.convertField(
        handBuilt([`{ description: (globalThis.${marker} = 'ran') }`]),
      ),
    ).toThrow();
    expect(globals[marker]).toBeUndefined();
  });
});
