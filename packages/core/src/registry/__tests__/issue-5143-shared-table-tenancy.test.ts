/**
 * #5143: a same-named replacement or subtype shares its parent's table, and
 * one table has one ownership column and one tenancy floor. A declaration may
 * add tenancy or require it more strictly; it may not change the ownership
 * field, drop tenancy, or weaken `required` to `optional`. With no conflict,
 * every member of the family resolves one effective policy.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { field } from '../../decorators';
import { assertSameNameSubclassChoices } from '../../manifest/model-replacements';
import { SmrtObject } from '../../object';
import { ObjectRegistry } from '../../registry';
import type { SmartObjectManifest } from '../../scanner/types';
import { snapshotObjectRegistryState } from '../../test-utils';

const BASE = '@fixture/t5143-video:Scene';
const APP = '@fixture/t5143-app:Scene';
const SUB = '@fixture/t5143-histrio:Scene';
const OTHER = '@fixture/t5143-video:VipScene';
const REFUSAL =
  /may add tenancy requirements but cannot change the ownership field or weaken the mode of the table it shares with @fixture\/t5143-video:Scene/;

type Tenancy = { mode?: 'required' | 'optional'; field?: string } | false;

function family(base: Tenancy | undefined) {
  class VideoScene extends SmrtObject {
    title = '';
  }
  class AppScene extends VideoScene {}
  class HistrioScene extends VideoScene {}
  class VipScene extends VideoScene {}
  field({ type: 'text' })(VideoScene.prototype, 'title');
  const common = { name: 'Scene', tableName: 't5143_scenes' };
  return {
    base: () =>
      ObjectRegistry.register(VideoScene, {
        ...common,
        packageName: '@fixture/t5143-video',
        tableStrategy: 'sti',
        ...(base === undefined ? {} : { tenantScoped: base }),
      }),
    app: (tenantScoped?: Tenancy) =>
      ObjectRegistry.register(AppScene, {
        ...common,
        packageName: '@fixture/t5143-app',
        replaceParent: true,
        ...(tenantScoped === undefined ? {} : { tenantScoped }),
      }),
    sub: (tenantScoped?: Tenancy) =>
      ObjectRegistry.register(HistrioScene, {
        ...common,
        packageName: '@fixture/t5143-histrio',
        replaceParent: false,
        ...(tenantScoped === undefined ? {} : { tenantScoped }),
      }),
    other: () =>
      ObjectRegistry.register(VipScene, {
        name: 'VipScene',
        packageName: '@fixture/t5143-video',
        tableName: 't5143_scenes',
      }),
  };
}

const policy = (key: string) => {
  const config = ObjectRegistry.getTenantScopedConfig(key);
  return config && { field: config.field, mode: config.mode };
};

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
  ObjectRegistry.clear();
});
afterEach(() => restore());

describe('tenancy of a table shared by a same-named family', () => {
  it.each([
    ['another ownership field', { field: 'accountId' }],
    ['a weaker mode', { mode: 'optional', field: 'organizationId' }],
    ['no tenancy', false],
  ] as const)('refuses a replacement that declares %s, leaving the parent effective', (_label, declared) => {
    const fixture = family({ mode: 'required', field: 'organizationId' });
    fixture.base();
    expect(() => fixture.app(declared)).toThrow(REFUSAL);
    try {
      fixture.app(declared);
    } catch (error) {
      expect((error as { code?: string }).code).toBe(
        'CONFIG_SAME_NAME_TENANCY_CONFLICT',
      );
    }
    expect(ObjectRegistry.getClass(BASE)?.qualifiedName).toBe(BASE);
    expect(policy(BASE)).toEqual({ field: 'organizationId', mode: 'required' });
  });

  it('refuses a subtype that declares another ownership field than the replacement in effect', () => {
    const fixture = family({ mode: 'optional', field: 'organizationId' });
    fixture.base();
    fixture.app({ mode: 'required', field: 'organizationId' });
    expect(() => fixture.sub({ field: 'accountId' })).toThrow(
      /a subtype may add tenancy requirements/,
    );
    expect(() =>
      fixture.sub({ mode: 'optional', field: 'organizationId' }),
    ).toThrow(/a subtype may add tenancy requirements/);
  });

  it.each([
    ['declares none', undefined, 'required'],
    ['declares the same policy', { field: 'organizationId' }, 'required'],
  ] as const)('resolves one policy for every member when the replacement %s', (_label, declared, mode) => {
    const fixture = family({ mode: 'required', field: 'organizationId' });
    fixture.base();
    fixture.sub();
    fixture.app(declared);
    fixture.other();
    const expected = { field: 'organizationId', mode };
    expect(policy(BASE)).toEqual(expected);
    expect(policy(APP)).toEqual(expected);
    expect(policy(SUB)).toEqual(expected);
    expect(ObjectRegistry.getClass(OTHER)).toBeDefined();
  });

  it.each([
    'subtype-first',
    'replacement-first',
  ] as const)('gives the subtype the stricter mode of a compatible replacement (%s)', (order) => {
    const fixture = family({ mode: 'optional', field: 'organizationId' });
    fixture.base();
    if (order === 'subtype-first') {
      fixture.sub();
      fixture.app({ mode: 'required', field: 'organizationId' });
    } else {
      fixture.app({ mode: 'required', field: 'organizationId' });
      fixture.sub();
    }
    const expected = { field: 'organizationId', mode: 'required' };
    expect(policy(BASE)).toEqual(expected);
    expect(policy(APP)).toEqual(expected);
    expect(policy(SUB)).toEqual(expected);
  });

  it('lets a replacement add tenancy to an unscoped table; the subtype follows it', () => {
    const fixture = family(undefined);
    fixture.base();
    fixture.sub();
    fixture.app({ field: 'organizationId' });
    expect(policy(BASE)).toEqual({ field: 'organizationId', mode: 'required' });
    expect(policy(SUB)).toEqual({ field: 'organizationId', mode: 'required' });
  });

  it('refuses a conflicting replacement manifest entry through registerFromManifest', () => {
    family({ mode: 'required', field: 'organizationId' }).base();
    expect(() =>
      ObjectRegistry.registerFromManifest(
        APP,
        {
          name: 'scene',
          collection: 'scenes',
          className: 'Scene',
          qualifiedName: APP as never,
          packageName: '@fixture/t5143-app',
          extends: 'Scene',
          extendsQualified: BASE,
          filePath: 'src/scene.ts',
          fields: {},
          methods: {},
          schema: { tableName: 't5143_scenes', columns: {} } as never,
          decoratorConfig: {
            replaceParent: true,
            tenantScoped: { field: 'accountId' },
          },
        },
        '@fixture/t5143-app',
      ),
    ).toThrow(REFUSAL);
    expect(ObjectRegistry.getClass(BASE)?.qualifiedName).toBe(BASE);
  });
});

describe('manifest generation check', () => {
  const manifest = (
    replacement: Tenancy | undefined,
    subtype: Tenancy | undefined,
  ): SmartObjectManifest => {
    const entry = (key: string, extra: Record<string, unknown>) => ({
      name: 'scene',
      collection: 'scenes',
      className: 'Scene',
      qualifiedName: key,
      packageName: key.slice(0, key.lastIndexOf(':')),
      filePath: 'src/scene.ts',
      fields: {},
      methods: {},
      schema: { tableName: 't5143_scenes', columns: {} },
      ...extra,
    });
    const child = (choice: boolean, tenantScoped: Tenancy | undefined) => ({
      extends: 'Scene',
      extendsQualified: BASE,
      decoratorConfig: {
        replaceParent: choice,
        ...(tenantScoped === undefined ? {} : { tenantScoped }),
      },
    });
    return {
      version: '1',
      timestamp: 0,
      packageName: '@fixture/t5143-app',
      objects: {
        [BASE]: entry(BASE, {
          decoratorConfig: {
            tableStrategy: 'sti',
            tenantScoped: { mode: 'optional', field: 'organizationId' },
          },
        }),
        [APP]: entry(APP, child(true, replacement)),
        [SUB]: entry(SUB, child(false, subtype)),
      },
    } as unknown as SmartObjectManifest;
  };

  it('refuses a replacement on another ownership field', () => {
    expect(() =>
      assertSameNameSubclassChoices(
        manifest({ field: 'accountId' }, undefined),
      ),
    ).toThrow(REFUSAL);
  });

  it('holds a subtype declaration to the replacement in effect', () => {
    const stricter = { mode: 'required', field: 'organizationId' } as const;
    expect(() =>
      assertSameNameSubclassChoices(
        manifest(stricter, { mode: 'optional', field: 'organizationId' }),
      ),
    ).toThrow(/a subtype may add tenancy requirements/);
    expect(() =>
      assertSameNameSubclassChoices(manifest(stricter, undefined)),
    ).not.toThrow();
    expect(() =>
      assertSameNameSubclassChoices(manifest(stricter, stricter)),
    ).not.toThrow();
  });
});
