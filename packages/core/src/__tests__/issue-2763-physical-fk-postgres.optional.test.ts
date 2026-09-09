import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { foreignKey } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)(
  'same-name physical foreign key ownership (#2763)',
  () => {
    it.each([
      'constructor',
      'callback',
      'string',
    ] as const)('PG16 same-name %s FK owns only package B rows', async (form) => {
      if (!pgUrl) throw new Error('SMRT_TEST_POSTGRES_URL is required');
      const restore = snapshotObjectRegistryState();
      const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
      const aTable = `p2763_a_${suffix}`;
      const bTable = `p2763_b_${suffix}`;
      const childTable = `p2763_child_${suffix}`;
      const packageA = `@p2763/a-${suffix}`;
      const packageB = `@p2763/b-${suffix}`;
      const aKey = `${packageA}:ProvenancePgParent2763`;
      const bKey = `${packageB}:ProvenancePgParent2763`;
      const childKey = `${packageB}:ProvenancePgChild2763`;
      const db = await getDatabase({ type: 'postgres', url: pgUrl });
      try {
        const A = class ProvenancePgParent2763 extends SmrtObject {};
        const B = class ProvenancePgParent2763 extends SmrtObject {};
        const Child = class ProvenancePgChild2763 extends SmrtObject {
          parentId = '';
        };
        smrt({ packageName: packageA, tableName: aTable })(A);
        foreignKey(
          form === 'constructor'
            ? B
            : form === 'callback'
              ? () => B
              : 'ProvenancePgParent2763',
          { onDelete: 'CASCADE' },
        )(Child.prototype, 'parentId');
        smrt({ packageName: packageB, tableName: childTable })(Child);
        smrt({ packageName: packageB, tableName: bTable })(B);

        // Public registry schema generator, default physical FK enforcement.
        // No hand-written model DDL and no omitted FK constraints.
        await getTestDatabase({
          db,
          type: 'postgres',
          classes: [aKey, bKey, childKey],
        });
        expect(ObjectRegistry.getInverseRelationshipsForSelf(aKey)).toEqual([]);
        expect(
          ObjectRegistry.getInverseRelationshipsForSelf(bKey),
        ).toHaveLength(1);

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

        // Inspect the physical FK as a separate assertion after the real delete:
        // a bad FK must surface as lost B data, not only as a metadata mismatch.
        await a.delete();
        expect(await db.list(childTable, {})).toHaveLength(1);
        expect(await db.list(bTable, {})).toHaveLength(1);
        const constraints = await db.query<{ target_table: string }>(
          "SELECT confrelid::regclass::text AS target_table FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'f'",
          [childTable],
        );
        expect(constraints.rows).toEqual(
          expect.arrayContaining([{ target_table: bTable }]),
        );
        await b.delete();
        expect(await db.list(childTable, {})).toHaveLength(0);
      } finally {
        // Exact random test tables only; child first handles either correct or
        // incorrect parent dependencies without broad DROP ... CASCADE.
        try {
          for (const table of [childTable, bTable, aTable]) {
            await db.query(`DROP TABLE IF EXISTS "${table}"`);
          }
        } finally {
          await db.close();
          restore();
        }
      }
    });
  },
);
