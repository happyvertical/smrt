/**
 * #5143: a same-named subtype (`replaceParent: false`) is supported only in a
 * family that declares no tenancy. `@TenantScoped()` on the subtype, or on
 * its parent once the subtype is registered, is refused in either class
 * decorator order; a family without tenancy keeps its subtype.
 *
 * The decorators are applied as functions, in the order the class decorator
 * syntax would apply them (the decorator written nearest the class first).
 */
import { ObjectRegistry, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';

import { TenantScoped } from '../decorators.js';
import { unregisterTenantScopedClass } from '../registry.js';

const PARENT_PKG = '@fixture/t5143-tenancy-video';
const SUB_PKG = '@fixture/t5143-tenancy-histrio';
const PARENT = `${PARENT_PKG}:Reel`;
const SUB = `${SUB_PKG}:Reel`;
const CODE = 'CONFIG_SAME_NAME_TENANCY_UNSUPPORTED';

function family() {
  class VideoReel extends SmrtObject {}
  class HistrioReel extends VideoReel {}
  const parent = () =>
    smrt({
      name: 'Reel',
      packageName: PARENT_PKG,
      tableName: 't5143_tenancy_reels',
      tableStrategy: 'sti',
    })(VideoReel);
  const sub = () =>
    smrt({ name: 'Reel', packageName: SUB_PKG, replaceParent: false })(
      HistrioReel,
    );
  return { VideoReel, HistrioReel, parent, sub };
}

const refusal = (owner: string) =>
  expect.objectContaining({
    code: CODE,
    details: expect.objectContaining({ className: SUB, tenancyOwner: owner }),
  });

afterEach(() => {
  for (const name of ['VideoReel', 'HistrioReel'])
    unregisterTenantScopedClass(name);
  ObjectRegistry.clear();
});

describe('@TenantScoped() and a same-named subtype', () => {
  it('refuses @TenantScoped() written above @smrt() on the subtype', () => {
    const fixture = family();
    fixture.parent();
    fixture.sub();
    expect(() =>
      TenantScoped({ field: 'accountId' })(fixture.HistrioReel),
    ).toThrow(refusal(SUB));
    expect(ObjectRegistry.getTenantScopedConfig(SUB)).toBeUndefined();
  });

  it('refuses @TenantScoped() written below @smrt() on the subtype', () => {
    const fixture = family();
    fixture.parent();
    TenantScoped({ field: 'accountId' })(fixture.HistrioReel);
    expect(() => fixture.sub()).toThrow(refusal(SUB));
    expect(ObjectRegistry.getAllClasses().has(SUB)).toBe(false);
  });

  it('refuses @TenantScoped() on the parent once the subtype is registered', () => {
    const fixture = family();
    fixture.parent();
    fixture.sub();
    expect(() =>
      TenantScoped({ field: 'organizationId' })(fixture.VideoReel),
    ).toThrow(refusal(PARENT));
    expect(ObjectRegistry.getTenantScopedConfig(PARENT)).toBeUndefined();
  });

  it('refuses a subtype of a parent decorated with @TenantScoped()', () => {
    const fixture = family();
    fixture.parent();
    TenantScoped({ mode: 'optional', field: 'organizationId' })(
      fixture.VideoReel,
    );
    expect(() => fixture.sub()).toThrow(refusal(PARENT));
  });

  it('keeps the subtype of a family without tenancy', () => {
    const fixture = family();
    fixture.parent();
    fixture.sub();
    expect(ObjectRegistry.getAllClasses().has(SUB)).toBe(true);
    expect(ObjectRegistry.getTenantScopedConfig(SUB)).toBeUndefined();
  });
});
