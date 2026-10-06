import type { CatalogModel } from '../catalog/types.ts';
import { readOptions, readRecipeIds } from '../planner/query.ts';
import { decodeOptions, encodeOptions } from './encoding.ts';
import { recipesById } from './index.ts';
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
import { knownRecipes, recipesRequiring, withRequirements } from './resolve.ts';
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
 * chat assistant drive; the URL (`?r=...&o=...`) is its persisted form. Policy
 * rows live in memory here; smrt-planner#4 makes them real rows.
 */
class RecipeState {
  ids = $state<string[]>([]);
  rows = $state<FieldPolicyRow[]>([]);
  narrowed = $state<Record<string, ExposureSurface[]>>({});

  has(id: string): boolean {
    return this.ids.includes(id);
  }

  /** Added recipes that need `id`; non-empty means it cannot be removed. */
  requiredBy(id: string): string[] {
    return recipesRequiring(id, this.ids, recipesById);
  }

  /** Add recipes, pulling in everything they `require`. */
  add(...ids: string[]): void {
    this.ids = withRequirements([...this.ids, ...ids], recipesById);
  }

  /** Remove recipes; ones other added recipes need are kept. */
  remove(...ids: string[]): void {
    const removing = new Set(ids);
    const remaining = this.ids.filter((id) => !removing.has(id));
    this.ids = withRequirements(remaining, recipesById);
    this.prune();
  }

  toggle(id: string): void {
    if (this.has(id)) this.remove(id);
    else this.add(id);
  }

  clear(): void {
    this.ids = [];
    this.rows = [];
    this.narrowed = {};
  }

  /** Drop options for models no added recipe covers any more. */
  private prune(): void {
    const covered = new Set(
      this.ids.flatMap((id) => recipesById.get(id)?.models ?? []),
    );
    this.rows = this.rows.filter((r) => covered.has(r.objectRef));
    this.narrowed = Object.fromEntries(
      Object.entries(this.narrowed).filter(([ref]) => covered.has(ref)),
    );
  }

  /** The hints of the first added recipe that includes this model. */
  hintsFor(modelId: string): RecipeModelHints | undefined {
    for (const id of this.ids) {
      const hints = recipesById.get(id)?.options?.[modelId];
      if (hints) return hints;
    }
    return undefined;
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
    this.rows = [...this.rows.filter((r) => r.objectRef !== modelId), ...rows];
    const next = { ...this.narrowed };
    if (narrowed.length) next[modelId] = [...narrowed];
    else delete next[modelId];
    this.narrowed = next;
  }

  /** Forget the saved options for one model. */
  reset(modelId: string): void {
    this.save(modelId, [], []);
  }

  /** The `r` and `o` URL parameter values. */
  encoded(): { recipes: string[]; options: string } {
    return {
      recipes: this.ids,
      options: encodeOptions({ rows: this.rows, narrowed: this.narrowed }),
    };
  }

  /** Replace everything from a URL query string. */
  fromSearch(search: string): void {
    this.ids = withRequirements(
      knownRecipes(readRecipeIds(search), recipesById),
      recipesById,
    );
    const options = decodeOptions(readOptions(search));
    this.rows = options.rows;
    this.narrowed = options.narrowed;
    this.prune();
  }
}

export const recipeState = new RecipeState();
