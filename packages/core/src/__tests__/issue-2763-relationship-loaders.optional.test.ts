import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  field,
  foreignKey,
  manyToMany,
  oneToMany,
} from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';
import { getTestDatabase } from '../testing/database.js';

const forms = ['constructor', 'callback', 'string'] as const;
const loaders = [
  'lazy FK',
  'getRelated FK',
  'eager FK',
  'lazy many',
  'getRelated many',
  'child accessor',
  'eager many',
  'latest',
  'lazy junction',
  'eager junction',
] as const;

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
// Keep the PostgreSQL contract discoverable by core's optional.test.ts lane;
// SQLite and DuckDB run normally even when the external service is absent.
for (const engine of ['sqlite', 'duckdb', 'postgres'] as const) {
  describe.skipIf(engine === 'postgres' && !pgUrl)(
    `canonical runtime relationship loaders (#2763) [${engine}]`,
    () => {
      let restore: () => void;
      beforeEach(() => {
        restore = snapshotObjectRegistryState();
      });
      afterEach(() => restore());

      for (const form of forms) {
        for (const tenant of [null, 'shared-tenant']) {
          it.each(
            loaders,
          )(`${form}, tenant=${tenant}: %s keeps package B ownership`, async (loader) => {
            const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
            const A = class LoaderParent2763 extends SmrtObject {
              aOnly = 0;
              title = '';
              tenantId: string | null = null;
              children: SmrtObject[] = [];
              peers: SmrtObject[] = [];
            };
            const B = class LoaderParent2763 extends SmrtObject {
              title = '';
              tenantId: string | null = null;
              children: SmrtObject[] = [];
              peers: SmrtObject[] = [];
            };
            const AChild = class LoaderChild2763 extends SmrtObject {
              parentId = '';
              title = '';
              tenantId: string | null = null;
            };
            const BChild = class LoaderChild2763 extends SmrtObject {
              parentId = '';
              title = '';
              tenantId: string | null = null;
            };
            const Join = class LoaderJoin2763 extends SmrtObject {
              parentId = '';
              childId = '';
            };
            const JoinA = class LoaderJoin2763 extends SmrtObject {
              parentId = '';
              childId = '';
            };
            const target = (ctor: Function) =>
              form === 'constructor'
                ? ctor
                : form === 'callback'
                  ? () => ctor
                  : ctor.name;
            field({ type: 'integer' })(A.prototype, 'aOnly');
            for (const [Parent, Child, pkg, owner] of [
              [A, AChild, '@loader/a', 'a'],
              [B, BChild, '@loader/b', 'b'],
            ] as const) {
              for (const ctor of [Parent, Child]) {
                field({ type: 'text' })(ctor.prototype, 'title');
                field({ type: 'text', nullable: true })(
                  ctor.prototype,
                  'tenantId',
                );
              }
              // Native FKs on SQLite/PostgreSQL; DuckDB exercises the supported
              // app-side relationship because it rejects ON UPDATE CASCADE.
              foreignKey(target(Parent), {
                onUpdate: 'RESTRICT',
                onDelete: 'RESTRICT',
                constraint: { engines: ['sqlite', 'postgres'] },
              })(Child.prototype, 'parentId');
              oneToMany(target(Child), { foreignKey: 'parentId' })(
                Parent.prototype,
                'children',
              );
              manyToMany(target(Child), {
                through: `loader_join_${owner}_${suffix}`,
                sourceKey: 'parent_id',
                targetKey: 'child_id',
              })(Parent.prototype, 'peers');
              // Both target constructors exist, but B's child registers before B's parent.
              smrt({
                packageName: pkg,
                tableName: `loader_child_${owner}_${suffix}`,
              })(Child);
              smrt({
                packageName: pkg,
                tableName: `loader_parent_${owner}_${suffix}`,
              })(Parent);
            }
            foreignKey(B, { constraint: { engines: ['sqlite', 'postgres'] } })(
              Join.prototype,
              'parentId',
            );
            foreignKey(BChild, {
              constraint: { engines: ['sqlite', 'postgres'] },
            })(Join.prototype, 'childId');
            smrt({
              packageName: '@loader/b',
              tableName: `loader_join_b_${suffix}`,
            })(Join);
            foreignKey(A, { constraint: { engines: ['sqlite', 'postgres'] } })(
              JoinA.prototype,
              'parentId',
            );
            foreignKey(AChild, {
              constraint: { engines: ['sqlite', 'postgres'] },
            })(JoinA.prototype, 'childId');
            smrt({
              packageName: '@loader/a',
              tableName: `loader_join_a_${suffix}`,
            })(JoinA);
            const db = await getDatabase({
              type: engine,
              url: engine === 'postgres' ? pgUrl : ':memory:',
              // getTestDatabase below owns dependency-ordered DDL. The generic
              // Vitest auto-preparer sees child-first registration and would
              // create PostgreSQL FKs before their parent tables exist.
              __smrtSkipVitestSchemaPreparation: true,
            } as Parameters<typeof getDatabase>[0]);
            try {
              await getTestDatabase({
                db,
                type: engine,
                classes: [
                  '@loader/a:LoaderParent2763',
                  '@loader/a:LoaderChild2763',
                  '@loader/b:LoaderParent2763',
                  '@loader/b:LoaderChild2763',
                  '@loader/b:LoaderJoin2763',
                  '@loader/a:LoaderJoin2763',
                ],
              });
              // Runtime-only classes have no cached manifest schema. Populate it
              // through the public generator, as deployed generated classes do;
              // DuckDB's native UUID read guard validates filters against it.
              for (const owner of ['a', 'b']) {
                for (const name of [
                  'LoaderParent2763',
                  'LoaderChild2763',
                  'LoaderJoin2763',
                ]) {
                  const qualified = `@loader/${owner}:${name}`;
                  const generatedCollection =
                    await ObjectRegistry.getCollection(qualified, { db });
                  const generatedDDL =
                    await generatedCollection.generateSchema();
                  expect(
                    ObjectRegistry.getSchema(qualified)?.columns.id,
                    `${qualified}; collection=${generatedCollection.tableName}; ddl=${generatedDDL.slice(0, 100)}`,
                  ).toBeDefined();
                  expect(ObjectRegistry.getSchema(qualified)?.tableName).toBe(
                    ObjectRegistry.getTableName(qualified),
                  );
                }
              }
              expect(
                ObjectRegistry.getSchema('@loader/a:LoaderParent2763')?.columns
                  .a_only,
              ).toBeDefined();
              expect(
                ObjectRegistry.getSchema('@loader/b:LoaderParent2763')?.columns
                  .a_only,
              ).toBeUndefined();
              const parentId = randomUUID();
              const childId = randomUUID();
              const a = await new A({ db }).initialize();
              const b = await new B({ db }).initialize();
              const aChild = await new AChild({ db }).initialize();
              const bChild = await new BChild({ db }).initialize();
              for (const [parent, child, payload] of [
                [a, aChild, 'A-secret'],
                [b, bChild, 'B-owned'],
              ] as const) {
                parent.id = parentId;
                parent.title = payload;
                parent.tenantId = tenant;
                await parent.save();
                child.id = childId;
                child.parentId = parentId;
                child.title = payload;
                child.tenantId = tenant;
                await child.save();
              }
              const join = await new Join({ db }).initialize();
              join.parentId = parentId;
              join.childId = childId;
              await join.save();
              const joinA = await new JoinA({ db }).initialize();
              joinA.parentId = parentId;
              joinA.childId = childId;
              await joinA.save();
              // Check both owners: testing only the last registered package can
              // accidentally pass through a shared display-name metadata cache.
              for (const owner of ['a', 'b'] as const) {
                const junctions = await ObjectRegistry.getCollection(
                  `@loader/${owner}:LoaderJoin2763`,
                  { db },
                );
                expect(junctions.getItemClass()).toBe(
                  owner === 'a' ? JoinA : Join,
                );
                const savedJunctions = await junctions.list({});
                expect(savedJunctions).toHaveLength(1);
                expect(savedJunctions[0].id).toBe(
                  owner === 'a' ? joinA.id : join.id,
                );
                expect(savedJunctions[0].tableName).toBe(
                  `loader_join_${owner}_${suffix}`,
                );
                const source = owner === 'a' ? a : b;
                const sourceChild = owner === 'a' ? aChild : bChild;
                const Parent = owner === 'a' ? A : B;
                const Child = owner === 'a' ? AChild : BChild;
                const payload = owner === 'a' ? 'A-secret' : 'B-owned';
                const parents = await ObjectRegistry.getCollection<
                  InstanceType<typeof B>
                >(`@loader/${owner}:LoaderParent2763`, { db });
                const children = await ObjectRegistry.getCollection<
                  InstanceType<typeof BChild>
                >(`@loader/${owner}:LoaderChild2763`, { db });
                let result: SmrtObject;
                if (loader === 'lazy FK')
                  result = await sourceChild.loadRelated('parentId');
                else if (loader === 'getRelated FK')
                  result = await sourceChild.getRelated('parentId');
                else if (loader === 'eager FK')
                  result = await (
                    await children.list({ include: ['parentId'] })
                  )[0].loadRelated('parentId');
                else if (loader === 'lazy many')
                  [result] = await source.loadRelatedMany('children');
                else if (loader === 'getRelated many')
                  [result] = await source.getRelated('children');
                else if (loader === 'child accessor')
                  [result] = await (
                    source as InstanceType<typeof B> & {
                      getChildren(): Promise<SmrtObject[]>;
                    }
                  ).getChildren();
                else if (loader === 'eager many')
                  [result] = await (
                    await parents.list({ include: ['children'] })
                  )[0].loadRelatedMany('children');
                else if (loader === 'lazy junction')
                  [result] = await source.loadRelatedMany('peers');
                else if (loader === 'eager junction')
                  [result] = await (
                    await parents.list({ include: ['peers'] })
                  )[0].loadRelatedMany('peers');
                else {
                  const rows = await parents.listWithLatestRelated({
                    latestRelated: {
                      relation: 'children',
                      orderBy: 'created_at DESC',
                      select: ['id', 'title'],
                    },
                  });
                  expect(rows).toHaveLength(1);
                  expect(rows[0].parent.constructor).toBe(Parent);
                  expect(rows[0].latestRelated).toMatchObject({
                    id: childId,
                    title: payload,
                  });
                  continue;
                }
                const isParent = loader.includes('FK');
                expect(result.constructor).toBe(isParent ? Parent : Child);
                expect(result.tableName).toBe(
                  isParent
                    ? `loader_parent_${owner}_${suffix}`
                    : `loader_child_${owner}_${suffix}`,
                );
                expect(result).toMatchObject({
                  title: payload,
                  tenantId: tenant,
                });
              }
            } finally {
              try {
                for (const stem of [
                  'loader_join_a',
                  'loader_join_b',
                  'loader_child_a',
                  'loader_child_b',
                  'loader_parent_a',
                  'loader_parent_b',
                ]) {
                  await db.query(`DROP TABLE IF EXISTS "${stem}_${suffix}"`);
                }
              } finally {
                await db.close();
              }
            }
          });
        }
      }

      it.each([
        false,
        true,
      ])('refuses unresolved exact targets before reading a peer (callback=%s)', async (callback) => {
        const A = class UnresolvedLoaderParent2763 extends SmrtObject {};
        const B = class UnresolvedLoaderParent2763 extends SmrtObject {};
        const Child = class UnresolvedLoaderChild2763 extends SmrtObject {
          parentId = '';
        };
        smrt({ packageName: '@unresolved/a' })(A);
        foreignKey(callback ? () => B : B)(Child.prototype, 'parentId');
        smrt({ packageName: '@unresolved/b' })(Child);
        const child = new Child();
        child.parentId = randomUUID();
        await expect(child.loadRelated('parentId')).rejects.toThrow(
          /Relationship target is unresolved or ambiguous/,
        );
        expect(child.isRelatedLoaded('parentId')).toBe(false);
      });
    },
  );
}
