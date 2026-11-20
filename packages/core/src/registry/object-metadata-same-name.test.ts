/**
 * `getAllObjectMetadata()` returns one entry per registered class, including
 * two classes that share a simple name in different packages.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../decorators';
import { SmrtObject } from '../object';
import { ObjectRegistry, smrt } from '../registry';
import { snapshotObjectRegistryState } from '../test-utils';

const PKG_LEDGERS = '@metadata-same/ledgers';
const PKG_INBOX = '@metadata-same/inbox';

function defineLedgerEntry() {
  @smrt({
    packageName: PKG_LEDGERS,
    tableName: 'metadata_same_ledger_entries',
  } as any)
  class MetadataSameEntry extends SmrtObject {
    static readonly __package__ = PKG_LEDGERS;
    @field({ type: 'text' }) amount = '';
  }
  return MetadataSameEntry;
}

function defineInboxEntry() {
  @smrt({
    packageName: PKG_INBOX,
    tableName: 'metadata_same_inbox_entries',
  } as any)
  class MetadataSameEntry extends SmrtObject {
    static readonly __package__ = PKG_INBOX;
    @field({ type: 'text' }) channel = '';
  }
  return MetadataSameEntry;
}

function defineUnique() {
  @smrt({
    packageName: PKG_INBOX,
    tableName: 'metadata_same_unique',
  } as any)
  class MetadataSameUnique extends SmrtObject {
    static readonly __package__ = PKG_INBOX;
    @field({ type: 'text' }) note = '';
  }
  return MetadataSameUnique;
}

describe('getAllObjectMetadata with a shared simple name', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  const collect = () =>
    ObjectRegistry.getAllObjectMetadata().filter((meta) =>
      meta.name.startsWith('MetadataSame'),
    );

  it.each([
    ['ledger class first', true],
    ['inbox class first', false],
  ])('returns both same-named classes once (%s)', (_label, ledgerFirst) => {
    const [first, second] = ledgerFirst
      ? [defineLedgerEntry(), defineInboxEntry()]
      : [defineInboxEntry(), defineLedgerEntry()];

    const metas = collect();

    expect(metas.map((meta) => meta.constructor)).toEqual([first, second]);
    expect(metas.map((meta) => meta.schema?.tableName)).toEqual(
      ledgerFirst
        ? ['metadata_same_ledger_entries', 'metadata_same_inbox_entries']
        : ['metadata_same_inbox_entries', 'metadata_same_ledger_entries'],
    );
    expect([...metas[1].fields.keys()]).not.toEqual([
      ...metas[0].fields.keys(),
    ]);
  });

  it('returns uniquely named classes once each', () => {
    const ledger = defineLedgerEntry();
    const unique = defineUnique();

    expect(collect().map((meta) => meta.constructor)).toEqual([ledger, unique]);
  });

  it('returns a class registered under a simple and a qualified key once', () => {
    class MetadataSameAliased extends SmrtObject {}
    ObjectRegistry.register(MetadataSameAliased, {
      name: 'MetadataSameAliased',
      tableName: 'metadata_same_aliased',
    });
    const classes = (
      ObjectRegistry as unknown as {
        classes: Map<string, { name: string; packageName?: string }>;
      }
    ).classes;
    // A source registration not yet promoted to its package-qualified key.
    const [initialKey, entry] = [...classes].find(
      ([, value]) => value.name === 'MetadataSameAliased',
    )!;
    classes.delete(initialKey);
    entry.packageName = undefined;
    (entry as { qualifiedName?: string }).qualifiedName = undefined;
    classes.set('MetadataSameAliased', entry);
    // Manifest hydration merges into it and aliases it under the qualified key.
    ObjectRegistry.registerFromManifest(
      'MetadataSameAliased',
      {
        name: 'metadatasamealiased',
        className: 'MetadataSameAliased',
        collection: 'metadatasamealiaseds',
        fields: { note: { type: 'text', required: false } },
        methods: {},
        decoratorConfig: {},
      } as never,
      PKG_INBOX,
    );
    expect(classes.get('MetadataSameAliased')).toBe(
      classes.get(`${PKG_INBOX}:MetadataSameAliased`),
    );

    const metas = collect().filter(
      (meta) => (meta.constructor as unknown) === MetadataSameAliased,
    );

    expect(metas).toHaveLength(1);
    expect(metas[0].schema?.tableName).toBe('metadata_same_aliased');
  });

  it('keeps getObjectMetadata by qualified name pointing at that class', () => {
    defineLedgerEntry();
    const inbox = defineInboxEntry();

    const meta = ObjectRegistry.getObjectMetadata(
      `${PKG_INBOX}:MetadataSameEntry`,
    );

    expect(meta?.constructor).toBe(inbox);
  });
});
