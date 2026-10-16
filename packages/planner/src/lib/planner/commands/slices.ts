import type {
  RecipeStore,
  SettingsStore,
  ThemeStore,
} from '../../assistant/change.ts';
import { COOKBOOK_SCHEMA, type Cookbook } from '../../cookbook/types.ts';
import { readSettings, writeSettings } from '../../settings/app-settings.ts';
import {
  createPlannerAdapter,
  type PlannerController,
  type PlannerControllerOptions,
  type PlannerPort,
} from './adapter.ts';
import { engineCatalog } from './catalog.ts';

const empty = (): Cookbook => ({
  $schema: COOKBOOK_SCHEMA,
  version: 1,
  recipes: [],
  features: [],
  policies: [],
});

/**
 * Just the slices of the app the assistant works with (recipes, settings and
 * theme) as the engine's document, for hosts that have no more than that and for
 * tests. A command changes the slices through their own `add`/`remove`/`write`.
 */
export function portFromSlices(slices: {
  store: RecipeStore;
  settings?: SettingsStore;
  theme?: ThemeStore;
}): PlannerPort {
  const { store, settings, theme } = slices;
  return {
    read() {
      let doc = { ...empty(), recipes: [...store.ids].sort() };
      if (settings) doc = writeSettings(doc, settings.read());
      const look = theme?.read();
      return look ? { ...doc, theme: look } : doc;
    },
    write(next) {
      const want = new Set(next.recipes);
      const have = new Set(store.ids);
      const extra = [...have].filter((id) => !want.has(id));
      if (extra.length) store.remove(...extra);
      const missing = [...want].filter((id) => !have.has(id));
      if (missing.length) store.add(...missing);
      if (settings) settings.write(readSettings(next));
      theme?.write(next.theme);
    },
  };
}

/** The controller over just a recipe store and, optionally, settings and theme. */
export function createSliceController(
  slices: {
    store: RecipeStore;
    settings?: SettingsStore;
    theme?: ThemeStore;
  },
  options: PlannerControllerOptions = {},
): PlannerController {
  return createPlannerAdapter({
    catalog: engineCatalog(),
    port: portFromSlices(slices),
    options,
  });
}
