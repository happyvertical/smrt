import { isWebGPUAvailable, WebLLMProvider } from '@happyvertical/ai/local';
import type { Recipe } from '../recipes/types.ts';
import type { RecipeStore } from './change.ts';
import {
  browserHost,
  type EngineHost,
  type LoadedModel,
  type LoadProgress,
  loadModel,
} from './engine.ts';
import { getModel } from './models.ts';
import { type AssistantPrefs, loadPrefs, savePrefs } from './prefs.ts';
import {
  type BrowserAssistantTransport,
  type ChatModel,
  createBrowserAssistantTransport,
} from './transport.ts';

export type SessionStatus =
  | 'unsupported'
  | 'idle'
  | 'loading'
  | 'ready'
  | 'error';

export interface SessionOptions {
  store: RecipeStore;
  recipes: readonly Recipe[];
  storage: Storage | null;
  /** Defaults to the browser's WebGPU check. */
  webgpu?: () => boolean;
  host?: EngineHost;
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

  readonly transport: BrowserAssistantTransport;
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
    this.transport = createBrowserAssistantTransport({
      model: () => this.chat,
      store: options.store,
      recipes: options.recipes,
    });
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
      this.chat = new WebLLMProvider({
        type: 'webllm',
        engine: loaded.engine,
        model: modelId,
      });
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
