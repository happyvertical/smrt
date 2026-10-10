/**
 * Type-level gate for the cookbook contract (#3748, #3749). This is a plain
 * `.ts` file, not a `*.test.ts`, on purpose: `tsc` and `svelte-check` exclude
 * test files, so assertions in one never fail a typecheck. Here a mismatch is
 * a compile error.
 *
 * The structural copies in smrt-types must stay identical to smrt-svelte's
 * real types, so a field added on either side is caught instead of being
 * silently dropped or rejected at the boundary.
 */
import type {
  CookbookLayout,
  CookbookOverviewOverride,
  RecipeShellSlot,
} from '@happyvertical/smrt-types';
import type { OverviewOverride } from '../../overview/types.js';
import type { ShellLayout } from '../../workspace/admin-shell/layout.js';
import type { ShellSlot } from '../../workspace/admin-shell/slots.js';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;

// A mismatch makes the literal `true` unassignable.
export const layoutIdentical: Equal<CookbookLayout, ShellLayout> = true;
export const overrideIdentical: Equal<
  CookbookOverviewOverride,
  OverviewOverride
> = true;
export const slotsIdentical: Equal<RecipeShellSlot, ShellSlot> = true;

// Assignability each way, spelled out so a failure names the direction.
export const layoutToContract = (layout: ShellLayout): CookbookLayout => layout;
export const layoutFromContract = (layout: CookbookLayout): ShellLayout =>
  layout;
export const overrideToContract = (
  override: OverviewOverride,
): CookbookOverviewOverride => override;
export const overrideFromContract = (
  override: CookbookOverviewOverride,
): OverviewOverride => override;
