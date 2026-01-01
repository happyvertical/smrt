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

  // Socket management
  private _socket: WebSocket | null = null;
  private _socketConfig: SocketConfig | null = null;
  private _reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

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

    // Schedule AI preloading based on strategy
    this.schedulePreload();
  }

  // === AI Preloading Methods ===

  /**
   * Set or update AI configuration
   */
  setAIConfig(config: AIConfig): void {
    this._aiConfig = config;
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
   * Execute the preloading of configured adapters
   */
  private async executePreload(): Promise<void> {
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
      this.updateLoadingState({ phase: 'idle' });
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
          await this.initializeSTT({ type: type as STTType });
        } else if (category === 'tts') {
          await this.initializeTTS({ type: type as TTSType });
        } else if (category === 'llm') {
          const llmConfig = this._aiConfig.llm!;
          await this.initializeLLM(llmConfig.model, { type: llmConfig.type });
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
   * Subscribe to STT adapter events
   */
  private subscribeToSTTEvents(adapter: STTAdapter): void {
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
   * Subscribe to TTS adapter events
   */
  private subscribeToTTSEvents(adapter: TTSAdapter): void {
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
    // Cancel pending idle callback
    if (
      this._idleCallbackId !== null &&
      typeof cancelIdleCallback !== 'undefined'
    ) {
      cancelIdleCallback(this._idleCallbackId);
      this._idleCallbackId = null;
    }

    // Disconnect socket
    this.disconnectSocket();

    // Dispose AI adapters (but don't clear the cache - they survive navigation)
    await this._state.ai.stt.adapter?.dispose();
    await this._state.ai.tts.adapter?.dispose();
    await this._state.ai.llm.adapter?.dispose();

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
