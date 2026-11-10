import { getModelByQualifiedName } from '../catalog/index.ts';
import type { Cookbook } from '../cookbook/types.ts';
import { isSettingRow } from '../settings/app-settings.ts';
import { recipesById } from './index.ts';
import type { FieldPolicyRow } from './policy.ts';
import { recipesRequiring, withRequirements } from './resolve.ts';
import type { ExposureSurface, RecipeModelHints } from './types.ts';

/**
 * The recipe-owned part of a plan as plain data, and the rules that change
 * it, as pure functions (`data -> data`, never mutating). The browser's
 * `recipeState` (runes) and the headless planner both hold a `PlanData` and
 * call these, so a rule exists once.
 */
export interface PlanData {
  ids: string[];
  rows: FieldPolicyRow[];
  narrowed: Record<string, ExposureSurface[]>;
  /** Added feature models (qualified names): models no recipe covers. */
  features: string[];
  /**
   * Recipe and feature ids a loaded cookbook named that this version does not
   * know. Kept so the next save and export carry them; never applied.
   */
  unavailableRecipes: string[];
  unavailableFeatures: string[];
}

export const emptyPlanData = (): PlanData => ({
  ids: [],
  rows: [],
  narrowed: {},
  features: [],
  unavailableRecipes: [],
  unavailableFeatures: [],
});

/** Drop options for models no added recipe covers any more. */
export function prunePlan(data: PlanData): PlanData {
  // A feature model is covered too: a cookbook can set its options.
  const covered = new Set([
    ...data.ids.flatMap((id) => recipesById.get(id)?.models ?? []),
    ...data.features,
  ]);
  return {
    ...data,
    // App settings rows stay on models not covered yet (see isSettingRow).
    rows: data.rows.filter((r) => covered.has(r.objectRef) || isSettingRow(r)),
    narrowed: Object.fromEntries(
      Object.entries(data.narrowed).filter(([ref]) => covered.has(ref)),
    ),
  };
}

/** Add recipes, pulling in everything they `require`. */
export const withRecipesAdded = (
  data: PlanData,
  ids: readonly string[],
): PlanData => ({
  ...data,
  ids: withRequirements([...data.ids, ...ids], recipesById),
});

/** Remove recipes; ones other added recipes need are kept. */
export function withRecipesRemoved(
  data: PlanData,
  ids: readonly string[],
): PlanData {
  const removing = new Set(ids);
  const remaining = data.ids.filter((id) => !removing.has(id));
  return prunePlan({ ...data, ids: withRequirements(remaining, recipesById) });
}

export const withFeatureAdded = (data: PlanData, id: string): PlanData =>
  data.features.includes(id)
    ? data
    : { ...data, features: [...data.features, id].sort() };

export const withFeatureRemoved = (data: PlanData, id: string): PlanData =>
  prunePlan({ ...data, features: data.features.filter((f) => f !== id) });

/** Added recipes that need `id`; non-empty means it cannot be removed. */
export const recipesRequiringId = (data: PlanData, id: string): string[] =>
  recipesRequiring(id, data.ids, recipesById);

/** The hints of the first added recipe that includes this model. */
export function hintsForModel(
  data: Pick<PlanData, 'ids'>,
  modelId: string,
): RecipeModelHints | undefined {
  for (const id of data.ids) {
    const hints = recipesById.get(id)?.options?.[modelId];
    if (hints) return hints;
  }
  return undefined;
}

/** Replace the saved options for one model. */
export function withModelOptions(
  data: PlanData,
  modelId: string,
  rows: readonly FieldPolicyRow[],
  narrowed: readonly ExposureSurface[],
): PlanData {
  const next = { ...data.narrowed };
  if (narrowed.length) next[modelId] = [...narrowed];
  else delete next[modelId];
  return {
    ...data,
    rows: [...data.rows.filter((r) => r.objectRef !== modelId), ...rows],
    narrowed: next,
  };
}

/** The recipes and options as cookbook fields, in a stable order. */
export function planFields(
  data: PlanData,
): Pick<Cookbook, 'recipes' | 'features' | 'policies' | 'exposure'> {
  const policies = [...data.rows].sort(
    (a, b) =>
      a.objectRef.localeCompare(b.objectRef) ||
      a.fieldName.localeCompare(b.fieldName),
  );
  const exposure = Object.fromEntries(
    Object.keys(data.narrowed)
      .sort()
      .filter((ref) => data.narrowed[ref].length)
      .map((ref) => [ref, [...data.narrowed[ref]].sort()]),
  );
  const out: Pick<Cookbook, 'recipes' | 'features' | 'policies' | 'exposure'> =
    {
      recipes: [...data.ids, ...data.unavailableRecipes].sort(),
      features: [...data.features, ...data.unavailableFeatures].sort(),
      policies: policies.map((row) => ({ ...row })),
    };
  if (Object.keys(exposure).length) out.exposure = exposure;
  return out;
}

/** The plan a validated cookbook describes. */
export function planFromCookbook(
  cookbook: Pick<Cookbook, 'recipes' | 'features' | 'policies' | 'exposure'>,
): PlanData {
  const features = [...new Set(cookbook.features)];
  const known = (name: string) =>
    Boolean(getModelByQualifiedName(name)?.model.exposed);
  return prunePlan({
    ids: withRequirements(cookbook.recipes, recipesById),
    rows: cookbook.policies.map((row) => ({ ...row })),
    narrowed: Object.fromEntries(
      Object.entries(cookbook.exposure ?? {}).map(([ref, s]) => [ref, [...s]]),
    ),
    features: features.filter(known).sort(),
    unavailableRecipes: [
      ...new Set(cookbook.recipes.filter((id) => !recipesById.has(id))),
    ].sort(),
    unavailableFeatures: features.filter((f) => !known(f)).sort(),
  });
}
