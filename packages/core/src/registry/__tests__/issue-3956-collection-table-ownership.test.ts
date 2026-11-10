/**
 * Regression tests for #3956 (and its duplicate #4181): collection manifest
 * entries must not become independent owners of their model's table, and
 * `getTestDatabase({ classes })` must not be aborted by a table-ownership
 * collision outside the tables it creates.
 *
 * The fixture is the smrt-messages account family as a clean build emits it
 * (isolated to the four classes the issue names):
 *
 * - `Account` (STI base on `accounts`) and `EmailAccount extends Account`;
 * - `AccountCollection extends SmrtCollection<Account>`;
 * - `EmailAccountCollection extends AccountCollection` — a multilevel
 *   collection with no generic argument of its own, whose entry carries the
 *   model's `tableName` and `schema` like every collection entry (#2834).
 *
 * The collection constructors descend from a stand-in for ANOTHER copy of
 * smrt-core's `SmrtCollection` (two core module instances share the
 * `globalThis` registry, but not `SmrtCollection.prototype`), and the parent
 * collection's own manifest entry is absent, as in a consumer whose manifest
 * family lists the subclass but not the parent. Those are the two runtime
 * signals classification used to depend on; the manifest's `collectionOf`
 * classification must hold without them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtObject } from '../../object';
import { ObjectRegistry } from '../../registry';
import { ManifestGenerator } from '../../scanner/manifest-generator';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../../scanner/types.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { getTestDatabase } from '../../testing/database';

const PKG = '@happyvertical/smrt-messages';
const ACCOUNT_COLUMNS = ['name', 'provider_type', 'email'];

function model(
  className: string,
  extendsName: string,
  fields: string[],
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${PKG}:${className}`,
    packageName: PKG,
    collection: 'accounts',
    filePath: `packages/messages/src/models/${className}.ts`,
    extends: extendsName,
    fields: Object.fromEntries(
      fields.map((field) => [field, { type: 'text' }]),
    ),
    methods: {},
    decoratorConfig: { tableName: 'accounts', tableStrategy: 'sti' },
  } as unknown as SmartObjectDefinition;
}

function collection(
  className: string,
  extendsName: string,
  extendsTypeArg?: string,
): SmartObjectDefinition {
  return {
    name: className.toLowerCase(),
    className,
    qualifiedName: `${PKG}:${className}`,
    packageName: PKG,
    collection: `${className.toLowerCase()}s`,
    filePath: `packages/messages/src/collections/${className}.ts`,
    extends: extendsName,
    ...(extendsTypeArg ? { extendsTypeArg } : {}),
    fields: {},
    methods: {},
    decoratorConfig: {},
  } as unknown as SmartObjectDefinition;
}

/** The account family through the real scanner passes. */
function generatedAccountFamily(): SmartObjectManifest {
  const manifest: SmartObjectManifest = {
    version: '1.0.0',
    timestamp: 0,
    packageName: PKG,
    objects: Object.fromEntries(
      [
        model('Account', 'SmrtObject', ['name', 'providerType']),
        model('EmailAccount', 'Account', ['email']),
        collection('AccountCollection', 'SmrtCollection', 'Account'),
        collection('EmailAccountCollection', 'AccountCollection'),
      ].map((object) => [`${PKG}:${object.className}`, object]),
    ),
  } as SmartObjectManifest;
  const generator = new ManifestGenerator();
  generator.mergeInheritedFields(manifest);
  generator.generateSchemas(manifest);
  return manifest;
}

function declaredIn<T extends abstract new (...args: never[]) => unknown>(
  ctor: T,
  className: string,
): T {
  Object.defineProperty(ctor, 'name', { value: className });
  Object.defineProperty(ctor, '__package__', { value: PKG });
  return ctor;
}

/** Live constructors whose collections descend from another core copy. */
function accountConstructors() {
  /** Stand-in for a second smrt-core module instance's `SmrtCollection`. */
  class ForeignSmrtCollection {}
  const Account = declaredIn(class extends SmrtObject {}, 'Account');
  const EmailAccount = declaredIn(class extends Account {}, 'EmailAccount');
  const AccountCollection = declaredIn(
    class extends ForeignSmrtCollection {
      static readonly _itemClass = Account;
    },
    'AccountCollection',
  );
  const EmailAccountCollection = declaredIn(
    class extends AccountCollection {
      static override readonly _itemClass = EmailAccount;
    },
    'EmailAccountCollection',
  );
  return { Account, EmailAccount, AccountCollection, EmailAccountCollection };
}

function registerAccountFamily(order: 'manifest-first' | 'constructor-first') {
  const manifest = generatedAccountFamily();
  // The consumer's manifest family names the subclass collection but not
  // its parent collection.
  delete manifest.objects[`${PKG}:AccountCollection`];
  const ctors = Object.values(accountConstructors());
  const registerConstructors = () => {
    for (const ctor of ctors) {
      ObjectRegistry.register(ctor as never, { packageName: PKG } as never);
    }
  };
  if (order === 'constructor-first') registerConstructors();
  ObjectRegistry.registerPackageManifest(manifest);
  if (order === 'manifest-first') registerConstructors();
}

/** Two unrelated models that both claim `clash_3956`. */
function registerUnrelatedClash() {
  const first = class Ledger3956 extends SmrtObject {};
  const second = class Journal3956 extends SmrtObject {};
  ObjectRegistry.register(first, {
    packageName: '@fixture/clash3956-a',
    tableName: 'clash_3956',
  });
  ObjectRegistry.register(second, {
    packageName: '@fixture/clash3956-b',
    tableName: 'clash_3956',
  });
}

describe('#3956 collection manifests never own their model table', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => {
    restore();
  });

  it('classifies each generated collection entry with the model it manages', () => {
    const { objects } = generatedAccountFamily();
    expect(objects[`${PKG}:AccountCollection`].collectionOf).toBe(
      `${PKG}:Account`,
    );
    expect(objects[`${PKG}:EmailAccountCollection`].collectionOf).toBe(
      `${PKG}:EmailAccount`,
    );
    expect(objects[`${PKG}:Account`].collectionOf).toBeUndefined();
    expect(objects[`${PKG}:EmailAccount`].collectionOf).toBeUndefined();
    // Collection metadata is preserved: routes, storage naming and the
    // model schema copy (#2834) are unchanged.
    expect(
      objects[`${PKG}:EmailAccountCollection`].decoratorConfig.tableName,
    ).toBe('accounts');
    expect(objects[`${PKG}:EmailAccountCollection`].collection).toBe(
      'accounts',
    );
    expect(objects[`${PKG}:EmailAccountCollection`].schema?.tableName).toBe(
      'accounts',
    );
  });

  for (const order of ['manifest-first', 'constructor-first'] as const) {
    it(`keeps accounts to the Account STI family (${order})`, () => {
      registerAccountFamily(order);

      expect(
        ObjectRegistry.getClass(`${PKG}:EmailAccountCollection`)?.collectionOf,
      ).toBe(`${PKG}:EmailAccount`);
      expect(
        ObjectRegistry.isCollectionClass(`${PKG}:EmailAccountCollection`),
      ).toBe(true);
      const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
      expect(Object.keys(schemas.accounts.columns)).toEqual(
        expect.arrayContaining(ACCOUNT_COLUMNS),
      );
    });
  }

  it('still rejects a genuinely unrelated model on the same table', () => {
    registerAccountFamily('manifest-first');
    const Intruder = class Intruder3956 extends SmrtObject {};
    ObjectRegistry.register(Intruder, {
      packageName: '@fixture/intruder3956',
      tableName: 'accounts',
    });
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
      /Table 'accounts' is claimed by unrelated classes/,
    );
  });
});

describe('#3956 getTestDatabase({ classes }) scopes ownership checks', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => {
    restore();
  });

  it('creates the requested family despite an unrelated collision elsewhere', async () => {
    registerAccountFamily('manifest-first');
    registerUnrelatedClash();

    const db = await getTestDatabase({
      classes: [`${PKG}:Account`, `${PKG}:EmailAccount`],
      includeSystemTables: false,
    });
    const tables = await db.query(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = tables.rows.map((row) => row.name);
    expect(names).toContain('accounts');
    expect(names).not.toContain('clash_3956');
    const columns = await db.query("PRAGMA table_info('accounts')");
    expect(columns.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(ACCOUNT_COLUMNS),
    );
  });

  it('keeps the implicit class list strict about every registered table', async () => {
    registerAccountFamily('manifest-first');
    registerUnrelatedClash();
    await expect(
      getTestDatabase({ includeSystemTables: false }),
    ).rejects.toThrow(/Table 'clash_3956' is claimed by unrelated classes/);
  });

  it('stays strict for a collision on a table the request creates', async () => {
    registerUnrelatedClash();
    await expect(
      getTestDatabase({
        classes: ['@fixture/clash3956-a:Ledger3956'],
        includeSystemTables: false,
      }),
    ).rejects.toThrow(/Table 'clash_3956' is claimed by unrelated classes/);
  });

  it('stays strict for a collision on a foreign-key dependency of the request', async () => {
    registerUnrelatedClash();
    const Entry = class Entry3956 extends SmrtObject {};
    ObjectRegistry.register(Entry, {
      packageName: '@fixture/clash3956-a',
      tableName: 'entries_3956',
    });
    const registered = ObjectRegistry.getClass(
      '@fixture/clash3956-a:Entry3956',
    );
    expect(registered?.schema).toBeDefined();
    if (registered?.schema) {
      registered.schema.columns.ledger_id = {
        type: 'TEXT',
        foreignKey: { table: 'clash_3956', column: 'id' },
      } as never;
    }
    await expect(
      getTestDatabase({
        classes: ['@fixture/clash3956-a:Entry3956'],
        includeSystemTables: false,
      }),
    ).rejects.toThrow(/Table 'clash_3956' is claimed by unrelated classes/);
  });
});
