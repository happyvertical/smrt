/**
 * Two classes that share a simple name in different packages each own their
 * column types: a field's `sqlType` on one must not retype the other's column.
 * Runs on SQLite by default and on PGlite under `pnpm test:pglite`.
 */
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators';
import { createRegisteredTables } from '../migrations/orchestrate.js';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';
import { getTestDatabase } from '../testing/database.js';

const PKG_TYPED = '@samename-sql/typed';
const PKG_PLAIN = '@samename-sql/plain';

function defineTyped() {
  @smrt({ packageName: PKG_TYPED, tableName: 'samename_sql_typed' } as any)
  class SameNameLedger extends SmrtObject {
    static readonly __package__ = PKG_TYPED;
    @field({ sqlType: 'UUID' }) ownerId = '';
    @field({ type: 'text' }) label = '';
  }
  return SameNameLedger;
}

function definePlain() {
  @smrt({ packageName: PKG_PLAIN, tableName: 'samename_sql_plain' } as any)
  class SameNameLedger extends SmrtObject {
    static readonly __package__ = PKG_PLAIN;
    @field({ type: 'text' }) ownerId = '';
    @field({ type: 'text' }) channel = '';
  }
  return SameNameLedger;
}

/** Negative control: unique name, same shape as the plain class. */
function defineUniquelyNamed() {
  @smrt({ packageName: PKG_PLAIN, tableName: 'samename_sql_unique' } as any)
  class SameNameUnique extends SmrtObject {
    static readonly __package__ = PKG_PLAIN;
    @field({ type: 'text' }) ownerId = '';
    @field({ type: 'text' }) channel = '';
  }
  return SameNameUnique;
}

const ownerType = (table: string) =>
  (ObjectRegistry.getAllSchemasAsDefinitions() as any)[table]?.columns?.owner_id
    ?.type;

describe('schema columns for same-named classes', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  it.each([
    ['typed class registered first', true],
    ['plain class registered first', false],
  ])('keeps each class own sqlType (%s)', (_label, typedFirst) => {
    if (typedFirst) {
      defineTyped();
      definePlain();
    } else {
      definePlain();
      defineTyped();
    }
    defineUniquelyNamed();

    expect(ownerType('samename_sql_typed')).toBe('UUID');
    expect(ownerType('samename_sql_plain')).toBe('TEXT');
    expect(ownerType('samename_sql_unique')).toBe('TEXT');
  });

  it('still applies a sqlType override on a uniquely named class', () => {
    @smrt({ packageName: PKG_TYPED, tableName: 'samename_sql_solo' } as any)
    class SameNameSolo extends SmrtObject {
      static readonly __package__ = PKG_TYPED;
      @field({ sqlType: 'INTEGER' }) ownerId = '';
    }
    expect(SameNameSolo).toBeDefined();
    expect(ownerType('samename_sql_solo')).toBe('INTEGER');
  });
});

type Engine = 'sqlite' | 'pglite';
const engines: Engine[] =
  process.env.SMRT_TEST_PGLITE === '1' ? ['pglite'] : ['sqlite'];

describe.each(engines)('same-named classes persist on %s', (engine) => {
  let restore: () => void;
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  beforeEach(async () => {
    restore = snapshotObjectRegistryState();
    db =
      engine === 'pglite'
        ? await getTestDatabase({
            type: 'pglite',
            classes: [],
            includeSystemTables: false,
          })
        : ((await getDatabase({
            type: 'sqlite',
            url: ':memory:',
          })) as typeof db);
  });
  afterEach(async () => {
    await db.close?.();
    restore();
  });

  it('writes a non-uuid owner value into the plain class table', async () => {
    defineTyped();
    const Plain = definePlain();
    const registered = ObjectRegistry.getClassByConstructor(Plain);
    await createRegisteredTables(
      db,
      ['samename_sql_plain'],
      engine === 'pglite' ? 'postgres' : 'sqlite',
    );
    const collection: any = await ObjectRegistry.getCollection(
      registered?.qualifiedName ?? '',
      { db },
    );
    const created = await collection.create({
      slug: 'plain-1',
      ownerId: 'user-handle-42',
      channel: 'c',
    });
    await created.save();
    const loaded = await collection.get({ slug: 'plain-1' });
    expect(loaded.ownerId).toBe('user-handle-42');
  });
});
