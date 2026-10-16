import { cookbookStore } from '../cookbook/store.svelte.ts';
import { createPlannerController } from './commands/index.ts';
import { plannerTab } from './tab.svelte.ts';

/**
 * Things only the running app can do, set by its layout: the controller calls
 * them after a command that needs them. Unset, the command still succeeds.
 */
export const plannerRuntime: {
  /** Regenerate the sample records after a cookbook replaced the app. */
  onReplaced?: () => void;
  /** Open a menu section's page (`focus` with a `section`). */
  openSection?: (sectionId: string) => void;
} = {};

/**
 * The app's one planner controller: the assistant, the palette, a host page
 * and (later) the MCP and CLI servers all drive the planner through it.
 */
export const plannerController = createPlannerController(cookbookStore, {
  navigation: {
    getTab: () => plannerTab.active,
    setTab: (tab) => {
      plannerTab.active = tab;
    },
    setSection: (id) => plannerRuntime.openSection?.(id),
  },
  onReplaced: () => plannerRuntime.onReplaced?.(),
});
