import { readFileSync } from 'node:fs';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  isApiActionEnabledForObject,
  MCPGenerator,
} from '@happyvertical/smrt-core/generators';
import type { SmartObjectManifest } from '@happyvertical/smrt-core/scanner/types';
import {
  createTenantInterceptor,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it } from 'vitest';
import { Expense } from '../models/Expense';

const models = [{ ctor: Expense, pkg: '@happyvertical/smrt-expenses' }];
afterEach(() => ObjectRegistry.clear());
for (const path of ['runtime', 'manifest'] as const) {
  describe(`consumer restrictions on package models (${path})`, () => {
    for (const { ctor, pkg } of models) {
      it(`closes ${pkg}:${ctor.name} and requires tenant context`, async () => {
        ObjectRegistry.clear();
        const name = `${pkg}:${ctor.name}`;
        const manifest = JSON.parse(
          readFileSync(
            new URL('../../dist/manifest.json', import.meta.url),
            'utf8',
          ),
        ) as SmartObjectManifest;
        const definition = manifest.objects[name];
        expect(definition).toBeDefined();
        if (path === 'runtime') {
          ObjectRegistry.register(ctor, {
            ...definition.decoratorConfig,
            packageName: pkg,
          });
        } else {
          ObjectRegistry.registerFromManifest(name, definition);
        }
        ObjectRegistry.registerOverride(name, {
          api: false,
          cli: false,
          mcp: false,
          tenancy: { mode: 'required' },
        });
        for (const action of [
          'list',
          'get',
          'create',
          'update',
          'delete',
        ] as const)
          expect(isApiActionEnabledForObject(name, action)).toBe(false);
        expect(ObjectRegistry.getConfig(name).cli).toBe(false);
        expect(
          (await new MCPGenerator().generateTools()).filter((tool) =>
            tool.name.startsWith(`${ctor.name.toLowerCase()}_`),
          ),
        ).toEqual([]);
        const interceptor = createTenantInterceptor();
        const context = {
          className: ctor.name,
          qualifiedClassName: name,
          operation: 'list' as const,
          timestamp: new Date(),
        };
        expect(() =>
          interceptor.beforeList?.(ctor.name, {}, context),
        ).toThrow();
        await withTenant({ tenantId: 'tenant-a' }, async () => {
          expect(interceptor.beforeList?.(ctor.name, {}, context)).toEqual({
            where: { tenantId: 'tenant-a' },
          });
        });
      });
    }
  });
}
