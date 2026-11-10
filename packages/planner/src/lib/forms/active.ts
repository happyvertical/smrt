import type {
  FieldMapForm,
  Recipe,
  RecipeForm,
  RecipeFormExtension,
  VariantGridForm,
} from '../recipes/types.ts';

/** A form of an added recipe, with the extensions of the other added recipes. */
export interface ActiveForm<F extends RecipeForm = RecipeForm> {
  recipeId: string;
  form: F;
  extensions: RecipeFormExtension[];
}

export function isFieldMap(
  active: ActiveForm,
): active is ActiveForm<FieldMapForm> {
  return active.form.kind === 'field-map';
}

export function isVariantGrid(
  active: ActiveForm,
): active is ActiveForm<VariantGridForm> {
  return active.form.kind === 'variant-grid';
}

/**
 * The forms offered for a model by the recipes in `ids`, in the order the
 * recipes are declared, each with the `extends` of every added recipe.
 */
export function activeForms(
  ids: readonly string[],
  recipes: readonly Recipe[],
  modelId: string,
): ActiveForm[] {
  const added = recipes.filter((recipe) => ids.includes(recipe.id));
  return added.flatMap((recipe) =>
    (recipe.forms ?? [])
      .filter((form) => form.model === modelId)
      .map((form) => ({
        recipeId: recipe.id,
        form,
        extensions: added.flatMap((other) =>
          (other.extends ?? []).filter((ext) => ext.form === form.id),
        ),
      })),
  );
}

/** Does any extension of the form bring in a row of this model? */
export function extendsWith(active: ActiveForm, modelId: string): boolean {
  return active.extensions.some((ext) =>
    (ext.records ?? []).some((record) => record.model === modelId),
  );
}
