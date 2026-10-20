import { createSpeechModel } from '../assistant/voice-host.ts';
import { browserStorage } from '../cookbook/storage.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { plannerController, plannerRuntime } from '../planner/instance.ts';
import { workspaceStorage } from '../planner/workspace-storage.ts';
import { recipes } from '../recipes/index.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { AiState } from './state.svelte.ts';

/** The app's one AI state: shared by the sidebar, the AI page and the assistant. */
export const aiState = new AiState({
  storage: browserStorage(),
  session: {
    conversationStorage: workspaceStorage(),
    store: recipeState,
    recipes,
    controller: plannerController,
    settings: {
      read: () => cookbookStore.settings(),
      write: (settings) => cookbookStore.setSettings(settings),
    },
    theme: {
      read: () => cookbookStore.snapshot().theme,
      write: (theme) => cookbookStore.setTheme(theme),
    },
    // Only where the running app can open a section (the static layout and
    // the mount set `openSection`), the visible ones.
    menu: () =>
      plannerRuntime.openSection
        ? plannerController
            .snapshot()
            .sections.filter((section) => !section.hidden)
            .map(({ id, label }) => ({ id, label }))
        : [],
  },
  voice: { createModel: createSpeechModel },
});
