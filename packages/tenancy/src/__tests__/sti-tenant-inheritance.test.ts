/**
 * Regression tests for STI-aware tenant-scope recognition (#1596).
 *
 * `@TenantScoped` registers ONLY the exact class name it decorates — it does
 * NOT propagate to STI subclasses. When an STI child has its own collection
 * (the child is the collection's `_itemClass`) and does not re-declare
 * `@TenantScoped`, the interceptor used to treat it as non-tenant-scoped:
 * `list()`/`get()` skipped the tenant filter (cross-tenant reads), `beforeSave`
 * skipped tenant population, and raw `query()` skipped the policy. That manual
 * re-declaration was the fragile pattern that bit images (#1407) and messages.
 *
 * The fix makes `isTenantScopedClass` / `getTenantScopedConfig` walk the STI
 * inheritance chain so any descendant of a tenant-scoped base is recognized
 * automatically, inheriting the base's mode/config — unless the child declares
 * its own `@TenantScoped`, which still wins.
 *
 * These tests register inline `@smrt` classes (runtime registration sets the
 * `extends` metadata `getInheritanceChain` relies on) and assert recognition
 * resolves through inheritance. Real registry, no mocking — the same pattern as
 * `packages/core/src/__tests__/sti-registry.test.ts`.
 */

import { ObjectRegistry, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TenantScoped } from '../decorators';
import {
  getTenantScopedConfig,
  isTenantScopedClass,
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry';

// ---------------------------------------------------------------------------
// Inline fixture hierarchy (unique #1596-namespaced names to avoid colliding
// with manifest-loaded classes). Defining the classes registers them in
// ObjectRegistry with their `extends` chain; the `@TenantScoped` decorator
// registers the base in the tenancy registry by simple name.
// ---------------------------------------------------------------------------

@TenantScoped({ mode: 'optional' })
@smrt({ tableStrategy: 'sti' })
class Sti1596Base extends SmrtObject {
  tenantId: string | null = null;
  title: string = '';
}

// STI child of a @TenantScoped base, WITHOUT re-declaring @TenantScoped.
@smrt()
class Sti1596Child extends Sti1596Base {
  extra: string = '';
}

// Grandchild — inheritance must resolve through multiple levels.
@smrt()
class Sti1596Grandchild extends Sti1596Child {
  more: string = '';
}

// Child that re-declares its own @TenantScoped with a DIFFERENT mode — the
// explicit declaration must win over the inherited base config.
@TenantScoped({ mode: 'required' })
@smrt()
class Sti1596ChildOwn extends Sti1596Base {
  own: string = '';
}

// A plain hierarchy with no tenant-scoped ancestor — must NOT be recognized.
@smrt()
class Plain1596Base extends SmrtObject {
  name: string = '';
}

@smrt()
class Plain1596Child extends Plain1596Base {
  other: string = '';
}

describe('STI tenant-scope inheritance (#1596)', () => {
  beforeEach(() => {
    // Re-assert the local-registry registrations in case a prior test file in
    // the same (single-fork) process cleared the tenancy registry. The inline
    // classes' ObjectRegistry inheritance chains persist for the process, but
    // the tenancy Map can be reset between files.
    registerTenantScopedClass('Sti1596Base', { mode: 'optional' });
    registerTenantScopedClass('Sti1596ChildOwn', { mode: 'required' });
  });

  afterEach(() => {
    unregisterTenantScopedClass('Sti1596Base');
    unregisterTenantScopedClass('Sti1596ChildOwn');
    unregisterTenantScopedClass('Payout1598');
  });

  it('recognizes the directly-decorated base (sanity)', () => {
    expect(isTenantScopedClass('Sti1596Base')).toBe(true);
    expect(getTenantScopedConfig('Sti1596Base')?.mode).toBe('optional');
  });

  it('recognizes an STI child of a @TenantScoped base WITHOUT re-declaring', () => {
    expect(isTenantScopedClass('Sti1596Child')).toBe(true);
    // Inherits the base's mode/config.
    expect(getTenantScopedConfig('Sti1596Child')?.mode).toBe('optional');
    expect(getTenantScopedConfig('Sti1596Child')?.field).toBe('tenantId');
  });

  it('recognizes a deeper STI descendant through multiple levels', () => {
    expect(isTenantScopedClass('Sti1596Grandchild')).toBe(true);
    expect(getTenantScopedConfig('Sti1596Grandchild')?.mode).toBe('optional');
  });

  it("a child's own @TenantScoped overrides the inherited base config", () => {
    // Base is 'optional'; the child re-declares 'required' — explicit wins.
    expect(isTenantScopedClass('Sti1596ChildOwn')).toBe(true);
    expect(getTenantScopedConfig('Sti1596ChildOwn')?.mode).toBe('required');
  });

  it('does NOT recognize a class whose ancestors are not tenant-scoped', () => {
    expect(isTenantScopedClass('Plain1596Base')).toBe(false);
    expect(isTenantScopedClass('Plain1596Child')).toBe(false);
    expect(getTenantScopedConfig('Plain1596Child')).toBeUndefined();
  });

  it('does NOT recognize an unregistered class with no inheritance data', () => {
    expect(isTenantScopedClass('CompletelyUnknown1596')).toBe(false);
    expect(getTenantScopedConfig('CompletelyUnknown1596')).toBeUndefined();
  });

  it('returns a copy so a caller mutation cannot corrupt the stored registration (#1598 review)', () => {
    // The base and every inheriting descendant share one backing config object.
    // Lookups must hand out copies — mutating a returned config must not leak
    // back into the base (direct) or any child (inherited) lookup.
    const child = getTenantScopedConfig('Sti1596Child');
    expect(child?.mode).toBe('optional');
    (child as { mode: string }).mode = 'required'; // simulate an accidental mutation

    expect(getTenantScopedConfig('Sti1596Base')?.mode).toBe('optional');
    expect(getTenantScopedConfig('Sti1596Child')?.mode).toBe('optional');

    const base = getTenantScopedConfig('Sti1596Base');
    (base as { mode: string }).mode = 'required';
    expect(getTenantScopedConfig('Sti1596Base')?.mode).toBe('optional');
  });

  it('does NOT strip a qualified lookup to a same-simple-name class in another package (#1598 review, codex P2)', () => {
    // Simulate `@TenantScoped` on one package's `Payout1598` (registered by
    // simple name, as the decorator does). A *direct* qualified lookup for a
    // DIFFERENT package's same-named class must NOT cross-match the simple key.
    registerTenantScopedClass('Payout1598', { mode: 'optional' });

    expect(isTenantScopedClass('Payout1598')).toBe(true); // exact simple match is fine
    expect(
      isTenantScopedClass('@happyvertical/smrt-affiliates:Payout1598'),
    ).toBe(false);
    expect(
      getTenantScopedConfig('@happyvertical/smrt-affiliates:Payout1598'),
    ).toBeUndefined();
  });
});

describe('ObjectRegistry STI fixtures sanity (#1596)', () => {
  it('built the inheritance chain used by the recognition walk', () => {
    // The recognition walk depends on getInheritanceChain returning ancestors.
    const chain = ObjectRegistry.getInheritanceChain('Sti1596Child');
    // Chain is [root, ..., self]; the base must appear as an ancestor.
    const simple = chain.map((n) => n.split(':').pop());
    expect(simple).toContain('Sti1596Base');
    expect(simple[simple.length - 1]).toBe('Sti1596Child');
  });
});
