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
} from '../browser-ai/index.js';

import {
  type AIConfig,
  type AILoadingState,
  type AppMode,
  type CreateAppStateOptions,
  createInitialState,
  type ModeSource,
  type SmrtAppState,
  type SocketConfig,
  type User,
  type UserSession,
} from './app-state.js';

import {
  getCachedLLM,
  getCachedSTT,
  getCachedTTS,
  type LLMType,
  type STTType,
  setCachedLLM,
  setCachedSTT,
  setCachedTTS,
  type TTSType,
  updateLLMCacheState,
  updateSTTCacheState,
  updateTTSCacheState,
} from './warm-clients.js';

/**
 * Module-scope record of the single active listener teardown for each warm
 * adapter. Warm adapters live in the module-level cache and survive Provider
 * remounts, so their event-listener `Set`s would otherwise accumulate one
 * closure set per manager that ever subscribed (R1 leak). Keying the teardown
 * by **adapter identity at module scope** (not a per-manager `WeakSet`)
 * guarantees at most one live subscription per shared adapter: before a new
 * manager subscribes, the previous owner's listeners are removed.
 */
const sttAdapterTeardowns = new WeakMap<STTAdapter, () => void>();
const ttsAdapterTeardowns = new WeakMap<TTSAdapter, () => void>();

/**
 * Structural equality for two AI configs (R3). Used to no-op `setAIConfig` when
 * an inline `ai={{…}}` literal re-renders with the same effective settings but a
 * new object identity. A shallow JSON compare is sufficient: AIConfig is a flat
 * tree of plain primitives/objects with no functions or class instances.
 */
function configsEqual(a: AIConfig, b: AIConfig): boolean {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    // Non-serializable (shouldn't happen for AIConfig) — treat as different.
    return false;
  }
}

/**
 * Reactive app state manager for Svelte 5
 */
export class SmrtAppStateManager {
  // Reactive state using $state rune
  private _state = $state<SmrtAppState>(createInitialState());

  // Options
  private options: CreateAppStateOptions;

  // AI configuration
  private _aiConfig: AIConfig | null = null;
  private _preloadScheduled = false;
  private _idleCallbackId: number | null = null;
  // Guards a single executePreload() pass from running concurrently. The
  // Provider's `ai` $effect can re-fire setAIConfig on every parent render
  // (inline `ai={{…}}` literal => new identity), and an `idle`/`eager` strategy
  // would otherwise launch overlapping preloads that interleave aiLoading
  // writes and double-download models (R3).
  private _preloadInFlight = false;

  // Socket management
  private _socket: WebSocket | null = null;
  private _socketConfig: SocketConfig | null = null;
  private _reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

  // Adapters this manager currently owns a subscription on, mapped to the
  // teardown that removes its listeners. Used both for dedup (skip re-subscribe
  // when this manager already owns the adapter) and to unsubscribe on dispose()
  // so a destroyed Provider stops pinning its `_state` proxy via the adapter's
  // module-surviving listener `Set`s (R1).
  private _sttSubscriptions = new Map<STTAdapter, () => void>();
  private _ttsSubscriptions = new Map<TTSAdapter, () => void>();

  constructor(options: CreateAppStateOptions = {}) {
    this.options = options;
    this._aiConfig = options.ai ?? null;
  }

  /**
   * Get the current socket configuration (for reconnection)
   */
  get socketConfig(): SocketConfig | null {
    return this._socketConfig;
  }

  /**
   * Get the current state (readonly)
   */
  get state(): Readonly<SmrtAppState> {
    return this._state;
  }

  /**
   * Get the current AI configuration
   */
  get aiConfig(): AIConfig | null {
    return this._aiConfig;
  }

  /**
   * Get the current AI loading state
   */
  get aiLoading(): Readonly<AILoadingState> {
    return this._state.aiLoading;
  }

  /**
   * Initialize the app state
   * Detects capabilities and sets initial mode
   * Note: This is a no-op during SSR as browser-ai requires browser environment
   */
  async initialize(): Promise<void> {
    if (this._state.initialized) return;

    // Skip during SSR - browser-ai APIs require browser environment
    if (typeof window === 'undefined') {
      this._state.initialized = true;
      return;
    }

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

    // Schedule AI preloading based on strategy
    this.schedulePreload();
  }

  // === AI Preloading Methods ===

  /**
   * Set or update AI configuration.
   *
   * No-ops when the incoming config is deep-equal to the current one. The
   * Provider's `ai` $effect depends on the prop's identity, and the documented
   * usage passes an inline `ai={{…}}` object literal — a fresh identity on every
   * parent render. Without this guard each render would cancel the idle
   * callback, reset `_preloadScheduled`, and re-schedule (and, for `eager`,
   * re-launch a full preload), thrashing the scheduler and double-downloading
   * models (R3).
   */
  setAIConfig(config: AIConfig): void {
    if (this._aiConfig && configsEqual(this._aiConfig, config)) {
      // Same effective config (different object identity) — nothing to do.
      this._aiConfig = config;
      return;
    }

    this._aiConfig = config;

    // Cancel any pending preload scheduling so we can re-schedule with new config
    if (
      this._idleCallbackId !== null &&
      typeof cancelIdleCallback !== 'undefined'
    ) {
      cancelIdleCallback(this._idleCallbackId);
      this._idleCallbackId = null;
    }
    this._preloadScheduled = false;

    // Re-schedule preloading with new config
    this.schedulePreload();
  }

  /**
   * Schedule preloading based on the configured strategy
   */
  private schedulePreload(): void {
    if (!this._aiConfig || this._preloadScheduled) return;

    const strategy = this._aiConfig.preload ?? 'idle';

    if (strategy === 'none') {
      return;
    }

    if (strategy === 'eager') {
      // Preload immediately
      this._preloadScheduled = true;
      this.executePreload();
      return;
    }

    if (strategy === 'idle') {
      // Schedule during browser idle time
      this._preloadScheduled = true;
      if (typeof requestIdleCallback !== 'undefined') {
        this._idleCallbackId = requestIdleCallback(
          () => this.executePreload(),
          { timeout: 5000 }, // Don't wait more than 5 seconds
        );
      } else {
        // Fallback for browsers without requestIdleCallback
        setTimeout(() => this.executePreload(), 100);
      }
      return;
    }

    // 'on-visible' is handled by components calling triggerPreload()
  }

  /**
   * Trigger preloading (called by components for 'on-visible' strategy)
   */
  triggerPreload(): void {
    if (!this._aiConfig || this._preloadScheduled) return;
    if (this._aiConfig.preload !== 'on-visible') return;

    this._preloadScheduled = true;
    this.executePreload();
  }

  /**
   * Execute the preloading of configured adapters.
   *
   * Re-entrancy guarded: an `idle`/`eager` strategy can be re-scheduled while a
   * pass is still awaiting model downloads. Without the guard the overlapping
   * passes interleave their aiLoading writes and double-download models (R3).
   */
  private async executePreload(): Promise<void> {
    if (!this._aiConfig) return;
    if (this._preloadInFlight) return;
    this._preloadInFlight = true;
    try {
      await this.runPreload();
    } finally {
      this._preloadInFlight = false;
    }
  }

  /**
   * The actual preload pass. Always invoked behind the `_preloadInFlight` guard
   * in {@link executePreload}.
   */
  private async runPreload(): Promise<void> {
    if (!this._aiConfig) return;

    const adaptersToLoad: string[] = [];

    // Determine which adapters need loading
    if (this._aiConfig.stt?.enabled !== false && this._aiConfig.stt?.type) {
      adaptersToLoad.push(`stt:${this._aiConfig.stt.type}`);
    }
    if (this._aiConfig.tts?.enabled !== false && this._aiConfig.tts?.type) {
      adaptersToLoad.push(`tts:${this._aiConfig.tts.type}`);
    }
    if (this._aiConfig.llm?.enabled !== false && this._aiConfig.llm?.type) {
      const modelKey = this._aiConfig.llm.model
        ? `${this._aiConfig.llm.type}:${this._aiConfig.llm.model}`
        : this._aiConfig.llm.type;
      adaptersToLoad.push(`llm:${modelKey}`);
    }

    if (adaptersToLoad.length === 0) {
      // Reset loaded/failed too (R7) — the main path clears them via the
      // 'checking' update below, so the early-return must not leave stale
      // entries from a prior pass behind.
      this.updateLoadingState({ phase: 'idle', loaded: [], failed: [] });
      return;
    }

    this.updateLoadingState({
      phase: 'checking',
      message: 'Checking AI capabilities...',
      loaded: [],
      failed: [],
    });

    // Load adapters sequentially to show progress
    for (const adapterKey of adaptersToLoad) {
      const [category, type] = adapterKey.split(':') as [
        'stt' | 'tts' | 'llm',
        string,
      ];

      this.updateLoadingState({
        phase: 'downloading',
        currentAdapter: type,
        message: `Loading ${type}...`,
      });

      try {
        if (category === 'stt') {
          const sttConfig = this._aiConfig.stt;
          await this.initializeSTT({
            type: type as STTType,
            allowLocalModels: sttConfig?.allowLocalModels,
          });
        } else if (category === 'tts') {
          await this.initializeTTS({ type: type as TTSType });
        } else if (category === 'llm') {
          const llmConfig = this._aiConfig.llm;
          if (llmConfig) {
            await this.initializeLLM(llmConfig.model, { type: llmConfig.type });
          }
        }

        this.updateLoadingState({
          loaded: [...this._state.aiLoading.loaded, type],
        });
      } catch (error) {
        console.error(`Failed to preload ${type}:`, error);
        this.updateLoadingState({
          failed: [...this._state.aiLoading.failed, type],
        });
      }
    }

    // Determine final state
    const hasFailures = this._state.aiLoading.failed.length > 0;
    const allLoaded =
      this._state.aiLoading.loaded.length === adaptersToLoad.length;

    if (allLoaded) {
      this.updateLoadingState({
        phase: 'ready',
        currentAdapter: null,
        overallProgress: 100,
        message: 'AI ready',
      });
    } else if (hasFailures && this._state.aiLoading.loaded.length === 0) {
      this.updateLoadingState({
        phase: 'error',
        currentAdapter: null,
        message: 'Failed to load AI models',
        error: new Error('All AI adapters failed to load'),
      });
    } else {
      // Partial success
      this.updateLoadingState({
        phase: 'ready',
        currentAdapter: null,
        message: `Loaded with ${this._state.aiLoading.failed.length} failure(s)`,
      });
    }

    this.options.onAILoadingChange?.(this._state.aiLoading);
  }

  /**
   * Update the AI loading state
   */
  private updateLoadingState(updates: Partial<AILoadingState>): void {
    this._state.aiLoading = {
      ...this._state.aiLoading,
      ...updates,
    };
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
      this.initializeSTT({
        type: 'whisper-cpp',
        allowLocalModels: this._aiConfig?.stt?.allowLocalModels,
      }).catch(() => {
        // Error stored in state, don't throw
      });
    }
  }

  /**
   * Toggle between default and smrt modes
   */
  toggleMode(): void {
    const newMode = this._state.mode === 'default' ? 'smrt' : 'default';
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

  // === User/Auth Methods ===

  /**
   * Set the current user and permissions
   * Called by SmrtProvider when user prop changes
   */
  setUser(user: User | null, permissions: string[] = []): void {
    this._state.session.user = user;
    this._state.session.isAuthenticated = user !== null;
    this._state.session.permissions = permissions;
  }

  // === Socket Methods ===

  /**
   * Connect to a WebSocket server
   */
  connectSocket(config: SocketConfig): void {
    // Disconnect existing socket if any
    this.disconnectSocket();

    this._socketConfig = config;
    this._state.socket.status = 'connecting';
    this._state.socket.lastError = null;

    try {
      this._socket = new WebSocket(config.url);

      this._socket.onopen = () => {
        this._state.socket.status = 'connected';
        this._state.socket.reconnectAttempts = 0;
        config.onOpen?.();
      };

      this._socket.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          config.onMessage?.(data);
        } catch {
          // If not JSON, pass raw data
          config.onMessage?.(event.data);
        }
      };

      this._socket.onclose = (event) => {
        this._state.socket.status = 'disconnected';
        config.onClose?.(event);

        // Attempt reconnection if enabled and not a clean close
        if (!event.wasClean && config.reconnect?.enabled !== false) {
          this.scheduleReconnect();
        }
      };

      this._socket.onerror = (event) => {
        this._state.socket.lastError = event;
        config.onError?.(event);
      };
    } catch (error) {
      this._state.socket.status = 'disconnected';
      this._state.socket.lastError = error as Event;
    }
  }

  /**
   * Disconnect from the WebSocket server
   */
  disconnectSocket(): void {
    // Clear any pending reconnect
    if (this._reconnectTimeout) {
      clearTimeout(this._reconnectTimeout);
      this._reconnectTimeout = null;
    }

    if (this._socket) {
      this._socket.close();
      this._socket = null;
    }

    this._state.socket.status = 'disconnected';
  }

  /**
   * Send a message through the WebSocket
   */
  sendMessage(data: unknown): void {
    if (this._socket?.readyState === WebSocket.OPEN) {
      this._socket.send(JSON.stringify(data));
    } else {
      console.warn('[Socket] Cannot send message - socket not connected');
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff
   */
  private scheduleReconnect(): void {
    if (!this._socketConfig) return;

    const { reconnect } = this._socketConfig;
    const maxAttempts = reconnect?.maxAttempts ?? 5;
    const baseDelay = reconnect?.baseDelay ?? 1000;

    if (this._state.socket.reconnectAttempts >= maxAttempts) {
      console.warn('[Socket] Max reconnection attempts reached');
      return;
    }

    this._state.socket.status = 'reconnecting';
    this._state.socket.reconnectAttempts++;

    // Exponential backoff: baseDelay * 2^attempts (capped at 30s)
    const delay = Math.min(
      baseDelay * 2 ** (this._state.socket.reconnectAttempts - 1),
      30000,
    );

    console.log(
      `[Socket] Reconnecting in ${delay}ms (attempt ${this._state.socket.reconnectAttempts}/${maxAttempts})`,
    );

    this._reconnectTimeout = setTimeout(() => {
      if (this._socketConfig) {
        this.connectSocket(this._socketConfig);
      }
    }, delay);
  }

  // === STT Methods ===

  /**
   * Initialize STT adapter
   * Uses warm client cache to avoid re-downloading models
   */
  async initializeSTT(options?: GetSTTOptions): Promise<STTAdapter> {
    const requestedType = (options?.type ?? 'browser-speech') as STTType;

    // Check warm client cache first
    const cached = getCachedSTT(requestedType);
    if (cached && cached.initState === 'ready') {
      // Restore cached adapter to state
      this._state.ai.stt.adapter = cached.adapter;
      this._state.ai.stt.initState = 'ready';
      this._state.ai.stt.error = null;
      this.subscribeToSTTEvents(cached.adapter);
      return cached.adapter;
    }

    // Check if we have a different adapter type loaded
    const currentAdapter = this._state.ai.stt.adapter;
    if (currentAdapter && this._state.ai.stt.initState === 'ready') {
      if (currentAdapter.type === requestedType) {
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

    // Update cache state for tracking
    updateSTTCacheState(requestedType, { initState: 'initializing' });

    const onProgress: OnProgress = (progress) => {
      this._state.ai.stt.downloadProgress = progress;
      updateSTTCacheState(requestedType, { downloadProgress: progress });

      // Update overall loading progress
      if (progress.percent > 0) {
        this.updateLoadingState({
          overallProgress: progress.percent,
        });
      }
    };

    try {
      const adapter = await getSTT(options);
      await adapter.ensureInitialized(onProgress);

      // Cache the adapter for future use
      setCachedSTT(requestedType, adapter, 'ready');

      this._state.ai.stt.adapter = adapter;
      this._state.ai.stt.initState = 'ready';
      this._state.ai.stt.downloadProgress = null;

      this.subscribeToSTTEvents(adapter);

      return adapter;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this._state.ai.stt.initState = 'error';
      this._state.ai.stt.error = err;
      updateSTTCacheState(requestedType, { initState: 'error', error: err });
      throw error;
    }
  }

  /**
   * Subscribe to STT adapter events.
   *
   * Captures every unsubscribe handle the adapter returns and stores a single
   * teardown both per-manager (called on dispose()) and at module scope keyed
   * by adapter identity. Because warm adapters are shared singletons, any
   * previous owner's listeners are torn down first — guaranteeing exactly one
   * live listener set per adapter, with the latest manager owning it (R1).
   */
  private subscribeToSTTEvents(adapter: STTAdapter): void {
    // Dedup: this manager already owns the adapter's subscription.
    if (this._sttSubscriptions.has(adapter)) {
      return;
    }

    // Evict any prior owner (e.g. a destroyed Provider that failed to dispose)
    // so the adapter never fires more than one manager's listeners.
    sttAdapterTeardowns.get(adapter)?.();

    const unsubs: Array<() => void> = [
      adapter.onResult((result) => {
        if (result.isFinal) {
          // Accumulate final results (continuous mode emits multiple phrases)
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
      }),
      adapter.onStart(() => {
        this._state.ai.stt.isListening = true;
      }),
      adapter.onEnd(() => {
        this._state.ai.stt.isListening = false;
      }),
      adapter.onError((error) => {
        this._state.ai.stt.error = error;
      }),
    ];

    const teardown = () => {
      for (const unsub of unsubs) {
        unsub();
      }
      this._sttSubscriptions.delete(adapter);
      if (sttAdapterTeardowns.get(adapter) === teardown) {
        sttAdapterTeardowns.delete(adapter);
      }
    };

    this._sttSubscriptions.set(adapter, teardown);
    sttAdapterTeardowns.set(adapter, teardown);
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
   * Uses warm client cache to avoid re-initialization
   */
  async initializeTTS(options?: GetTTSOptions): Promise<TTSAdapter> {
    const requestedType = (options?.type ?? 'browser-synthesis') as TTSType;

    // Check warm client cache first
    const cached = getCachedTTS(requestedType);
    if (cached && cached.initState === 'ready') {
      // Restore cached adapter to state
      this._state.ai.tts.adapter = cached.adapter;
      this._state.ai.tts.initState = 'ready';
      this._state.ai.tts.error = null;
      this.subscribeToTTSEvents(cached.adapter);
      return cached.adapter;
    }

    if (
      this._state.ai.tts.adapter &&
      this._state.ai.tts.initState === 'ready'
    ) {
      return this._state.ai.tts.adapter;
    }

    this._state.ai.tts.initState = 'initializing';
    this._state.ai.tts.error = null;

    // Update cache state for tracking
    updateTTSCacheState(requestedType, { initState: 'initializing' });

    const onProgress: OnProgress = (progress) => {
      this._state.ai.tts.downloadProgress = progress;
      updateTTSCacheState(requestedType, { downloadProgress: progress });
    };

    try {
      const adapter = await getTTS(options);
      await adapter.ensureInitialized(onProgress);

      // Cache the adapter for future use
      setCachedTTS(requestedType, adapter, 'ready');

      this._state.ai.tts.adapter = adapter;
      this._state.ai.tts.initState = 'ready';
      this._state.ai.tts.downloadProgress = null;

      this.subscribeToTTSEvents(adapter);

      return adapter;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this._state.ai.tts.initState = 'error';
      this._state.ai.tts.error = err;
      updateTTSCacheState(requestedType, { initState: 'error', error: err });
      throw error;
    }
  }

  /**
   * Subscribe to TTS adapter events.
   *
   * Mirrors {@link subscribeToSTTEvents}: captures unsubscribe handles, dedups
   * per-manager, and evicts any prior owner so a shared warm adapter never
   * pins more than one manager's `_state` proxy (R1).
   */
  private subscribeToTTSEvents(adapter: TTSAdapter): void {
    // Dedup: this manager already owns the adapter's subscription.
    if (this._ttsSubscriptions.has(adapter)) {
      return;
    }

    // Evict any prior owner so the adapter fires only this manager's listeners.
    ttsAdapterTeardowns.get(adapter)?.();

    const unsubs: Array<() => void> = [
      adapter.onStart(() => {
        this._state.ai.tts.isSpeaking = true;
        this._state.ai.tts.isPaused = false;
      }),
      adapter.onEnd(() => {
        this._state.ai.tts.isSpeaking = false;
        this._state.ai.tts.isPaused = false;
      }),
      adapter.onError((error) => {
        this._state.ai.tts.error = error;
        this._state.ai.tts.isSpeaking = false;
      }),
    ];

    const teardown = () => {
      for (const unsub of unsubs) {
        unsub();
      }
      this._ttsSubscriptions.delete(adapter);
      if (ttsAdapterTeardowns.get(adapter) === teardown) {
        ttsAdapterTeardowns.delete(adapter);
      }
    };

    this._ttsSubscriptions.set(adapter, teardown);
    ttsAdapterTeardowns.set(adapter, teardown);
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
   * Uses warm client cache to avoid re-downloading models
   */
  async initializeLLM(
    modelId?: string,
    options?: GetLLMOptions,
  ): Promise<LLMAdapter> {
    const requestedType = (options?.type ?? 'webllm') as LLMType;

    // Check warm client cache first
    const cached = getCachedLLM(requestedType, modelId);
    if (cached && cached.initState === 'ready') {
      // Restore cached adapter to state
      this._state.ai.llm.adapter = cached.adapter;
      this._state.ai.llm.initState = 'ready';
      this._state.ai.llm.currentModel = cached.adapter.currentModel;
      this._state.ai.llm.error = null;
      return cached.adapter;
    }

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

    // Update cache state for tracking
    updateLLMCacheState(requestedType, modelId, { initState: 'initializing' });

    const onProgress: OnProgress = (progress) => {
      this._state.ai.llm.downloadProgress = progress;
      updateLLMCacheState(requestedType, modelId, {
        downloadProgress: progress,
      });

      // Update overall loading progress
      if (progress.percent > 0) {
        this.updateLoadingState({
          overallProgress: progress.percent,
        });
      }
    };

    try {
      const adapter = await getLLM(options);
      await adapter.ensureInitialized(modelId, onProgress);

      // Cache the adapter for future use
      setCachedLLM(requestedType, adapter, modelId, 'ready');

      this._state.ai.llm.adapter = adapter;
      this._state.ai.llm.initState = 'ready';
      this._state.ai.llm.currentModel = adapter.currentModel;
      this._state.ai.llm.downloadProgress = null;

      return adapter;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this._state.ai.llm.initState = 'error';
      this._state.ai.llm.error = err;
      updateLLMCacheState(requestedType, modelId, {
        initState: 'error',
        error: err,
      });
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
    const adapter = this._state.ai.llm.adapter;
    await adapter?.unloadModel();

    // Downgrade (or remove) the warm-cache entry for the unloaded model so a
    // later initializeLLM() re-runs ensureInitialized() — re-downloading and
    // reporting progress — instead of cache-hitting a `'ready'` entry whose
    // model is now gone (R2). `unloadModel()` keeps the adapter instance
    // reusable, so downgrade to `'uninitialized'` rather than dispose it.
    if (adapter) {
      updateLLMCacheState(adapter.type, adapter.currentModel ?? undefined, {
        initState: 'uninitialized',
        downloadProgress: null,
        error: null,
      });
    }

    this._state.ai.llm.adapter = null;
    this._state.ai.llm.initState = 'uninitialized';
    this._state.ai.llm.currentModel = null;
  }

  // === Cleanup ===

  /**
   * Unsubscribe every adapter-event listener this manager owns (R1). Called on
   * dispose() so a destroyed Provider stops being pinned by the shared warm
   * adapters' module-surviving listener `Set`s.
   */
  private unsubscribeAllAdapterEvents(): void {
    for (const teardown of [...this._sttSubscriptions.values()]) {
      teardown();
    }
    for (const teardown of [...this._ttsSubscriptions.values()]) {
      teardown();
    }
    this._sttSubscriptions.clear();
    this._ttsSubscriptions.clear();
  }

  /**
   * Dispose of all resources
   */
  async dispose(): Promise<void> {
    // Cancel pending idle callback
    if (
      this._idleCallbackId !== null &&
      typeof cancelIdleCallback !== 'undefined'
    ) {
      cancelIdleCallback(this._idleCallbackId);
      this._idleCallbackId = null;
    }

    // Stop any in-flight preload so it can't write to a torn-down state (R3).
    this._preloadInFlight = false;

    // Disconnect socket
    this.disconnectSocket();

    // Remove this manager's adapter-event listeners (R1).
    this.unsubscribeAllAdapterEvents();

    // Adapter lifecycle is owned by the warm cache (it survives navigation by
    // design). For adapters this manager holds that the cache no longer tracks
    // — e.g. an instance orphaned by a mid-session type switch — dispose them
    // directly so they don't leak. Adapters still backed by a warm-cache entry
    // are left intact and genuinely `'ready'`; previously they were disposed
    // here yet left cached as `'ready'`, so the next init cache-hit restored a
    // dead engine with no download progress (R2). Full teardown remains
    // available via `clearAllCaches()`.
    //
    // NOTE: state adapters are `$state` proxies, so identity (`!==`) comparison
    // against the raw cached instance is unreliable (Svelte proxy-equality
    // gotcha). Gate on whether the cache *has* a live entry for the adapter's
    // type/model instead of comparing instances.
    const sttAdapter = this._state.ai.stt.adapter;
    if (sttAdapter && !getCachedSTT(sttAdapter.type as STTType)) {
      await sttAdapter.dispose?.();
    }
    const ttsAdapter = this._state.ai.tts.adapter;
    if (ttsAdapter && !getCachedTTS(ttsAdapter.type as TTSType)) {
      await ttsAdapter.dispose?.();
    }
    const llmAdapter = this._state.ai.llm.adapter;
    if (
      llmAdapter &&
      !getCachedLLM(llmAdapter.type, llmAdapter.currentModel ?? undefined)
    ) {
      await llmAdapter.dispose?.();
    }

    this._state = createInitialState();
  }

  /**
   * Check if AI is ready to use (all configured adapters loaded)
   */
  get isAIReady(): boolean {
    return (
      this._state.aiLoading.phase === 'ready' ||
      this._state.aiLoading.phase === 'idle'
    );
  }

  /**
   * Check if AI is currently loading
   */
  get isAILoading(): boolean {
    return (
      this._state.aiLoading.phase === 'checking' ||
      this._state.aiLoading.phase === 'downloading' ||
      this._state.aiLoading.phase === 'initializing'
    );
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
