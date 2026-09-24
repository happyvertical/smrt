/**
 * Regression tests for #3098: two packages that declare a class with the same
 * simple name (smrt-ledgers and smrt-messages both declare `Account`).
 *
 * Each package's constructor must keep its own registry identity, fields and
 * table whichever package registers first; an unqualified `extends` must bind
 * to the declaring package's own base; and the schema planner must refuse to
 * merge two unrelated classes into one table.
 *
 * Package identity is simulated with the `__package__` constructor metadata
 * `getPackageName()` reads, standing in for the stack attribution a real
 * package module gets.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigurationError } from '../../errors';
import { SmrtObject } from '../../object';
import { ObjectRegistry } from '../../registry';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types.js';

const LEDGER = '@t3098/ledger';
const CHAT = '@t3098/chat';

function entry(
  packageName: string,
  className: string,
  options: {
    fields: string[];
    tableName: string;
    extendsName?: string;
    sti?: boolean;
  },
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    packageName,
    extends: options.extendsName ?? 'SmrtObject',
    fields: Object.fromEntries(
      options.fields.map((field) => [field, { type: 'text' }]),
    ),
    methods: {},
    decoratorConfig: {
      tableName: options.tableName,
      ...(options.sti ? { tableStrategy: 'sti' as const } : {}),
    },
    schema: {
      tableName: options.tableName,
      ddl: '',
      columns: Object.fromEntries(
        options.fields.map((field) => [field, { type: 'TEXT' }]),
      ),
      indexes: [],
      version: 'test',
    },
  } as unknown as SmartObjectDefinition;
}

function manifest(
  packageName: string,
  objects: SmartObjectDefinition[],
): SmartObjectManifest {
  return {
    version: '1.0.0',
    timestamp: 0,
    packageName,
    objects: Object.fromEntries(
      objects.map((object) => [`${packageName}:${object.className}`, object]),
    ),
  } as SmartObjectManifest;
}

/** A class the registry attributes to `packageName`, as its module would be. */
function declaredIn(packageName: string, className: string) {
  const ctor = class extends SmrtObject {
    static readonly __package__ = packageName;
  };
  Object.defineProperty(ctor, 'name', { value: className });
  return ctor;
}

function registerBoth(className: string, order: 'ledger' | 'chat') {
  ObjectRegistry.registerPackageManifest(
    manifest(LEDGER, [
      entry(LEDGER, className, {
        fields: ['number', 'kind'],
        tableName: `ledger_${className.toLowerCase()}s`,
      }),
    ]),
  );
  ObjectRegistry.registerPackageManifest(
    manifest(CHAT, [
      entry(CHAT, className, {
        fields: ['channel', 'provider'],
        tableName: `${className.toLowerCase()}s`,
      }),
    ]),
  );
  const ledger = declaredIn(LEDGER, className);
  const chat = declaredIn(CHAT, className);
  for (const ctor of order === 'ledger' ? [ledger, chat] : [chat, ledger]) {
    ObjectRegistry.register(ctor);
  }
  return { ledger, chat };
}

describe('#3098: same-named classes in two packages', () => {
  afterEach(() => ObjectRegistry.clear());

  for (const order of ['ledger', 'chat'] as const) {
    it(`keeps each class's identity, fields and table (${order} first)`, () => {
      const { ledger, chat } = registerBoth('Account', order);

      const ledgerEntry = ObjectRegistry.getClassByConstructor(ledger);
      const chatEntry = ObjectRegistry.getClassByConstructor(chat);
      expect(ledgerEntry?.qualifiedName).toBe(`${LEDGER}:Account`);
      expect(chatEntry?.qualifiedName).toBe(`${CHAT}:Account`);
      expect(ledgerEntry?.constructor).toBe(ledger);
      expect(chatEntry?.constructor).toBe(chat);
      expect([...(ledgerEntry?.fields.keys() ?? [])]).toContain('number');
      expect([...(chatEntry?.fields.keys() ?? [])]).toContain('channel');
      expect(ledgerEntry?.schema?.tableName).toBe('ledger_accounts');
      expect(chatEntry?.schema?.tableName).toBe('accounts');

      const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
      expect(Object.keys(schemas.ledger_accounts.columns)).toContain('number');
      expect(Object.keys(schemas.accounts.columns)).not.toContain('number');
    });
  }

  it("binds an unqualified extends to the declaring package's own base", () => {
    // Another package's same-named base is already registered, and this
    // package's manifest lists the subclass before its base.
    ObjectRegistry.registerPackageManifest(
      manifest(LEDGER, [
        entry(LEDGER, 'Thing', {
          fields: ['number'],
          tableName: 'ledger_things',
        }),
      ]),
    );
    ObjectRegistry.registerPackageManifest(
      manifest(CHAT, [
        entry(CHAT, 'SpecialThing', {
          fields: ['special'],
          tableName: 'things',
          extendsName: 'Thing',
          sti: true,
        }),
        entry(CHAT, 'Thing', {
          fields: ['channel'],
          tableName: 'things',
          sti: true,
        }),
      ]),
    );

    expect(ObjectRegistry.getClass(`${CHAT}:SpecialThing`)?.extends).toBe(
      `${CHAT}:Thing`,
    );
    expect(ObjectRegistry.getSTIBase(`${CHAT}:SpecialThing`)).toBe(
      `${CHAT}:Thing`,
    );
    // One STI family on one table is a legitimate share.
    expect(Object.keys(ObjectRegistry.getAllSchemasAsDefinitions())).toEqual(
      expect.arrayContaining(['things', 'ledger_things']),
    );
  });

  it('refuses to plan one table for two unrelated classes', () => {
    ObjectRegistry.register(declaredIn(LEDGER, 'Entry'), {
      packageName: LEDGER,
      tableName: 'shared_entries',
    });
    ObjectRegistry.register(declaredIn(CHAT, 'Entry'), {
      packageName: CHAT,
      tableName: 'shared_entries',
    });

    let thrown: unknown;
    try {
      ObjectRegistry.getAllSchemasAsDefinitions();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ConfigurationError);
    expect((thrown as ConfigurationError).code).toBe(
      'CONFIG_TABLE_NAME_COLLISION',
    );
    expect((thrown as Error).message).toContain(`${LEDGER}:Entry`);
    expect((thrown as Error).message).toContain(`${CHAT}:Entry`);
  });
});
