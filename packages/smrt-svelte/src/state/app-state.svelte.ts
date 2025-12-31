/**
 * Svelte 5 reactive app state
 *
 * Uses runes ($state, $derived) for reactivity.
 * This is the Svelte-specific binding layer on top of app-state.ts
 */

import {
  canEnableSmrtMode,
  detectCapabilities,
  type GetLLMOptions,
  type GetSTTOptions,
  type GetTTSOptions,
  getLLM,
  getSTT,
  getTTS,
  type LLMAdapter,
  type OnProgress,
  type STTAdapter,
  type TTSAdapter,
  type TTSOptions,
} from '@happyvertical/browser-ai';

import {
  type AppMode,
  type CreateAppStateOptions,
  createInitialState,
  type ModeSource,
  type SmrtAppState,
  type UserSession,
} from './app-state.js';

/**
 * Reactive app state manager for Svelte 5
 */
export class SmrtAppStateManager {
  // Reactive state using $state rune
  private _state = $state<SmrtAppState>(createInitialState());

  // Options
  private options: CreateAppStateOptions;

  constructor(options: CreateAppStateOptions = {}) {
    this.options = options;
  }

  /**
   * Get the current state (readonly)
   */
  get state(): Readonly<SmrtAppState> {
    return this._state;
  }

  /**
   * Initialize the app state
   * Detects capabilities and sets initial mode
   */
  async initialize(): Promise<void> {
    if (this._state.initialized) return;

    // Detect capabilities
    const capabilities = detectCapabilities();
    this._state.capabilities = capabilities;

    // Notify callback
    this.options.onCapabilitiesDetected?.(capabilities);

    // Determine initial mode
    if (this.options.initialMode) {
      this._state.mode = this.options.initialMode;
      this._state.modeSource = 'explicit';
    } else {
      // Auto-detect based on capabilities and preferences
      const autoEnable = this._state.session.preferences.autoEnableSmrt ?? true;
      if (autoEnable && canEnableSmrtMode(capabilities)) {
        this._state.mode = 'smrt';
        this._state.modeSource = 'auto';
      }
    }

    // Apply initial session if provided
    if (this.options.session) {
      this._state.session = {
        ...this._state.session,
        ...this.options.session,
      };
    }

    this._state.initialized = true;
  }

  /**
   * Set the app mode
   */
  setMode(mode: AppMode, source: ModeSource = 'toggled'): void {
    if (this._state.mode === mode) return;

    this._state.mode = mode;
    this._state.modeSource = source;

    this.options.onModeChange?.(mode, source);

    // Preload Whisper.cpp when switching to smrt mode
    if (mode === 'smrt') {
      this.initializeSTT({ type: 'whisper-cpp' }).catch(() => {
        // Error stored in state, don't throw
      });
    }
  }

  /**
   * Toggle between dumb and smrt modes
   */
  toggleMode(): void {
    const newMode = this._state.mode === 'dumb' ? 'smrt' : 'dumb';
    this.setMode(newMode, 'toggled');
  }

  /**
   * Update user session
   */
  updateSession(session: Partial<UserSession>): void {
    this._state.session = {
      ...this._state.session,
      ...session,
    };
  }

  /**
   * Set user permissions
   */
  setPermissions(permissions: string[]): void {
    this._state.session.permissions = permissions;
  }

  /**
   * Check if user has a permission
   */
  hasPermission(permission: string): boolean {
    return this._state.session.permissions.includes(permission);
  }

  /**
   * Check if user has all permissions
   */
  hasAllPermissions(permissions: string[]): boolean {
    return permissions.every((p) =>
      this._state.session.permissions.includes(p),
    );
  }

  /**
   * Check if user has any of the permissions
   */
  hasAnyPermission(permissions: string[]): boolean {
    return permissions.some((p) => this._state.session.permissions.includes(p));
  }

  // === STT Methods ===

  /**
   * Initialize STT adapter
   */
  async initializeSTT(options?: GetSTTOptions): Promise<STTAdapter> {
    const currentAdapter = this._state.ai.stt.adapter;
    const requestedType = options?.type;

    // Return existing adapter if it matches the requested type (or no type specified)
    if (currentAdapter && this._state.ai.stt.initState === 'ready') {
      if (!requestedType || currentAdapter.type === requestedType) {
        return currentAdapter;
      }
      // Type mismatch - dispose old adapter before creating new one
      console.log(
        `[STT] Switching adapter from ${currentAdapter.type} to ${requestedType}`,
      );
      await currentAdapter.dispose?.();
    }

    this._state.ai.stt.initState = 'initializing';
    this._state.ai.stt.error = null;

    const onProgress: OnProgress = (progress) => {
      this._state.ai.stt.downloadProgress = progress;
    };

    try {
      const adapter = await getSTT(options);
      await adapter.ensureInitialized(onProgress);

      this._state.ai.stt.adapter = adapter;
      this._state.ai.stt.initState = 'ready';
      this._state.ai.stt.downloadProgress = null;

      // Subscribe to adapter events
      adapter.onResult((result) => {
        if (result.isFinal) {
          // Accumulate final results (for continuous mode where multiple phrases are spoken)
          const existing = this._state.ai.stt.lastResult;
          if (existing) {
            this._state.ai.stt.lastResult = `${existing} ${result.text}`;
          } else {
            this._state.ai.stt.lastResult = result.text;
          }
          this._state.ai.stt.interimResult = '';
        } else {
          // Interim result - update live
          this._state.ai.stt.interimResult = result.text;
        }
      });

      adapter.onStart(() => {
        this._state.ai.stt.isListening = true;
      });

      adapter.onEnd(() => {
        this._state.ai.stt.isListening = false;
      });

      adapter.onError((error) => {
        this._state.ai.stt.error = error;
      });

      return adapter;
    } catch (error) {
      this._state.ai.stt.initState = 'error';
      this._state.ai.stt.error =
        error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /**
   * Start STT listening
   */
  async startListening(
    options?: Parameters<STTAdapter['start']>[0],
  ): Promise<void> {
    const adapter = await this.initializeSTT();
    // Clear ALL previous results when starting fresh
    this._state.ai.stt.lastResult = '';
    this._state.ai.stt.interimResult = '';
    await adapter.start(options);
  }

  /**
   * Stop STT listening
   */
  async stopListening(): Promise<void> {
    await this._state.ai.stt.adapter?.stop();
    // Clear interim result on stop
    this._state.ai.stt.interimResult = '';
  }

  // === TTS Methods ===

  /**
   * Initialize TTS adapter
   */
  async initializeTTS(options?: GetTTSOptions): Promise<TTSAdapter> {
    if (
      this._state.ai.tts.adapter &&
      this._state.ai.tts.initState === 'ready'
    ) {
      return this._state.ai.tts.adapter;
    }

    this._state.ai.tts.initState = 'initializing';
    this._state.ai.tts.error = null;

    const onProgress: OnProgress = (progress) => {
      this._state.ai.tts.downloadProgress = progress;
    };

    try {
      const adapter = await getTTS(options);
      await adapter.ensureInitialized(onProgress);

      this._state.ai.tts.adapter = adapter;
      this._state.ai.tts.initState = 'ready';
      this._state.ai.tts.downloadProgress = null;

      // Subscribe to adapter events
      adapter.onStart(() => {
        this._state.ai.tts.isSpeaking = true;
        this._state.ai.tts.isPaused = false;
      });

      adapter.onEnd(() => {
        this._state.ai.tts.isSpeaking = false;
        this._state.ai.tts.isPaused = false;
      });

      adapter.onError((error) => {
        this._state.ai.tts.error = error;
        this._state.ai.tts.isSpeaking = false;
      });

      return adapter;
    } catch (error) {
      this._state.ai.tts.initState = 'error';
      this._state.ai.tts.error =
        error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /**
   * Speak text using TTS
   */
  async speak(text: string, options?: TTSOptions): Promise<void> {
    const adapter = await this.initializeTTS();
    await adapter.speak(text, options);
  }

  /**
   * Stop TTS speech
   */
  stopSpeaking(): void {
    this._state.ai.tts.adapter?.stop();
  }

  /**
   * Pause TTS speech
   */
  pauseSpeaking(): void {
    this._state.ai.tts.adapter?.pause();
    if (this._state.ai.tts.isSpeaking) {
      this._state.ai.tts.isPaused = true;
    }
  }

  /**
   * Resume TTS speech
   */
  resumeSpeaking(): void {
    this._state.ai.tts.adapter?.resume();
    if (this._state.ai.tts.isPaused) {
      this._state.ai.tts.isPaused = false;
    }
  }

  /**
   * Get available TTS voices
   */
  getTTSVoices() {
    return this._state.ai.tts.adapter?.getVoices() ?? [];
  }

  // === LLM Methods ===

  /**
   * Initialize LLM adapter
   */
  async initializeLLM(
    modelId?: string,
    options?: GetLLMOptions,
  ): Promise<LLMAdapter> {
    // Check if already initialized with the right model
    if (
      this._state.ai.llm.adapter &&
      this._state.ai.llm.initState === 'ready' &&
      (!modelId || this._state.ai.llm.currentModel === modelId)
    ) {
      return this._state.ai.llm.adapter;
    }

    this._state.ai.llm.initState = 'initializing';
    this._state.ai.llm.error = null;

    const onProgress: OnProgress = (progress) => {
      this._state.ai.llm.downloadProgress = progress;
    };

    try {
      const adapter = await getLLM(options);
      await adapter.ensureInitialized(modelId, onProgress);

      this._state.ai.llm.adapter = adapter;
      this._state.ai.llm.initState = 'ready';
      this._state.ai.llm.currentModel = adapter.currentModel;
      this._state.ai.llm.downloadProgress = null;

      return adapter;
    } catch (error) {
      this._state.ai.llm.initState = 'error';
      this._state.ai.llm.error =
        error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }

  /**
   * Send a message to the LLM
   */
  async chat(
    text: string,
    options?: { systemPrompt?: string; onToken?: (token: string) => void },
  ): Promise<string> {
    const adapter = await this.initializeLLM();

    this._state.ai.llm.isGenerating = true;

    try {
      const response = await adapter.message(text, {
        systemPrompt: options?.systemPrompt,
        onToken: options?.onToken,
      });
      return response;
    } finally {
      this._state.ai.llm.isGenerating = false;
    }
  }

  /**
   * Unload LLM model to free memory
   */
  async unloadLLM(): Promise<void> {
    await this._state.ai.llm.adapter?.unloadModel();
    this._state.ai.llm.adapter = null;
    this._state.ai.llm.initState = 'uninitialized';
    this._state.ai.llm.currentModel = null;
  }

  // === Cleanup ===

  /**
   * Dispose of all resources
   */
  async dispose(): Promise<void> {
    await this._state.ai.stt.adapter?.dispose();
    await this._state.ai.tts.adapter?.dispose();
    await this._state.ai.llm.adapter?.dispose();

    this._state = createInitialState();
  }
}

/**
 * Create a new reactive app state manager
 */
export function createAppState(
  options?: CreateAppStateOptions,
): SmrtAppStateManager {
  return new SmrtAppStateManager(options);
}
