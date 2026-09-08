import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field, foreignKey } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

describe('constructor provenance (#2763)', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = snapshotObjectRegistryState();
  });
  afterEach(() => restore());

  it('clears both legacy and constructor provenance when the registry resets', () => {
    class ResetRecord2763 extends SmrtObject {}
    ObjectRegistry.registerFieldDecorator('ResetRecord2763', 'legacy', {
      type: 'text',
    });
    field({ type: 'integer' })(ResetRecord2763.prototype, 'owned');
    ObjectRegistry.clear();
    ObjectRegistry.register(ResetRecord2763, {
      packageName: '@provenance/reset',
    });
    expect(
      ObjectRegistry.getClassByConstructor(ResetRecord2763)?.fields.size,
    ).toBe(0);
  });

  it.each([
    false,
    true,
  ])('isolates public field metadata before either registration (reverse=%s)', (reverse) => {
    const A = class Record extends SmrtObject {};
    const B = class Record extends SmrtObject {};
    field({ type: 'integer', required: true })(A.prototype, 'ownerOnly');
    field({ type: 'text' })(B.prototype, 'title');
    for (const [ctor, packageName] of reverse
      ? ([
          [B, '@provenance/b'],
          [A, '@provenance/a'],
        ] as const)
      : ([
          [A, '@provenance/a'],
          [B, '@provenance/b'],
        ] as const)) {
      ObjectRegistry.register(ctor, { packageName });
    }
    expect(
      ObjectRegistry.getClassByConstructor(B)?.fields.has('ownerOnly'),
    ).toBe(false);
    expect(ObjectRegistry.getClassByConstructor(A)?.fields.has('title')).toBe(
      false,
    );
    expect(
      ObjectRegistry.getClassByConstructor(A)?.fields.get('ownerOnly')?.type,
    ).toBe('integer');
  });

  it('preserves explicit string-only metadata and registered inheritance', async () => {
    const A = class LegacyRecord extends SmrtObject {};
    const B = class LegacyRecord extends SmrtObject {};
    field({ type: 'integer' })(A.prototype, 'ownerOnly');
    ObjectRegistry.registerFieldDecorator('LegacyRecord', 'legacy', {
      type: 'text',
      description: 'legacy metadata',
    });
    field({ type: 'text', nullable: true })(B.prototype, 'legacy');
    ObjectRegistry.register(A, { packageName: '@provenance/a' });
    ObjectRegistry.register(B, { packageName: '@provenance/b' });
    expect(
      ObjectRegistry.getClassByConstructor(B)?.fields.get('legacy'),
    ).toMatchObject({
      type: 'text',
      _meta: { description: 'legacy metadata', nullable: true },
    });
    expect(
      ObjectRegistry.getClassByConstructor(B)?.fields.has('ownerOnly'),
    ).toBe(false);
    const Child = class ProvenanceDescendant2763 extends A {};
    ObjectRegistry.register(Child, { packageName: '@provenance/a' });
    expect(
      (
        await ObjectRegistry.getAllFields(
          '@provenance/a:ProvenanceDescendant2763',
        )
      ).get('ownerOnly')?.type,
    ).toBe('integer');
  });

  it.each([
    'constructor',
    'callback',
    'string',
  ] as const)('keeps deferred %s foreign keys with package B during colliding-ID deletes', async (form) => {
    const A = class ProvenanceParent2763 extends SmrtObject {};
    const B = class ProvenanceParent2763 extends SmrtObject {};
    const Child = class ProvenanceChild2763 extends SmrtObject {
      parentId = '';
    };
    smrt({ packageName: '@provenance/a', tableName: 'provenance_parent_a' })(A);
    foreignKey(
      form === 'constructor'
        ? B
        : form === 'callback'
          ? () => B
          : 'ProvenanceParent2763',
      {
        onDelete: 'CASCADE',
        constraint: { engines: ['postgres'] },
      },
    )(Child.prototype, 'parentId');
    smrt({ packageName: '@provenance/b', tableName: 'provenance_child_b' })(
      Child,
    );
    smrt({ packageName: '@provenance/b', tableName: 'provenance_parent_b' })(B);
    const db = await getTestDatabase({
      classes: [
        '@provenance/a:ProvenanceParent2763',
        '@provenance/b:ProvenanceParent2763',
        '@provenance/b:ProvenanceChild2763',
      ],
    });
    try {
      const id = randomUUID();
      const a = await new A({ db }).initialize();
      const b = await new B({ db }).initialize();
      a.id = id;
      b.id = id;
      await a.save();
      await b.save();
      const child = await new Child({ db }).initialize();
      child.parentId = id;
      await child.save();
      expect(
        ObjectRegistry.getTableName('@provenance/b:ProvenanceChild2763'),
      ).toBe('provenance_child_b');
      await a.delete();
      expect(await db.list('provenance_child_b', {})).toHaveLength(1);
      expect(await db.list('provenance_parent_b', {})).toHaveLength(1);
      await b.delete();
      expect(await db.list('provenance_child_b', {})).toHaveLength(0);
      expect(
        ObjectRegistry.getInverseRelationshipsForSelf(
          '@provenance/a:ProvenanceParent2763',
        ),
      ).toEqual([]);
      expect(
        ObjectRegistry.getInverseRelationshipsForSelf(
          '@provenance/b:ProvenanceParent2763',
        ),
      ).toEqual([
        expect.objectContaining({
          fieldName: 'parentId',
          targetQualifiedClass: '@provenance/b:ProvenanceParent2763',
        }),
      ]);
    } finally {
      await db.close();
    }
  });

  it.each([
    false,
    true,
  ])('does not bind an unregistered exact target to a registered peer (callback=%s)', (callback) => {
    const A = class DeferredParent2763 extends SmrtObject {};
    const B = class DeferredParent2763 extends SmrtObject {};
    const Child = class DeferredChild2763 extends SmrtObject {};
    ObjectRegistry.register(A, { packageName: '@provenance/a' });
    foreignKey(callback ? () => B : B)(Child.prototype, 'parentId');
    ObjectRegistry.register(Child, { packageName: '@provenance/b' });
    expect(
      ObjectRegistry.getInverseRelationshipsForSelf(
        '@provenance/a:DeferredParent2763',
      ),
    ).toEqual([]);
    ObjectRegistry.register(B, { packageName: '@provenance/b' });
    expect(
      ObjectRegistry.getInverseRelationshipsForSelf(
        '@provenance/b:DeferredParent2763',
      ),
    ).toHaveLength(1);
  });

  it('retains legacy inverse inspection for a string target not yet registered', () => {
    class LegacyChild2763 extends SmrtObject {}
    foreignKey('UnregisteredLegacyTarget2763')(
      LegacyChild2763.prototype,
      'parentId',
    );
    foreignKey('@unregistered/pkg:Target2763')(
      LegacyChild2763.prototype,
      'qualifiedId',
    );
    ObjectRegistry.register(LegacyChild2763);
    expect(
      ObjectRegistry.getInverseRelationships('UnregisteredLegacyTarget2763'),
    ).toHaveLength(1);
    expect(
      ObjectRegistry.getInverseRelationshipsForSelf(
        'UnregisteredLegacyTarget2763',
      ),
    ).toHaveLength(1);
    expect(
      ObjectRegistry.getInverseRelationships('@unregistered/pkg:Target2763'),
    ).toHaveLength(1);
  });
});
