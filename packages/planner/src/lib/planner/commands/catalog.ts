import type {
  EngineCatalog,
  EngineModel,
} from '@happyvertical/smrt-core/cookbook/engine';
import { catalog } from '../../catalog/index.ts';
import { libraryCookbooks } from '../../library/index.ts';
import { recipes } from '../../recipes/index.ts';
import { SETTING_TARGETS } from '../../settings/app-settings.ts';
import { CURRENCY_CODES } from '../../settings/currencies.ts';
import { THEME_PRESETS } from '../../theme/theme.ts';

/**
 * The planner's own data as the engine's catalog: the recipes (the published
 * packages' plus the planner-local `forms`), every catalog model, the library
 * cookbooks, the smrt-ui presets and the currencies. The engine bundles none of
 * it; a host with a different catalog builds its own `EngineCatalog`.
 */
export function buildEngineCatalog(): EngineCatalog {
  const models: EngineModel[] = catalog.packages.flatMap((pkg) =>
    pkg.models.map((model) => ({
      id: model.id,
      name: model.name,
      packageId: pkg.id,
      ...(model.description ? { description: model.description } : {}),
      exposed: model.exposed,
      fields: model.fields.map((field) => ({
        name: field.name,
        ...(field.system ? { system: true } : {}),
        ...(field.default !== undefined ? { default: field.default } : {}),
      })),
    })),
  );
  return {
    recipes,
    models,
    cookbooks: libraryCookbooks.map((cookbook) => ({
      id: cookbook.id,
      name: cookbook.name,
      document: cookbook.document as never,
    })),
    themePresets: THEME_PRESETS,
    currencies: [...CURRENCY_CODES],
    settingTargets: SETTING_TARGETS,
  };
}

let cached: EngineCatalog | undefined;

/** The planner's engine catalog, built once. */
export function engineCatalog(): EngineCatalog {
  cached ??= buildEngineCatalog();
  return cached;
}

/** The catalog narrowed to the given recipe and library cookbook ids. */
export function restrictCatalog(
  base: EngineCatalog,
  allowed: {
    recipes: readonly { id: string }[];
    cookbooks: readonly { id: string }[];
  },
): EngineCatalog {
  const recipeIds = new Set(allowed.recipes.map((r) => r.id));
  const cookbookIds = new Set(allowed.cookbooks.map((c) => c.id));
  return {
    ...base,
    recipes: base.recipes.filter((r) => recipeIds.has(r.id)),
    cookbooks: (base.cookbooks ?? []).filter((c) => cookbookIds.has(c.id)),
  };
}
