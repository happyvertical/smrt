import { untrack } from 'svelte';
import {
  type CookbookStore,
  cookbookStore,
} from '../../cookbook/store.svelte.ts';
import { parseCookbook } from '../../cookbook/validate.ts';
import { setSamplePack } from '../../data/packs.ts';
import { libraryState } from '../../library/state.svelte.ts';
import {
  type Cell,
  createPlannerAdapter,
  type PlannerAdapter,
  type PlannerController,
  type PlannerControllerOptions,
  type PlannerPort,
} from './adapter.ts';
import { engineCatalog } from './catalog.ts';
import type { PlannerTabId } from './types.ts';

export type {
  PlannerController,
  PlannerControllerOptions,
  PlannerNavigation,
} from './adapter.ts';

/** A reactive cell: reading it in an effect subscribes to it. */
function reactiveCell<T>(initial: T): Cell<T> {
  let value = $state(initial);
  return {
    get: () => value,
    set: (next) => {
      value = next;
    },
  };
}

/** The app's stores as the engine's port: where the document is read and written. */
export function portFromStore(store: CookbookStore): PlannerPort {
  return {
    read: () => store.snapshot(),
    applied: () => libraryState.active,
    prepareImport: (document) => parseCookbook(document),
    write(cookbook, { replaced, applied, libraryApplied }) {
      // A page's customisations are edited outside the plan; only a command
      // that replaces the whole app brings its own.
      const next = replaced
        ? cookbook
        : { ...cookbook, overviews: store.snapshot().overviews };
      if (replaced) store.replace(next);
      else store.apply(next);
      if (libraryApplied && applied) {
        libraryState.select(applied);
        setSamplePack(applied);
      }
    },
  };
}

/**
 * The controller for the planner app over `store` (the app's is
 * `cookbookStore`): smrt's cookbook engine behind the planner's command names,
 * with the stores as its document and the planner tab and section as `focus`.
 * Every UI path that changes the app is a command here, and the assistant, the
 * palette, a host page and the MCP and CLI servers use the same ones.
 */
export function createPlannerController(
  store: CookbookStore = cookbookStore,
  options: PlannerControllerOptions = {},
): PlannerController & Pick<PlannerAdapter, 'cookbook' | 'undo' | 'tools'> {
  let stopEffects: (() => void) | undefined;
  const adapter: PlannerAdapter = createPlannerAdapter({
    catalog: engineCatalog(),
    port: portFromStore(store),
    options,
    env: {
      section: reactiveCell<string | null>(null),
      tab: reactiveCell<PlannerTabId | null>(null),
      watch: {
        start() {
          if (stopEffects) return;
          stopEffects = $effect.root(() => {
            $effect(() => {
              // Reading the snapshot subscribes to every store it is built from.
              adapter.observe();
              untrack(adapter.deliver);
            });
          });
        },
        stop() {
          stopEffects?.();
          stopEffects = undefined;
        },
      },
    },
  });
  return adapter;
}
