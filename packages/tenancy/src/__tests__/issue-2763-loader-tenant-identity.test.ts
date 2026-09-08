import { randomUUID } from 'node:crypto';
import {
  field,
  foreignKey,
  ObjectRegistry,
  oneToMany,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TenantContextError,
  withSystemContext,
  withTenant,
} from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { disableTenancy, enableTenancy } from '../interceptor.js';

const TENANT = 'aaaaaaaa-2763-4aaa-8aaa-aaaaaaaaaaa1';

describe('canonical relationship target tenancy (#2763)', () => {
  beforeEach(() => {
    disableTenancy();
    ObjectRegistry.clear();
  });
  afterEach(() => disableTenancy());

  for (const form of ['constructor', 'callback', 'string'] as const) {
    for (const mode of ['required', 'optional'] as const) {
      it.each([
        'lazy FK',
        'eager FK',
        'lazy many',
        'eager many',
        'latest',
      ] as const)(`${form}/${mode}: %s applies package B target policy`, async (loader) => {
        const A = class TenantLoaderTarget2763 extends SmrtObject {
          title = '';
          tenantId: string | null = null;
          sourceId = '';
        };
        const B = class TenantLoaderTarget2763 extends SmrtObject {
          title = '';
          tenantId: string | null = null;
          sourceId = '';
        };
        const Source = class TenantLoaderSource2763 extends SmrtObject {
          targetId: string | null = null;
          title = '';
          tenantId: string | null = null;
          targets: SmrtObject[] = [];
        };
        const target = (ctor: Function) =>
          form === 'constructor'
            ? ctor
            : form === 'callback'
              ? () => ctor
              : ctor.name;
        for (const [Ctor, pkg, table, targetMode] of [
          [
            A,
            '@tenant-loader/a',
            'tenant_loader_target_a',
            mode === 'required' ? 'optional' : 'required',
          ],
          [B, '@tenant-loader/b', 'tenant_loader_target_b', mode],
        ] as const) {
          field({ type: 'text' })(Ctor.prototype, 'title');
          tenantId({ nullable: true })(Ctor.prototype, 'tenantId');
          foreignKey(Source, { nullable: true })(Ctor.prototype, 'sourceId');
          TenantScoped({ mode: targetMode })(Ctor);
          smrt({ packageName: pkg, tableName: table })(Ctor);
        }
        field({ type: 'text' })(Source.prototype, 'title');
        field({ type: 'text', nullable: true })(Source.prototype, 'tenantId');
        foreignKey(target(B), { nullable: true })(Source.prototype, 'targetId');
        oneToMany(target(B), { foreignKey: 'sourceId' })(
          Source.prototype,
          'targets',
        );
        smrt({
          packageName: '@tenant-loader/b',
          tableName: 'tenant_loader_sources',
        })(Source);
        const db = await getTestDatabase({
          classes: [
            '@tenant-loader/a:TenantLoaderTarget2763',
            '@tenant-loader/b:TenantLoaderTarget2763',
            '@tenant-loader/b:TenantLoaderSource2763',
          ],
        });
        enableTenancy();
        try {
          const id = randomUUID();
          // Seed the cyclic references through nullable fields, using public saves.
          const source = await new Source({ db }).initialize();
          source.title = 'source';
          source.tenantId = TENANT;
          await source.save();
          await withSystemContext(async () => {
            for (const [Ctor, title] of [
              [A, 'A-secret'],
              [B, 'B-owned'],
            ] as const) {
              const row = await new Ctor({ db }).initialize();
              row.id = id;
              row.title = title;
              row.sourceId = source.id;
              row.tenantId = TENANT;
              await row.save();
            }
          });
          source.targetId = id;
          await source.save();
          const sources = await ObjectRegistry.getCollection<
            InstanceType<typeof Source>
          >('@tenant-loader/b:TenantLoaderSource2763', { db });
          const read = async () => {
            if (loader === 'latest') {
              const rows = await sources.listWithLatestRelated({
                latestRelated: {
                  relation: 'targets',
                  orderBy: 'created_at DESC',
                  select: ['id', 'title'],
                },
              });
              return rows[0].latestRelated;
            }
            const many = loader.includes('many');
            const relation = many ? 'targets' : 'targetId';
            const item = (
              await sources.list(
                loader.startsWith('eager') ? { include: [relation] } : {},
              )
            )[0];
            const loaded = many
              ? (await item.loadRelatedMany(relation))[0]
              : await item.loadRelated(relation);
            expect(loaded.constructor).toBe(B);
            expect(loaded.tableName).toBe('tenant_loader_target_b');
            return loaded;
          };
          await withTenant({ tenantId: TENANT }, async () => {
            expect(await read()).toMatchObject({ id, title: 'B-owned' });
          });
          // Source is unscoped: absence must be evaluated on the actual target,
          // not denied early by source policy or accepted by package A's policy.
          if (mode === 'required')
            await expect(read()).rejects.toBeInstanceOf(TenantContextError);
          else expect(await read()).toMatchObject({ id, title: 'B-owned' });
        } finally {
          disableTenancy();
          await db.close();
        }
      });
    }
  }
});
