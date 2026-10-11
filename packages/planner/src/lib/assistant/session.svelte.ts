import { isWebGPUAvailable, WebLLMProvider } from '@happyvertical/ai/local';
import type { InferenceMode } from '../inference/config.ts';
import { getLibraryCookbook, libraryCookbooks } from '../library/index.ts';
import type { PlannerController } from '../planner/commands/index.ts';
import type { Recipe } from '../recipes/types.ts';
import type { RecipeStore, SettingsStore, ThemeStore } from './change.ts';
import {
  browserHost,
  type EngineHost,
  type LoadedModel,
  type LoadProgress,
  loadModel,
} from './engine.ts';
import { getModel } from './models.ts';
import { CookbookOffers } from './offers.svelte.ts';
import { type AssistantPrefs, loadPrefs, savePrefs } from './prefs.ts';
import { ThemeUndos } from './theme-undo.svelte.ts';
import {
  type BrowserAssistantTransport,
  type ChatModel,
  createBrowserAssistantTransport,
} from './transport.ts';

/**
 * Qwen3 reasons before it answers unless told not to; its `/no_think` switch
 * skips that, which is slow and pointless for a short structured reply. The
 * grammar-constrained JSON already keeps any thinking out of the output.
 */
export function withoutThinking(chat: ChatModel, modelId: string): ChatModel {
  if (!/^qwen3/i.test(modelId)) return chat;
  return {
    message: (text, options) => chat.message(`${text} /no_think`, options),
  };
}

export type SessionStatus =
  | 'unsupported'
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error';

export interface SessionOptions {
  store: RecipeStore;
  recipes: readonly Recipe[];
  /** The app settings the assistant may change; omit to leave them out. */
  settings?: SettingsStore;
  /** The app theme the assistant may change (with Undo); omit to leave it out. */
  theme?: ThemeStore;
  /** The controller the assistant's changes go through; made from the slices if omitted. */
  controller?: PlannerController;
  storage: Storage | null;
  /** Defaults to the browser's WebGPU check. */
  webgpu?: () => boolean;
  host?: EngineHost;
  /** Called with each reply the model produced, e.g. to read it aloud. */
  onReply?: (text: string) => void;
}

/**
 * The assistant's lifecycle: nothing is downloaded until the visitor accepts
 * the model's size (`start`), loading reports progress and can be cancelled,
 * and `unload` frees the GPU. The transport talks to whatever is loaded.
 */
export class AssistantSession {
  status = $state<SessionStatus>('idle');
  prefs = $state<AssistantPrefs>({ modelId: '', consented: [] });
  progress = $state<LoadProgress>({ progress: 0, text: '' });
  error = $state('');
  /** Where the model runs. `browser` loads WebLLM here; the others are remote. */
  mode = $state<InferenceMode>('browser');
  /** Remote modes: what the visitor sees as the model, e.g. `gpt-4o-mini`. */
  remoteLabel = $state('');

  readonly transport: BrowserAssistantTransport;
  /** Cookbooks the assistant proposed, applied only by the person's click. */
  readonly offers = new CookbookOffers(getLibraryCookbook);
  /** Theme changes the assistant made, each undoable from the chat. */
  readonly themeUndos: ThemeUndos | null;
  private loaded: LoadedModel | null = null;
  private chat: ChatModel | null = null;
  private abort: AbortController | null = null;
  private readonly options: SessionOptions;

  constructor(options: SessionOptions) {
    this.options = options;
    this.prefs = loadPrefs(options.storage);
    this.status = (options.webgpu ?? isWebGPUAvailable)()
      ? 'idle'
      : 'unsupported';
    this.themeUndos = options.theme
      ? new ThemeUndos(options.theme, options.controller)
      : null;
    this.transport = createBrowserAssistantTransport({
      model: () => this.chat,
      store: options.store,
      recipes: options.recipes,
      cookbooks: libraryCookbooks,
      offers: this.offers,
      settings: options.settings,
      theme: options.theme,
      controller: options.controller,
      themeUndos: this.themeUndos ?? undefined,
      acceptCommands: () => this.mode === 'host',
      unavailable: () =>
        this.mode === 'byo'
          ? 'Connect your model on the AI page first, then I can help. The cards on the Planner page work without one.'
          : this.mode === 'host'
            ? 'The assistant is not available right now. The cards on the Planner page work without it.'
            : this.mode === 'manual'
              ? 'Inference is off. The cards on the Planner page work without it.'
              : 'Download a model first, then I can help. The cards on the Planner page work without one.',
      onReply: (text) => options.onReply?.(text),
    });
  }

  /**
   * Choose where the model runs. `host` and `byo` need no WebGPU and no
   * download; the chat is set with `useRemote`.
   */
  setMode(mode: InferenceMode): void {
    if (mode !== this.mode) this.unload();
    this.mode = mode;
    if (mode !== 'browser') {
      this.status = 'idle';
    } else if (!(this.options.webgpu ?? isWebGPUAvailable)()) {
      this.status = 'unsupported';
    } else {
      this.status = 'idle';
    }
  }

  /** The remote chat model, or null when none is connected (byo, before setup). */
  useRemote(chat: ChatModel | null, label: string): void {
    if (this.mode === 'browser') return;
    this.chat = chat;
    this.remoteLabel = chat ? label : '';
    this.status = chat ? 'ready' : 'idle';
  }

  /** Whether the visitor already accepted the selected model's download. */
  get consented(): boolean {
    return this.prefs.consented.includes(this.prefs.modelId);
  }

  select(modelId: string): void {
    if (!getModel(modelId) || this.status === 'loading') return;
    this.prefs = { ...this.prefs, modelId };
    savePrefs(this.options.storage, this.prefs);
  }

  /** Load the selected model. The caller has shown its size and got consent. */
  async start(): Promise<void> {
    if (this.status === 'loading' || this.status === 'unsupported') return;
    const modelId = this.prefs.modelId;
    if (!getModel(modelId)) return;
    this.status = 'loading';
    this.error = '';
    this.progress = { progress: 0, text: 'Starting' };
    const abort = new AbortController();
    this.abort = abort;
    try {
      const loaded = await loadModel(
        modelId,
        (report) => {
          this.progress = report;
        },
        abort.signal,
        this.options.host ?? browserHost,
      );
      this.loaded = loaded;
      // Consent is recorded only once the download completed: a cancelled or
      // failed attempt must show the size and memory warning again.
      this.prefs = {
        ...this.prefs,
        consented: [...new Set([...this.prefs.consented, modelId])],
      };
      savePrefs(this.options.storage, this.prefs);
      this.chat = withoutThinking(
        new WebLLMProvider({
          type: 'webllm',
          engine: loaded.engine,
          model: modelId,
        }),
        modelId,
      );
      this.status = 'ready';
    } catch (error) {
      if (abort.signal.aborted) {
        this.status = 'idle';
      } else {
        this.error = error instanceof Error ? error.message : String(error);
        this.status = 'error';
      }
    } finally {
      this.abort = null;
    }
  }

  /** Stop a download in progress. */
  cancel(): void {
    this.abort?.abort();
  }

  /** Free the model, for example to choose another. */
  unload(): void {
    // A load in progress is aborted too, which terminates its worker.
    this.abort?.abort();
    this.transport.abort();
    this.loaded?.dispose();
    this.loaded = null;
    this.chat = null;
    if (this.status !== 'unsupported') this.status = 'idle';
  }
}
