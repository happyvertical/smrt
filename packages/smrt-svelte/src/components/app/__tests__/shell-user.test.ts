import type { User } from '@happyvertical/smrt-types';
import type { ComponentProps } from 'svelte';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type AppShell from '../AppShell.svelte';
import type { ShellUser } from '../index.js';

/** Mirror of `SessionLayoutUser` from `@happyvertical/smrt-app-runtime/sveltekit`. */
interface SessionLayoutUser {
  readonly id: string;
  readonly email: string;
  readonly name?: string;
}

type ShellUserProp = ComponentProps<typeof AppShell>['user'];

describe('AppShell user prop type', () => {
  it('accepts the session projection and a full User without a cast', () => {
    expectTypeOf<SessionLayoutUser>().toExtend<NonNullable<ShellUserProp>>();
    expectTypeOf<SessionLayoutUser | null>().toExtend<ShellUserProp>();
    expectTypeOf<User>().toExtend<NonNullable<ShellUserProp>>();
    expectTypeOf<User | null>().toExtend<ShellUserProp>();
    expectTypeOf<{ id: string; avatarUrl: string }>().toExtend<
      NonNullable<ShellUser>
    >();
    // Not just anything: an object without an id is rejected.
    expectTypeOf<{ email: string }>().not.toExtend<NonNullable<ShellUser>>();
    expect(true).toBe(true);
  });
});

type SignOutProp = ComponentProps<typeof AppShell>['onSignOut'];

describe('AppShell onSignOut prop type', () => {
  it('accepts every callback a `() => void` prop accepted, plus async ones', () => {
    const cache = new Map<string, number>();
    // Review finding on #3860: a value-returning sync callback compiled
    // against `() => void` and must keep compiling.
    expectTypeOf(() => cache.delete('session')).toExtend<
      NonNullable<SignOutProp>
    >();
    expectTypeOf(() => {}).toExtend<NonNullable<SignOutProp>>();
    expectTypeOf(async () => {}).toExtend<NonNullable<SignOutProp>>();
    expectTypeOf(() => Promise.resolve(true)).toExtend<
      NonNullable<SignOutProp>
    >();
    expect(true).toBe(true);
  });
});
