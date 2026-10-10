/**
 * Browser-demo classification of a recipe (#3709): the pure, browser-safe
 * rules that turn what a recipe declares (`runtime`, `providers`, `demoSeed`)
 * and what the bundle-gate measured for its package into one of four modes.
 *
 * - `live`: the real browser data layer (PGlite), nothing faked.
 * - `mock`: runs in the browser, but a provider (sending mail, OAuth) is faked.
 * - `sample`: runs in the browser on fixture data (`demoSeed`) only.
 * - `server`: needs a server; a browser-only host cannot offer it.
 *
 * The classification is **derived**, never authored: the build calls
 * {@link deriveRecipeDemo} and emits `demo` on the recipe entry. A host that
 * wants the answer for a recipe together with the recipes it needs calls
 * {@link effectiveRecipeDemo}.
 *
 * Rules, in the order they fire (the worst mode wins; `live` < `mock` <
 * `sample` < `server`):
 *
 * 1. `runtime: 'server'` is `server`. `runtime: 'both'` (or omitted) makes no
 *    claim, so the package capability refines it.
 * 2. A package the bundle-gate reports `server-only` is `server`.
 * 3. A *server provider* is one that lists `secrets`: it holds credentials a
 *    browser cannot. One with a `browserOptions` entry is satisfied in a
 *    browser (an in-browser model), so it changes nothing. Otherwise it is
 *    *mockable* when `options` includes `mock`. A required server provider
 *    that is neither is `sample` when the recipe ships a `demoSeed` (the
 *    fixtures stand in for what the provider would feed), otherwise `server`.
 * 4. Any other mockable server provider makes the recipe `mock`.
 * 5. Otherwise `live`.
 *
 * Contradictions fail the build: `runtime: 'browser'` on a `server-only`
 * package, or beside a required server provider with no browser option and no
 * mock.
 *
 * @packageDocumentation
 */

import type {
  PackageBrowserCapability,
  RecipeDefinition,
  RecipeDemo,
  RecipeDemoMode,
  RecipeProvider,
} from '@happyvertical/smrt-types';

export type {
  PackageBrowserCapability,
  RecipeDemo,
  RecipeDemoMode,
} from '@happyvertical/smrt-types';

/** Modes from best to worst for a demo; used to pick the worst of several. */
export const RECIPE_DEMO_MODES: readonly RecipeDemoMode[] = [
  'live',
  'mock',
  'sample',
  'server',
];

/** The provider option that names a fake a demo can use instead of the real one. */
export const MOCK_PROVIDER_OPTION = 'mock';

const rank = (mode: RecipeDemoMode): number => RECIPE_DEMO_MODES.indexOf(mode);

/** True when the provider holds credentials a browser cannot (`secrets` listed). */
export function isServerProvider(provider: RecipeProvider): boolean {
  return (provider.secrets?.length ?? 0) > 0;
}

/** True when one of the provider's options runs in a browser (`browserOptions`). */
export function hasBrowserOption(provider: RecipeProvider): boolean {
  return (provider.browserOptions?.length ?? 0) > 0;
}

/** True when a demo can fake the provider (`options` includes `mock`). */
export function isMockableProvider(provider: RecipeProvider): boolean {
  return provider.options.includes(MOCK_PROVIDER_OPTION);
}

/** What {@link deriveRecipeDemo} found: the classification and any contradictions. */
export interface RecipeDemoDerivation {
  /** Omitted when nothing is known about the package and the recipe declares nothing relevant. */
  demo?: RecipeDemo;
  /** One sentence per contradictory declaration; the build fails on any. */
  problems: string[];
}

function describePackage(capability: PackageBrowserCapability): string {
  const issues = capability.issues?.length
    ? ` (${capability.issues.join(', ')})`
    : '';
  const own = capability.reason
    ? `its package does not build for a browser: ${capability.reason}`
    : undefined;
  const inherited = capability.via?.length
    ? `its package depends on ${capability.via.join(', ')}, which do not build for a browser`
    : undefined;
  return `${[own, inherited].filter(Boolean).join('; and ') || 'its package does not build for a browser'}${issues}`;
}

/**
 * Classify one recipe. `capability` is the bundle-gate result for the recipe's
 * package, or `undefined` when the package is not measured (a consumer app's
 * own recipes); then only the recipe's own declarations decide.
 */
export function deriveRecipeDemo(
  recipe: Pick<RecipeDefinition, 'id' | 'runtime' | 'providers' | 'demoSeed'>,
  capability?: PackageBrowserCapability,
): RecipeDemoDerivation {
  const problems: string[] = [];
  const reasons: string[] = [];
  let mode: RecipeDemoMode = 'live';
  const raise = (next: RecipeDemoMode) => {
    if (rank(next) > rank(mode)) mode = next;
  };

  const providers = recipe.providers ?? [];
  // A provider with an in-browser option is satisfied there: it needs no faking.
  const serverProviders = providers.filter(
    (provider) => isServerProvider(provider) && !hasBrowserOption(provider),
  );
  const inBrowser = providers.filter(
    (provider) => isServerProvider(provider) && hasBrowserOption(provider),
  );
  const mockable = serverProviders.filter(isMockableProvider);
  const blocking = serverProviders.filter(
    (provider) => provider.required && !isMockableProvider(provider),
  );
  const optionalUnavailable = serverProviders.filter(
    (provider) => !provider.required && !isMockableProvider(provider),
  );
  const packageServerOnly = capability?.status === 'server-only';

  if (recipe.runtime === 'browser') {
    if (capability && packageServerOnly) {
      problems.push(
        `recipe ${recipe.id}: runtime is "browser" but ${describePackage(capability)}; declare "both" or fix the package`,
      );
    }
    for (const provider of blocking) {
      problems.push(
        `recipe ${recipe.id}: runtime is "browser" but provider "${provider.id}" is required and holds secrets (${provider.secrets?.join(', ')}) a browser cannot keep; give it a browserOptions entry or a "${MOCK_PROVIDER_OPTION}" option, make it optional, or declare "both" or "server"`,
      );
    }
  }

  if (recipe.runtime === 'server') {
    raise('server');
    reasons.push('The recipe declares runtime "server".');
  }
  if (capability && packageServerOnly) {
    raise('server');
    reasons.push(`Needs a server because ${describePackage(capability)}.`);
  }
  if (blocking.length > 0) {
    const names = blocking.map((provider) => provider.id).join(', ');
    if (recipe.demoSeed) {
      raise('sample');
      reasons.push(
        `Required provider ${names} holds secrets a browser cannot keep and has no in-browser or "${MOCK_PROVIDER_OPTION}" option; the demo seed stands in for its data.`,
      );
    } else {
      raise('server');
      reasons.push(
        `Required provider ${names} holds secrets a browser cannot keep and has no in-browser or "${MOCK_PROVIDER_OPTION}" option and the recipe has no demo seed.`,
      );
    }
  }
  if (mockable.length > 0) {
    raise('mock');
    reasons.push(
      `Provider ${mockable.map((provider) => provider.id).join(', ')} is faked in a demo.`,
    );
  }
  if (inBrowser.length > 0) {
    reasons.push(
      `Provider ${inBrowser.map((provider) => provider.id).join(', ')} has an in-browser option (${inBrowser
        .flatMap((provider) => provider.browserOptions ?? [])
        .join(', ')}).`,
    );
  }
  if (optionalUnavailable.length > 0) {
    reasons.push(
      `Optional provider ${optionalUnavailable.map((provider) => provider.id).join(', ')} is unavailable in a browser.`,
    );
  }

  const declares =
    recipe.runtime !== undefined ||
    providers.length > 0 ||
    recipe.demoSeed !== undefined;
  if (!capability && !declares) return { problems };
  if (!capability) {
    reasons.push('The package browser capability is not measured.');
  }
  if (mode === 'live' && capability && reasons.length === 0) {
    reasons.push('The package builds for a browser and nothing needs faking.');
  }

  const demo: RecipeDemo = {
    mode,
    reasons,
    ...(mockable.length > 0
      ? { mocked: mockable.map((provider) => provider.id) }
      : {}),
  };
  return { demo, problems };
}

/**
 * The mode a host should show for `recipeId`: the worst of its own `demo` and
 * that of every recipe it needs. Each `requiresAny` list counts its best known
 * alternative. Ids that are unknown, or whose recipe has no `demo`, are
 * ignored, so a partial catalog degrades to the recipe's own answer. Returns
 * `undefined` when the recipe is unknown or has no `demo` of its own.
 */
export function effectiveRecipeDemo(
  recipeId: string,
  recipes: readonly Pick<
    RecipeDefinition,
    'id' | 'requires' | 'requiresAny' | 'demo'
  >[],
): RecipeDemo | undefined {
  const byId = new Map(recipes.map((recipe) => [recipe.id, recipe]));

  const resolve = (
    id: string,
    trail: readonly string[],
  ): RecipeDemo | undefined => {
    const recipe = byId.get(id);
    if (!recipe?.demo || trail.includes(id)) return recipe?.demo;
    let mode = recipe.demo.mode;
    const reasons = [...recipe.demo.reasons];
    const consider = (needed: string, via: RecipeDemo) => {
      if (rank(via.mode) > rank(mode)) mode = via.mode;
      if (via.mode !== 'live') {
        reasons.push(`Needs ${needed}, which is ${via.mode}.`);
      }
    };
    for (const needed of recipe.requires) {
      const demo = resolve(needed, [...trail, id]);
      if (demo) consider(needed, demo);
    }
    for (const alternatives of recipe.requiresAny ?? []) {
      const known = alternatives
        .map((needed) => ({ needed, demo: resolve(needed, [...trail, id]) }))
        .filter(
          (entry): entry is { needed: string; demo: RecipeDemo } =>
            entry.demo !== undefined,
        );
      if (known.length === 0) continue;
      const best = known.reduce((a, b) =>
        rank(b.demo.mode) < rank(a.demo.mode) ? b : a,
      );
      consider(best.needed, best.demo);
    }
    return {
      mode,
      reasons,
      ...(recipe.demo.mocked ? { mocked: recipe.demo.mocked } : {}),
    };
  };

  return resolve(recipeId, []);
}
