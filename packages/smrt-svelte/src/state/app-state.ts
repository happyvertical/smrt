/**
 * App state types and initial state
 *
 * Framework-agnostic state shape - Svelte bindings are in app-state.svelte.ts
 */

import type {
  BrowserAICapabilities,
  DownloadProgress,
  InitState,
  LLMAdapter,
  STTAdapter,
  TTSAdapter,
} from '@happyvertical/browser-ai';
import type { User } from '@happyvertical/smrt-users';

// Re-export User type for convenience
export type { User } from '@happyvertical/smrt-users';

/**
 * App mode determines which features are enabled
 * - 'default': Standard components, no AI features
 * - 'smrt': AI-enhanced features enabled
 */
export type AppMode = 'default' | 'smrt';

/**
 * How the current mode was determined
 */
export type ModeSource = 'explicit' | 'auto' | 'toggled';

/**
 * User preferences for AI features
 */
export interface UserPreferences {
  /** Preferred STT backend */
  preferredSTT?: 'browser-speech' | 'whisper-cpp' | 'whisper-wasm';
  /** Preferred LLM backend */
  preferredLLM?: 'webllm' | 'transformers-llm';
  /** Default LLM model */
  defaultLLMModel?: string;
  /** Auto-enable smrt mode when available */
  autoEnableSmrt?: boolean;
}

/**
 * When to preload AI models
 *
 * - 'none': Don't preload, initialize on first use
 * - 'eager': Preload immediately when SmrtProvider mounts
 * - 'idle': Preload during browser idle time (requestIdleCallback)
 * - 'on-visible': Preload when a SMRT component becomes visible
 */
export type AIPreloadStrategy = 'none' | 'eager' | 'idle' | 'on-visible';

/**
 * STT adapter configuration
 */
export interface STTConfig {
  /** Which STT backend to use */
  type: 'browser-speech' | 'whisper-cpp' | 'whisper-wasm';
  /** Whisper model to use (for whisper-cpp/whisper-wasm) */
  model?: string;
  /** Whether to enable this adapter */
  enabled?: boolean;
  /**
   * Allow loading models from local /models/ path.
   * When false (default), models load from HuggingFace Hub CDN.
   */
  allowLocalModels?: boolean;
}

/**
 * TTS adapter configuration
 */
export interface TTSConfig {
  /** Which TTS backend to use */
  type: 'browser-synthesis';
  /** Preferred voice name */
  voice?: string;
  /** Whether to enable this adapter */
  enabled?: boolean;
}

/**
 * LLM adapter configuration
 */
export interface LLMConfig {
  /** Which LLM backend to use */
  type: 'webllm' | 'transformers-llm';
  /** Model to load */
  model?: string;
  /** Whether to enable this adapter */
  enabled?: boolean;
}

/**
 * Complete AI configuration for SmrtProvider.
 *
 * Configures preloading strategy and which AI adapters to initialize.
 * Uses a warm client cache to persist adapters across navigation.
 *
 * @example
 * ```svelte
 * <SmrtProvider
 *   ai={{
 *     preload: 'idle',
 *     stt: { type: 'whisper-cpp', model: 'tiny.en' },
 *     tts: { type: 'browser-synthesis' },
 *     llm: { type: 'webllm', model: 'Llama-3.1-8B-Instruct' },
 *     showLoadingOverlay: true,
 *     loadingMessage: 'Preparing AI...'
 *   }}
 * >
 * ```
 */
export interface AIConfig {
  /**
   * When to preload models.
   * - 'none': Don't preload, initialize on first use
   * - 'eager': Preload immediately when SmrtProvider mounts
   * - 'idle': Preload during browser idle time (recommended)
   * - 'on-visible': Preload when a SMRT AI component becomes visible
   * @default 'idle'
   */
  preload?: AIPreloadStrategy;
  /** STT (Speech-to-Text) configuration */
  stt?: STTConfig;
  /** TTS (Text-to-Speech) configuration */
  tts?: TTSConfig;
  /** LLM (Large Language Model) configuration */
  llm?: LLMConfig;
  /**
   * Show a loading overlay while models download.
   * The overlay shows progress and can be dismissed.
   * @default true
   */
  showLoadingOverlay?: boolean;
  /** Custom message to show in the loading overlay */
  loadingMessage?: string;
}

/**
 * Overall AI loading state for the loading overlay
 */
export type AILoadingPhase =
  | 'idle' // No preloading configured or complete
  | 'checking' // Checking what needs to be loaded
  | 'downloading' // Downloading models/WASM
  | 'initializing' // Initializing adapters
  | 'ready' // All configured adapters ready
  | 'error'; // At least one adapter failed

/**
 * AI loading state details
 */
export interface AILoadingState {
  /** Current loading phase */
  phase: AILoadingPhase;
  /** What's currently loading (e.g., 'whisper-cpp', 'webllm') */
  currentAdapter: string | null;
  /** Overall progress percentage (0-100) */
  overallProgress: number;
  /** Human-readable status message */
  message: string;
  /** Adapters that have been loaded */
  loaded: string[];
  /** Adapters that failed to load */
  failed: string[];
  /** Error if phase is 'error' */
  error: Error | null;
}

/**
 * User session information
 */
export interface UserSession {
  /** The smrt-users User object (null if not authenticated) */
  user: User | null;
  /** Whether user is authenticated (derived from user !== null) */
  isAuthenticated: boolean;
  /** Resolved permissions (from PermissionResolver) */
  permissions: string[];
  /** User preferences for AI features */
  preferences: UserPreferences;
}

/**
 * STT adapter state
 */
export interface STTState {
  /** The adapter instance */
  adapter: STTAdapter | null;
  /** Initialization state */
  initState: InitState;
  /** Download progress if initializing */
  downloadProgress: DownloadProgress | null;
  /** Whether currently listening */
  isListening: boolean;
  /** Last final transcribed text */
  lastResult: string;
  /** Current interim result (updates during speech) */
  interimResult: string;
  /** Last error */
  error: Error | null;
}

/**
 * TTS adapter state
 */
export interface TTSState {
  /** The adapter instance */
  adapter: TTSAdapter | null;
  /** Initialization state */
  initState: InitState;
  /** Download progress if initializing */
  downloadProgress: DownloadProgress | null;
  /** Whether currently speaking */
  isSpeaking: boolean;
  /** Whether paused */
  isPaused: boolean;
  /** Last error */
  error: Error | null;
}

/**
 * LLM adapter state
 */
export interface LLMState {
  /** The adapter instance */
  adapter: LLMAdapter | null;
  /** Initialization state */
  initState: InitState;
  /** Download progress if initializing */
  downloadProgress: DownloadProgress | null;
  /** Currently loaded model */
  currentModel: string | null;
  /** Whether currently generating */
  isGenerating: boolean;
  /** Last error */
  error: Error | null;
}

/**
 * All AI adapter states
 */
export interface AIState {
  stt: STTState;
  tts: TTSState;
  llm: LLMState;
}

/**
 * WebSocket connection status
 */
export type SocketStatus =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting';

/**
 * WebSocket reconnection settings
 */
export interface SocketReconnectConfig {
  /** Whether to automatically reconnect on disconnect (default: true) */
  enabled?: boolean;
  /** Maximum number of reconnection attempts (default: 5) */
  maxAttempts?: number;
  /** Base delay in ms for exponential backoff (default: 1000) */
  baseDelay?: number;
}

/**
 * WebSocket configuration
 */
export interface SocketConfig {
  /** WebSocket URL (wss:// or ws://) */
  url: string;
  /** Reconnection settings */
  reconnect?: SocketReconnectConfig;
  /** Called when connection opens */
  onOpen?: () => void;
  /** Called when a message is received */
  onMessage?: (data: unknown) => void;
  /** Called when connection closes */
  onClose?: (event: CloseEvent) => void;
  /** Called on connection error */
  onError?: (event: Event) => void;
}

/**
 * WebSocket connection state
 */
export interface SocketState {
  /** Current connection status */
  status: SocketStatus;
  /** Number of reconnection attempts made */
  reconnectAttempts: number;
  /** Last connection error */
  lastError: Event | null;
}

/**
 * Complete app state shape
 */
export interface SmrtAppState {
  /** Current app mode */
  mode: AppMode;
  /** How mode was determined */
  modeSource: ModeSource;
  /** User session */
  session: UserSession;
  /** Detected browser capabilities */
  capabilities: BrowserAICapabilities | null;
  /** AI adapter states */
  ai: AIState;
  /** AI loading state (for preload/overlay) */
  aiLoading: AILoadingState;
  /** WebSocket connection state */
  socket: SocketState;
  /** Global error */
  error: Error | null;
  /** Whether state has been initialized */
  initialized: boolean;
}

/**
 * Create initial app state
 */
export function createInitialState(): SmrtAppState {
  return {
    mode: 'default',
    modeSource: 'auto',
    session: {
      user: null,
      isAuthenticated: false,
      permissions: [],
      preferences: {},
    },
    capabilities: null,
    ai: {
      stt: {
        adapter: null,
        initState: 'uninitialized',
        downloadProgress: null,
        isListening: false,
        lastResult: '',
        interimResult: '',
        error: null,
      },
      tts: {
        adapter: null,
        initState: 'uninitialized',
        downloadProgress: null,
        isSpeaking: false,
        isPaused: false,
        error: null,
      },
      llm: {
        adapter: null,
        initState: 'uninitialized',
        downloadProgress: null,
        currentModel: null,
        isGenerating: false,
        error: null,
      },
    },
    aiLoading: {
      phase: 'idle',
      currentAdapter: null,
      overallProgress: 0,
      message: '',
      loaded: [],
      failed: [],
      error: null,
    },
    socket: {
      status: 'disconnected',
      reconnectAttempts: 0,
      lastError: null,
    },
    error: null,
    initialized: false,
  };
}

/**
 * Options for creating app state
 */
export interface CreateAppStateOptions {
  /** Initial mode (overrides auto-detection) */
  initialMode?: AppMode;
  /** Initial session data */
  session?: Partial<UserSession>;
  /** AI preloading and warm client configuration */
  ai?: AIConfig;
  /** Callback when capabilities are detected */
  onCapabilitiesDetected?: (caps: BrowserAICapabilities) => void;
  /** Callback when mode changes */
  onModeChange?: (mode: AppMode, source: ModeSource) => void;
  /** Callback when AI loading state changes */
  onAILoadingChange?: (state: AILoadingState) => void;
}
