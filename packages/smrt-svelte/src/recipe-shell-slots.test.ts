import type { RecipeShellSlot } from '@happyvertical/smrt-types';
import { describe, expect, it } from 'vitest';
import type { ShellSlot } from './components/workspace/admin-shell/slots.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// Fails typecheck when the recipe slot union and the shell union diverge.
const same: Equal<RecipeShellSlot, ShellSlot> = true;

describe('recipe surface slots (#3708)', () => {
  it('RecipeShellSlot in smrt-types equals the shell ShellSlot', () => {
    expect(same).toBe(true);
  });
});
