import { getModel, shortLabel } from '../assistant/models.ts';
import {
  AssistantSession,
  type SessionOptions,
} from '../assistant/session.svelte.ts';
import {
  loadVoiceConsent,
  type VoiceOptions,
  VoiceSession,
} from '../assistant/voice.svelte.ts';
import { ByoModel } from '../inference/byo.svelte.ts';
import {
  type ConfigResult,
  DEFAULT_INFERENCE,
  type InferenceConfig,
} from '../inference/config.ts';
import { createHostChat } from '../inference/host.ts';
import { createSliceController } from '../planner/commands/index.ts';
import {
  type CapabilitySummary,
  deriveCapabilities,
  needsFirstRunSetup,
} from './status.ts';

/** UI choices that are not part of the cookbook. */
export interface AiPrefs {
  /** "I don't need AI": the first visit never shows the setup form again. */
  dismissed: boolean;
  /** Speak the assistant's replies with the browser's voices. */
  readAloud: boolean;
  /**
   * Hands-free voice typing: start when the visitor talks, stop when they
   * pause, one tap to end. Needs the downloaded speech model.
   */
  handsFree: boolean;
  /**
   * With hands-free on: send the message once the visitor stops talking, so
   * no tap is needed. Ignored while hands-free is off.
   */
  sendOnPause: boolean;
}

export const AI_PREFS_KEY = 'smrt-planner:ai:v1';

export function loadAiPrefs(storage: Storage | null): AiPrefs {
  const prefs: AiPrefs = {
    dismissed: false,
    readAloud: false,
    handsFree: false,
    sendOnPause: false,
  };
  try {
    const raw = storage?.getItem(AI_PREFS_KEY);
    if (!raw) return prefs;
    const value = JSON.parse(raw) as Partial<AiPrefs>;
    prefs.dismissed = value.dismissed === true;
    prefs.readAloud = value.readAloud === true;
    prefs.handsFree = value.handsFree === true;
    prefs.sendOnPause = value.sendOnPause === true;
  } catch {
    // Unreadable or unavailable: the defaults.
  }
  return prefs;
}

export function saveAiPrefs(storage: Storage | null, prefs: AiPrefs): void {
  try {
    storage?.setItem(AI_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not saved; the choice still holds for this visit.
  }
}

/** The slice of `speechSynthesis` the reader uses. */
export interface Synth {
  speak(utterance: SpeechSynthesisUtterance): void;
  cancel(): void;
}

export interface AiStateOptions {
  storage: Storage | null;
  session: Omit<SessionOptions, 'storage' | 'onReply'>;
  voice: Omit<VoiceOptions, 'storage'>;
  /** Defaults to the browser's `speechSynthesis`. */
  synth?: Synth | null;
  mic?: boolean;
  /** For host and bring-your-own requests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * The one store behind the sidebar icons, the AI models page, the first-visit
 * form and the assistant: it owns the language-model session, the voice-typing
 * session and the read-aloud choice, and reads them as three capabilities.
 */
export class AiState {
  readonly session: AssistantSession;
  readonly voice: VoiceSession;
  prefs = $state<AiPrefs>({
    dismissed: false,
    readAloud: false,
    handsFree: false,
    sendOnPause: false,
  });
  /** True once the browser has read its saved state (nothing before). */
  hydrated = $state(false);
  /** The first-visit setup form is showing. */
  firstRun = $state(false);
  /**
   * A reply is being read aloud, from the moment it is queued until the last
   * utterance ends, errors or is cancelled. Hands-free listening pauses
   * while this is true, so the microphone does not transcribe the voice.
   */
  speaking = $state(false);
  /** Where the model runs, from `planner.config.json` or the `inference` prop. */
  inference = $state<InferenceConfig>(DEFAULT_INFERENCE);
  /** Set when the config was unusable and `browser` is used instead. */
  notice = $state('');
  /** The visitor's own endpoint (byo mode only). */
  byo = $state<ByoModel | null>(null);

  /** Utterances queued and not yet ended; `speaking` is `pending > 0`. */
  private pending = 0;
  /** Bumped on cancel so late events from cancelled utterances are ignored. */
  private generation = 0;

  private readonly options: AiStateOptions;
  /** The config is still being fetched: leave the first-run decision to `configure`. */
  private pendingConfig = false;
  private builtAtHydrate = false;
  private readonly synth: Synth | null;
  private readonly mic: boolean;

  constructor(options: AiStateOptions) {
    this.options = options;
    this.session = new AssistantSession({
      ...options.session,
      storage: options.storage,
      onReply: (text) => this.speak(text),
    });
    this.voice = new VoiceSession({
      ...options.voice,
      storage: options.storage,
    });
    this.synth =
      options.synth !== undefined
        ? options.synth
        : typeof speechSynthesis !== 'undefined'
          ? speechSynthesis
          : null;
    this.mic =
      options.mic ??
      (typeof navigator !== 'undefined' && !!navigator.mediaDevices);
  }

  /**
   * Read the saved choices, probe the browser's speech, and decide whether
   * this is a first visit. Call once, in the browser, after the cookbook.
   */
  hydrate(built: boolean): void {
    if (this.hydrated) return;
    this.prefs = loadAiPrefs(this.options.storage);
    this.hydrated = true;
    this.builtAtHydrate = built;
    if (!this.pendingConfig) this.decideFirstRun();
    void this.voice.init();
  }

  /** The layout is fetching `planner.config.json`; `configure` follows. */
  awaitConfig(): void {
    this.pendingConfig = true;
  }

  /**
   * Apply the inference config. `host` is ready at once (nothing to download);
   * `byo` is ready once the visitor has connected an endpoint on the AI page;
   * `browser` is today's WebLLM. An unusable config arrives as `browser` with
   * a `notice`.
   */
  configure(result: ConfigResult): void {
    const { config, notice } = result;
    this.pendingConfig = false;
    this.inference = config;
    this.notice = notice ?? '';
    this.session.setMode(config.mode);
    this.byo = null;
    if (config.mode === 'host' && config.host) {
      const { controller, store, settings, theme } = this.options.session;
      const plan =
        controller ?? createSliceController({ store, settings, theme });
      this.session.useRemote(
        createHostChat({
          endpoint: config.host.endpoint,
          snapshot: () => plan.snapshot(),
          fetch: this.options.fetch,
        }),
        'Server',
      );
    } else if (config.mode === 'byo') {
      this.byo = new ByoModel({
        storage: this.options.storage,
        presets: config.byo?.presets,
        fetch: this.options.fetch,
        onChange: () => this.syncByo(),
      });
      this.syncByo();
    }
    if (this.hydrated) this.decideFirstRun();
  }

  private syncByo(): void {
    const byo = this.byo;
    if (!byo) return;
    this.session.useRemote(byo.active ? byo.chat() : null, byo.model);
  }

  private decideFirstRun(): void {
    // A host's server needs nothing set up, so the form has nothing to ask for.
    this.firstRun =
      this.inference.mode !== 'host' &&
      needsFirstRunSetup({
        thinkDownloaded:
          this.session.prefs.consented.length > 0 ||
          this.session.status === 'ready',
        hearDownloaded: loadVoiceConsent(this.options.storage),
        readAloud: this.prefs.readAloud,
        dismissed: this.prefs.dismissed,
        built: this.builtAtHydrate,
      });
  }

  /** Before hydration every capability reads as not set up, as on the server. */
  get capabilities(): CapabilitySummary[] {
    const model = getModel(this.session.prefs.modelId);
    const ready = this.hydrated;
    return deriveCapabilities({
      think: {
        status: ready ? this.session.status : 'idle',
        model: model ? shortLabel(model) : 'model',
        progress: this.session.progress.progress,
        downloaded: ready && this.session.prefs.consented.length > 0,
        mode: this.session.mode,
        remote: this.session.remoteLabel,
      },
      hear: {
        status: ready ? this.voice.status : 'checking',
        mic: !ready || this.mic,
      },
      speak: {
        supported: !ready || this.synth !== null,
        readAloud: ready && this.prefs.readAloud,
      },
    });
  }

  /** One sentence on where what the visitor types goes, for the AI page. */
  get privacyNote(): string {
    if (this.inference.mode === 'host') {
      return "Your messages and a short summary of your plan go to this site's server. Voice typing and reading aloud stay on this device.";
    }
    if (this.inference.mode === 'byo') {
      return 'Your messages and a short summary of your plan go to the model endpoint you choose, and nowhere else. Voice typing and reading aloud stay on this device.';
    }
    return 'Everything runs on this device. Nothing you type or say leaves the page.';
  }

  get speakSupported(): boolean {
    return this.synth !== null;
  }

  /** "Continue": leave the first-visit form for now. */
  continueFirstRun(): void {
    this.firstRun = false;
  }

  /** "I don't need AI": remembered, so the form never leads again. */
  dismissFirstRun(): void {
    this.firstRun = false;
    this.setPrefs({ ...this.prefs, dismissed: true });
  }

  setReadAloud(on: boolean): void {
    if (on && !this.synth) return;
    if (!on) this.cancelSpeech();
    this.setPrefs({ ...this.prefs, readAloud: on });
  }

  /** "Start when I talk, stop when I pause": remembered across visits. */
  setHandsFree(on: boolean): void {
    this.setPrefs({ ...this.prefs, handsFree: on });
  }

  /** "Send when I stop talking": remembered across visits. */
  setSendOnPause(on: boolean): void {
    this.setPrefs({ ...this.prefs, sendOnPause: on });
  }

  /** Hands-free is active and the visitor asked for a send on each pause. */
  get sendOnPauseActive(): boolean {
    return this.handsFreeActive && this.prefs.sendOnPause;
  }

  /**
   * Hands-free dictation is on and possible: the downloaded model is what
   * writes the sentences down (the browser's own recogniser cannot).
   */
  get handsFreeActive(): boolean {
    return this.prefs.handsFree && this.voice.status === 'ready';
  }

  /**
   * Speak a reply when the visitor switched read-aloud on. Paragraphs are
   * separate utterances; `speaking` stays true until the last one ends.
   */
  speak(text: string): void {
    if (!this.prefs.readAloud || !this.synth || !text.trim()) return;
    this.cancelSpeech();
    const chunks = text
      .split(/\n{2,}/)
      .map((chunk) => chunk.trim())
      .filter(Boolean);
    const generation = this.generation;
    this.pending = chunks.length;
    this.speaking = true;
    const settle = () => {
      if (generation !== this.generation) return;
      this.pending = Math.max(0, this.pending - 1);
      if (this.pending === 0) this.speaking = false;
    };
    for (const chunk of chunks) {
      const utterance = new SpeechSynthesisUtterance(chunk);
      utterance.onend = settle;
      utterance.onerror = settle;
      this.synth.speak(utterance);
    }
  }

  /**
   * Stop talking now (typing, the microphone, read-aloud switched off).
   * Clears `speaking` at once rather than waiting for the browser's events.
   */
  cancelSpeech(): void {
    this.generation += 1;
    this.pending = 0;
    this.speaking = false;
    this.synth?.cancel();
  }

  private setPrefs(prefs: AiPrefs): void {
    this.prefs = prefs;
    saveAiPrefs(this.options.storage, prefs);
  }
}
