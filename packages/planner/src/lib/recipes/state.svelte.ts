import type { CatalogModel } from '../catalog/types.ts';
import type { Cookbook } from '../cookbook/types.ts';
import {
  emptyPlanData,
  hintsForModel,
  type PlanData,
  planFields,
  planFromCookbook,
  recipesRequiringId,
  withFeatureAdded,
  withFeatureRemoved,
  withModelOptions,
  withRecipesAdded,
  withRecipesRemoved,
} from './plan-data.ts';
import {
  backgroundDefaults,
  type FieldPolicyRow,
  narrowModel,
  type ResolvedField,
  resolveExposure,
  resolveFields,
  type ViewField,
  viewFields,
} from './policy.ts';
import type { ExposureSurface, RecipeModelHints } from './types.ts';

/** A model as the generated views see it once recipe options are applied. */
export interface AppliedModel {
  /** The model with narrowed surfaces emptied. */
  model: CatalogModel;
  /** Every field's merged policy, in order. */
  resolved: ResolvedField[];
  /** What lists and forms show. */
  fields: ViewField[];
  /** Defaults for fields that are not shown, so records still carry them. */
  background: Record<string, unknown>;
}

/**
 * The visitor's added recipes and their saved options. Like the package
 * selection, it is the one store the planner page, navigation and a future
 * chat assistant drive. The cookbook (`cookbook/`) is its persisted form:
 * `snapshot()` and `load()` are the only way in or out. Policy rows live in
 * memory here; smrt-planner#4 makes them real rows.
 */
class RecipeState {
  ids = $state<string[]>([]);
  rows = $state<FieldPolicyRow[]>([]);
  narrowed = $state<Record<string, ExposureSurface[]>>({});
  /** Added feature models (qualified names): models no recipe covers. */
  features = $state<string[]>([]);
  /**
   * Recipe and feature ids a loaded cookbook named that this version does not
   * know. Kept so the next save and export carry them; never applied.
   */
  unavailableRecipes = $state<string[]>([]);
  unavailableFeatures = $state<string[]>([]);

  /** The rules live in `plan-data.ts`; this holds their data in runes. */
  get data(): PlanData {
    return {
      ids: this.ids,
      rows: this.rows,
      narrowed: this.narrowed,
      features: this.features,
      unavailableRecipes: this.unavailableRecipes,
      unavailableFeatures: this.unavailableFeatures,
    };
  }

  private set(next: PlanData): void {
    this.ids = next.ids;
    this.rows = next.rows;
    this.narrowed = next.narrowed;
    this.features = next.features;
    this.unavailableRecipes = next.unavailableRecipes;
    this.unavailableFeatures = next.unavailableFeatures;
  }

  /** Forget the ids this version does not know (the visitor's explicit say). */
  removeUnavailable(): void {
    this.unavailableRecipes = [];
    this.unavailableFeatures = [];
  }

  hasFeature(id: string): boolean {
    return this.features.includes(id);
  }

  addFeature(id: string): void {
    this.set(withFeatureAdded(this.data, id));
  }

  removeFeature(id: string): void {
    this.set(withFeatureRemoved(this.data, id));
  }

  has(id: string): boolean {
    return this.ids.includes(id);
  }

  /** Added recipes that need `id`; non-empty means it cannot be removed. */
  requiredBy(id: string): string[] {
    return recipesRequiringId(this.data, id);
  }

  /** Add recipes, pulling in everything they `require`. */
  add(...ids: string[]): void {
    this.set(withRecipesAdded(this.data, ids));
  }

  /** Remove recipes; ones other added recipes need are kept. */
  remove(...ids: string[]): void {
    this.set(withRecipesRemoved(this.data, ids));
  }

  toggle(id: string): void {
    if (this.has(id)) this.remove(id);
    else this.add(id);
  }

  clear(): void {
    this.set(emptyPlanData());
  }

  /** The hints of the first added recipe that includes this model. */
  hintsFor(modelId: string): RecipeModelHints | undefined {
    return hintsForModel(this, modelId);
  }

  /** Apply the added recipes' hints and the saved rows to a catalog model. */
  apply(model: CatalogModel): AppliedModel {
    const hints = this.hintsFor(model.id);
    const resolved = resolveFields(model, hints, this.rows);
    const exposure = resolveExposure(
      model,
      hints,
      this.narrowed[model.id] ?? [],
    );
    return {
      model: narrowModel(model, exposure),
      resolved,
      fields: viewFields(resolved),
      background: backgroundDefaults(resolved),
    };
  }

  /** Replace the saved options for one model. */
  save(
    modelId: string,
    rows: readonly FieldPolicyRow[],
    narrowed: readonly ExposureSurface[],
  ): void {
    this.set(withModelOptions(this.data, modelId, rows, narrowed));
  }

  /** Forget the saved options for one model. */
  reset(modelId: string): void {
    this.save(modelId, [], []);
  }

  /** The recipes and options as cookbook fields, in a stable order. */
  snapshot(): Pick<Cookbook, 'recipes' | 'features' | 'policies' | 'exposure'> {
    return planFields(this.data);
  }

  /** Replace everything from a validated cookbook. */
  load(
    cookbook: Pick<Cookbook, 'recipes' | 'features' | 'policies' | 'exposure'>,
  ): void {
    this.set(planFromCookbook(cookbook));
  }
}

export const recipeState = new RecipeState();
