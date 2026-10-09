import { createSpeechModel } from '../assistant/voice-host.ts';
import { browserStorage } from '../cookbook/storage.ts';
import { cookbookStore } from '../cookbook/store.svelte.ts';
import { recipes } from '../recipes/index.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import { AiState } from './state.svelte.ts';

/** The app's one AI state: shared by the sidebar, the AI page and the assistant. */
export const aiState = new AiState({
  storage: browserStorage(),
  session: {
    store: recipeState,
    recipes,
    settings: {
      read: () => cookbookStore.settings(),
      write: (settings) => cookbookStore.setSettings(settings),
    },
    theme: {
      read: () => cookbookStore.snapshot().theme,
      write: (theme) => cookbookStore.setTheme(theme),
    },
  },
  voice: { createModel: createSpeechModel },
});
