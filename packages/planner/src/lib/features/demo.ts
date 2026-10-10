import type {
  PackageBrowserCapability,
  Recipe,
  RecipeDemo,
  RecipeDemoMode,
} from '../recipes/types.ts';

/**
 * How the Features catalogue labels a feature by how far it runs in this
 * browser-only demo (smrt#3709). The mode and its reasons come from the
 * manifest as emitted; nothing here decides, softens or upgrades one. What a
 * feature requires is already folded in by the catalog generator (smrt-core's
 * `effectiveRecipeDemo`, stored as the recipe's `effectiveDemo`).
 */

export const DEMO_MODE_LABEL: Readonly<Record<RecipeDemoMode, string>> = {
  live: 'Live',
  mock: 'Mock',
  sample: 'Sample',
  server: 'Server',
};

/** What each mode means for a visitor, in one line. */
export const DEMO_MODE_MEANING: Readonly<Record<RecipeDemoMode, string>> = {
  live: 'Runs for real in your browser.',
  mock: 'Runs in your browser, but a provider is faked.',
  sample: 'Shows sample data only; it cannot reach what it needs.',
  server: 'Needs a server, which this browser-only demo does not have.',
};

/** Badge variant (smrt-ui) per mode; the word always accompanies the colour. */
export const DEMO_MODE_VARIANT: Readonly<
  Record<RecipeDemoMode, 'success' | 'info' | 'warning' | 'default'>
> = {
  live: 'success',
  mock: 'info',
  sample: 'warning',
  server: 'default',
};

export interface DemoBadge {
  mode: RecipeDemoMode;
  label: string;
  meaning: string;
  variant: 'success' | 'info' | 'warning' | 'default';
  /** Plain sentences from the manifest saying why, plus what folds in. */
  reasons: string[];
  /** Ids of providers a demo fakes. */
  mocked: string[];
}

/**
 * The recipe's demo mode including what it requires: the generator's
 * `effectiveDemo` when that differs from the recipe's own, else its `demo`.
 * Undefined when the manifest reports no `demo` for it.
 */
export function effectiveDemo(
  recipe: Pick<Recipe, 'demo' | 'effectiveDemo'>,
): RecipeDemo | undefined {
  return recipe.effectiveDemo ?? recipe.demo;
}

/** The label data for a demo, or undefined when the manifest gave none. */
export function demoBadge(demo: RecipeDemo | undefined): DemoBadge | undefined {
  if (!demo) return undefined;
  return {
    mode: demo.mode,
    label: DEMO_MODE_LABEL[demo.mode],
    meaning: DEMO_MODE_MEANING[demo.mode],
    variant: DEMO_MODE_VARIANT[demo.mode],
    reasons: demo.reasons,
    mocked: demo.mocked ?? [],
  };
}

/**
 * The package's own browser capability in a sentence, shown on expand as
 * context for the label. Undefined when the manifest reports none.
 */
export function browserNote(
  capability: PackageBrowserCapability | undefined,
): string | undefined {
  if (!capability) return undefined;
  if (capability.status === 'browser-safe') {
    return 'Its package builds for a browser.';
  }
  const parts = ['Its package does not build for a browser yet'];
  if (capability.reason) parts.push(`(${capability.reason})`);
  if (capability.issues?.length) {
    parts.push(`and is tracked in ${capability.issues.join(', ')}`);
  }
  return `${parts.join(' ')}.`;
}
