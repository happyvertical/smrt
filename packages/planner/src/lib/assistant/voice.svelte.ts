import {
  type BrowserSpeechSupport,
  createSttDictationSource,
  LOCAL_SPEECH_MODELS,
  probeBrowserSpeech,
  type LocalSpeechModel as SpeechModelHandle,
  type STTAdapter,
} from '@happyvertical/smrt-svelte/browser-ai';

/**
 * Voice typing for the assistant. The browser's own speech recognition is
 * used where it works (Chrome, Edge, Safari). Where it does not (Firefox has
 * none; Brave has the API with no speech service behind it), the visitor is
 * offered a one-time download of a small speech model that then runs on their
 * own device. Nothing is downloaded without their say-so.
 */

/** The downloadable model the offer drives (smrt-svelte's `LocalSpeechModel`). */
export type LocalSpeechModel = SpeechModelHandle;

/** The speech models the visitor can pick (smrt-svelte's short names). */
export type SpeechModelId =
  | 'moonshine-base'
  | 'moonshine-tiny'
  | 'whisper-tiny.en';

export interface SpeechModelChoice {
  id: SpeechModelId;
  label: string;
  /** One line on what it is good for. */
  note: string;
  /** smrt-svelte adapter type that runs it. */
  adapter: 'moonshine' | 'whisper-local';
  /** First-download size in bytes (smrt-svelte's estimate). */
  bytes: number;
}

/**
 * Moonshine base first: it is accurate enough for plain talking, where the
 * tiny model garbled words. Tiny stays for the quickest, least exact option.
 */
export const SPEECH_MODELS: readonly SpeechModelChoice[] = [
  {
    id: 'moonshine-base',
    label: 'Moonshine base',
    note: 'Accurate and still quick, best for talking as you go (default)',
    adapter: 'moonshine',
    bytes: LOCAL_SPEECH_MODELS['moonshine-base']?.bytes ?? 0,
  },
  {
    id: 'moonshine-tiny',
    label: 'Moonshine tiny',
    note: 'Fastest, less accurate',
    adapter: 'moonshine',
    bytes: LOCAL_SPEECH_MODELS['moonshine-tiny']?.bytes ?? 0,
  },
  {
    id: 'whisper-tiny.en',
    label: 'Whisper tiny',
    note: 'English, the original choice',
    adapter: 'whisper-local',
    bytes: LOCAL_SPEECH_MODELS['whisper-tiny.en']?.bytes ?? 0,
  },
];

export const DEFAULT_SPEECH_MODEL: SpeechModelId = 'moonshine-base';

export function speechModelChoice(id: SpeechModelId): SpeechModelChoice {
  return (
    SPEECH_MODELS.find((choice) => choice.id === id) ??
    (SPEECH_MODELS[0] as SpeechModelChoice)
  );
}

export type VoiceStatus =
  /** Probing the browser. */
  | 'checking'
  /** The browser's own speech recognition works; nothing to offer. */
  | 'browser'
  /** Not usable here: offer the local model (or turn on a cached one). */
  | 'offer'
  | 'downloading'
  | 'ready'
  | 'error'
  /** The visitor said "not now" for this visit. */
  | 'dismissed';

export type DictationSource = () => Promise<STTAdapter>;

export interface VoiceOptions {
  storage: Storage | null;
  /** Makes the downloadable model. Not called when the browser's works. */
  createModel: (model: SpeechModelId) => LocalSpeechModel;
  probe?: () => Promise<BrowserSpeechSupport>;
  /** Builds the dictation source for the browser's own recogniser. */
  browserSource?: () => DictationSource;
  /** Builds the dictation source that records and transcribes locally. */
  localSource?: (
    model: LocalSpeechModel,
    choice: SpeechModelChoice,
  ) => DictationSource;
}

export const VOICE_PREFS_KEY = 'smrt-planner:voice:v1';

interface VoicePrefs {
  /** The visitor has downloaded (and so accepted) the local model. */
  local: boolean;
  /** Use the downloadable model even where the browser's own works. */
  preferLocal: boolean;
  /** Which downloadable model. */
  model: SpeechModelId;
}

function loadVoicePrefs(storage: Storage | null): VoicePrefs {
  try {
    const raw = storage?.getItem(VOICE_PREFS_KEY);
    if (raw) {
      const value = JSON.parse(raw) as Partial<VoicePrefs>;
      const local = value.local === true;
      const known = SPEECH_MODELS.find((m) => m.id === value.model)?.id;
      return {
        local,
        preferLocal: value.preferLocal === true,
        // Someone who downloaded before the choice existed has Whisper tiny.
        model: known ?? (local ? 'whisper-tiny.en' : DEFAULT_SPEECH_MODEL),
      };
    }
  } catch {
    // Unreadable or unavailable: the defaults.
  }
  return { local: false, preferLocal: false, model: DEFAULT_SPEECH_MODEL };
}

function saveVoicePrefs(storage: Storage | null, prefs: VoicePrefs): void {
  try {
    storage?.setItem(VOICE_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not saved; the choice still holds for this visit.
  }
}

/** Whether the visitor has downloaded (and so accepted) the local model. */
export function loadVoiceConsent(storage: Storage | null): boolean {
  return loadVoicePrefs(storage).local;
}

export function saveVoiceConsent(
  storage: Storage | null,
  local: boolean,
): void {
  saveVoicePrefs(storage, { ...loadVoicePrefs(storage), local });
}

/** Whether the visitor chose the downloadable model over the browser's own. */
export function loadPreferLocal(storage: Storage | null): boolean {
  return loadVoicePrefs(storage).preferLocal;
}

/** The speech model the visitor chose (Moonshine base until they say). */
export function loadSpeechModel(storage: Storage | null): SpeechModelId {
  return loadVoicePrefs(storage).model;
}

/** What to do for a probe result, given what is on the device. */
export type VoicePlan = 'browser' | 'offer' | 'enable-cached';

export function planVoice(
  support: BrowserSpeechSupport,
  consented: boolean,
  cached: boolean,
): VoicePlan {
  if (support === 'works') return 'browser';
  // They already took the download: turn it on without asking again.
  return consented && cached ? 'enable-cached' : 'offer';
}

export class VoiceSession {
  status = $state<VoiceStatus>('checking');
  /** Whether the model files are already on this device. */
  cached = $state(false);
  /** Download progress, 0 to 1. */
  progress = $state(0);
  error = $state('');
  /** Whether the browser's own recogniser works here (whatever is in use). */
  browserWorks = $state(false);
  /** The visitor chose the downloadable model even where the browser's works. */
  preferLocal = $state(false);
  /** The size the offer shows, in bytes. */
  size = $state(0);
  /** The chosen downloadable model. */
  model = $state<SpeechModelId>(DEFAULT_SPEECH_MODEL);
  /** Every byte is in and the model is being prepared ("Getting ready"). */
  preparing = $state(false);

  /** The dictation source for the composer, or null when voice is off. */
  dictation = $state.raw<DictationSource | null>(null);

  private handle: LocalSpeechModel | null = null;
  private abort: AbortController | null = null;
  private readonly options: VoiceOptions;
  /**
   * Bumped by every init, enable and restart. Async work captures the value
   * it started under and drops its result when a newer one has begun, so a
   * superseded probe or download cannot overwrite the current status or
   * dictation source.
   */
  private generation = 0;

  constructor(options: VoiceOptions) {
    this.options = options;
  }

  /** Probe the browser and decide what to offer. Call once. */
  async init(): Promise<void> {
    const generation = ++this.generation;
    try {
      await this.probeAndOffer(generation);
    } catch (cause) {
      if (generation !== this.generation) return;
      this.status = 'error';
      this.error = cause instanceof Error ? cause.message : String(cause);
    }
  }

  private async probeAndOffer(generation: number): Promise<void> {
    const probed = await (this.options.probe ?? probeBrowserSpeech)();
    if (generation !== this.generation) return;
    this.browserWorks = probed === 'works';
    this.preferLocal = loadPreferLocal(this.options.storage);
    this.model = loadSpeechModel(this.options.storage);
    // Choosing the download treats the browser's recogniser as unavailable.
    const support =
      this.preferLocal && probed === 'works' ? 'unreliable' : probed;
    if (support === 'works') {
      this.dictation = (
        this.options.browserSource ??
        (() => createSttDictationSource({ type: 'browser-speech' }))
      )();
      this.status = 'browser';
      return;
    }
    const model = this.options.createModel(this.model);
    this.handle?.dispose();
    this.handle = model;
    this.size = model.estimateSize();
    const cached = await model.isCached().catch(() => false);
    // Superseded while checking the cache: the restart that superseded this
    // already disposed the model; the newer session owns the state.
    if (generation !== this.generation) return;
    this.cached = cached;
    const plan = planVoice(
      support,
      loadVoiceConsent(this.options.storage),
      this.cached,
    );
    if (plan === 'enable-cached') await this.enable();
    else this.status = 'offer';
  }

  /** Download (or read from the cache) and turn voice typing on. */
  async enable(): Promise<void> {
    const model = this.handle;
    if (!model || this.status === 'downloading') return;
    const generation = ++this.generation;
    this.status = 'downloading';
    this.error = '';
    this.progress = 0;
    this.preparing = false;
    const abort = new AbortController();
    this.abort = abort;
    try {
      await model.load({
        onProgress: (p) => {
          if (generation !== this.generation) return;
          this.progress = p.bytesTotal > 0 ? p.bytesLoaded / p.bytesTotal : 0;
          // The bytes are in; compiling the model for this device takes a moment.
          this.preparing = p.state === 'extracting';
        },
        signal: abort.signal,
      });
      if (generation !== this.generation) {
        // Superseded (restart, dispose or a newer enable): drop this result.
        // Whoever superseded it owns the model's disposal.
        return;
      }
      // Consent is kept only once the download completed.
      saveVoiceConsent(this.options.storage, true);
      this.cached = true;
      const choice = speechModelChoice(this.model);
      this.dictation = (
        this.options.localSource ??
        ((m, c) =>
          createSttDictationSource({
            type: c.adapter,
            // The consent flow and the dictation share one loaded model.
            modelHandle: m,
          }))
      )(model, choice);
      this.status = 'ready';
    } catch (error) {
      if (generation !== this.generation) return;
      if (abort.signal.aborted) {
        this.status = 'offer';
      } else {
        this.error = error instanceof Error ? error.message : String(error);
        this.status = 'error';
      }
    } finally {
      if (generation === this.generation) {
        this.abort = null;
        this.preparing = false;
      }
    }
  }

  /** Switch between the browser's recogniser and the downloadable model. */
  async setPreferLocal(on: boolean): Promise<void> {
    if (!this.browserWorks || on === this.preferLocal) return;
    await this.restart({ preferLocal: on });
  }

  /** Pick the downloadable model; the new one is offered (or turned on if cached). */
  async setModel(id: SpeechModelId): Promise<void> {
    if (id === this.model || !SPEECH_MODELS.some((m) => m.id === id)) return;
    await this.restart({ model: id });
  }

  /** Save a changed choice, let go of the current model, and decide again. */
  private async restart(change: Partial<VoicePrefs>): Promise<void> {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    this.preparing = false;
    this.handle?.dispose();
    this.handle = null;
    this.dictation = null;
    saveVoicePrefs(this.options.storage, {
      ...loadVoicePrefs(this.options.storage),
      ...change,
    });
    this.status = 'checking';
    await this.init();
  }

  /** Stop a download in progress. */
  cancel(): void {
    this.abort?.abort();
  }

  /** "Not now": hide the offer for this visit. */
  dismiss(): void {
    this.status = 'dismissed';
  }

  dispose(): void {
    this.generation++;
    this.abort?.abort();
    this.handle?.dispose();
    this.handle = null;
    this.dictation = null;
  }
}
