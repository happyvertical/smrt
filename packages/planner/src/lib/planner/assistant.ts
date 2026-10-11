import type {
  RecipeStore,
  SettingsStore,
  ThemeStore,
} from '../assistant/change.ts';
import { ThemeUndos } from '../assistant/theme-undo.svelte.ts';
import {
  type BrowserAssistantTransport,
  type ChatModel,
  createBrowserAssistantTransport,
} from '../assistant/transport.ts';
import { browserStorage } from '../cookbook/storage.ts';
import { savedByoChat } from '../inference/byo.svelte.ts';
import { configFromProp, type InferenceConfig } from '../inference/config.ts';
import { createHostChat } from '../inference/host.ts';
import { recipes } from '../recipes/index.ts';
import type { ThemeSetting } from '../theme/theme.ts';
import type { PlannerController } from './commands/index.ts';

/**
 * Give the planner a model yourself: anything that implements `message()`
 * (the browser's WebLLM, an API provider behind your server, a test double).
 * Choosing and loading it is the host's job; the planner only asks it for one
 * structured reply per turn.
 */
export interface PlannerChatInference {
  /** The model, or a function returning it (null until one is loaded). */
  chat: ChatModel | (() => ChatModel | null);
  /** Called with each reply the model wrote, e.g. to read it aloud. */
  onReply?: (text: string) => void;
}

/**
 * Or name an inference mode, the same shape as `planner.config.json`'s
 * `inference` (it overrides the file):
 * - `host`: POST to `host.endpoint` (see `docs/inference-host.md`).
 * - `byo`: the OpenAI-compatible endpoint the visitor connected in this
 *   browser; none until they have.
 * - `browser`: no model of its own; pass `chat` to supply one.
 * An invalid config falls back to `browser`, reported as `assistant.notice`.
 */
export type PlannerConfigInference = InferenceConfig & {
  onReply?: (text: string) => void;
};

export type PlannerInference = PlannerChatInference | PlannerConfigInference;

export interface PlannerAssistant {
  /** For smrt-chat's `AssistantDock` (`transport`). */
  transport: BrowserAssistantTransport;
  /** The theme changes it made, each undoable; render with `toolCallData`. */
  themeUndos: ThemeUndos;
  /** The mode in use. */
  mode: InferenceConfig['mode'];
  /** Why the given `inference` was replaced by `browser`, when it was. */
  notice?: string;
}

/** The controller's recipes as the store the assistant reads. Changes are commands. */
function recipeStoreOf(controller: PlannerController): RecipeStore {
  return {
    get ids() {
      return controller.snapshot().recipes.map((recipe) => recipe.id);
    },
    add: (...ids) =>
      void controller.run({ name: 'add_recipes', input: { ids } }),
    remove: (...ids) =>
      void controller.run({ name: 'remove_recipes', input: { ids } }),
  };
}

function settingsStoreOf(controller: PlannerController): SettingsStore {
  return {
    read: () => {
      const { currency, taxRate, paymentTerms } =
        controller.snapshot().settings;
      return {
        currency,
        taxRate: Number((taxRate / 100).toFixed(6)),
        paymentTerms,
      };
    },
    write: (settings) => {
      void controller.run({
        name: 'set_settings',
        input: {
          currency: settings.currency,
          taxRate: Number((settings.taxRate * 100).toFixed(4)),
          ...(settings.paymentTerms
            ? { paymentTerms: settings.paymentTerms }
            : {}),
        },
      });
    },
  };
}

function themeStoreOf(controller: PlannerController): ThemeStore {
  return {
    read: () => {
      const { preset, primary, colorScheme } = controller.snapshot().theme;
      const theme: ThemeSetting = {};
      if (preset) theme.preset = preset;
      if (primary) theme.custom = { primary };
      if (colorScheme !== 'system') {
        theme.colorScheme = colorScheme as ThemeSetting['colorScheme'];
      }
      return Object.keys(theme).length ? theme : undefined;
    },
    write: (theme) => {
      if (!theme) {
        void controller.run({ name: 'reset_theme', input: {} });
        return;
      }
      void controller.run({ name: 'reset_theme', input: {} });
      void controller.run({
        name: 'set_theme',
        input: {
          ...(theme.preset ? { preset: theme.preset } : {}),
          ...(theme.custom ? { primary: theme.custom.primary } : {}),
          ...(theme.colorScheme ? { colorScheme: theme.colorScheme } : {}),
        },
      });
    },
  };
}

/**
 * The planner's assistant for any controller: a chat transport whose every
 * change is a command on `controller`, so it works against a host's own mount
 * as well as the static app. Cookbook proposals are not offered here (they
 * need a confirmation card the host would render); everything else is.
 */
export function createPlannerAssistant(
  controller: PlannerController,
  inference: PlannerInference,
): PlannerAssistant {
  const theme = themeStoreOf(controller);
  let mode: InferenceConfig['mode'] = 'browser';
  let notice: string | undefined;
  let chat: () => ChatModel | null = () => null;
  if ('chat' in inference) {
    const given = inference.chat;
    chat = () => (typeof given === 'function' ? given() : given);
  } else {
    const result = configFromProp(inference);
    notice = result.notice;
    mode = result.config.mode;
    if (result.config.mode === 'host' && result.config.host) {
      const host = createHostChat({
        endpoint: result.config.host.endpoint,
        snapshot: () => controller.snapshot(),
      });
      chat = () => host;
    } else if (result.config.mode === 'byo') {
      const presets = result.config.byo?.presets;
      chat = () =>
        savedByoChat(
          browserStorage(),
          presets,
          undefined,
          result.config.credentialPersistence,
        );
    }
  }
  const themeUndos = new ThemeUndos(theme, controller);
  const transport = createBrowserAssistantTransport({
    model: chat,
    acceptCommands: mode === 'host',
    unavailable:
      mode === 'byo'
        ? 'Connect your model on the AI page first, then I can help.'
        : 'No model is connected yet, so I cannot help. The planner works without one.',
    store: recipeStoreOf(controller),
    recipes,
    // No cookbook proposals: they need a confirmation card the host renders.
    cookbooks: [],
    settings: settingsStoreOf(controller),
    theme,
    themeUndos,
    controller,
    onReply: inference.onReply,
  });
  return { transport, themeUndos, mode, ...(notice ? { notice } : {}) };
}
