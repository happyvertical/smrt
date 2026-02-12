/**
 * Text-to-Speech adapter types
 */

import type { InitState, OnProgress } from '../../core/types.js';

/**
 * Voice information
 */
export interface TTSVoice {
  /** Voice identifier */
  id: string;
  /** Display name */
  name: string;
  /** Language code (BCP-47) */
  language: string;
  /** Whether this is a local voice */
  local: boolean;
  /** Whether this is the default voice */
  default: boolean;
}

/**
 * TTS synthesis options
 */
export interface TTSOptions {
  /** Voice to use (by id or name) */
  voice?: string;
  /** Language code (BCP-47) */
  language?: string;
  /** Speech rate (0.1 to 10, default 1) */
  rate?: number;
  /** Pitch (0 to 2, default 1) */
  pitch?: number;
  /** Volume (0 to 1, default 1) */
  volume?: number;
}

/**
 * TTS adapter capabilities
 */
export interface TTSCapabilities {
  /** Available voices */
  voices: TTSVoice[];
  /** Supports SSML markup */
  ssml: boolean;
  /** Supports rate adjustment */
  rateRange: { min: number; max: number };
  /** Supports pitch adjustment */
  pitchRange: { min: number; max: number };
  /** Requires download */
  requiresDownload: boolean;
}

/**
 * Browser Speech Synthesis adapter options
 */
export interface BrowserSynthesisTTSOptions {
  /** Default language */
  defaultLanguage?: string;
  /** Default voice name */
  defaultVoice?: string;
  /** Default rate */
  defaultRate?: number;
  /** Default pitch */
  defaultPitch?: number;
  /** Default volume */
  defaultVolume?: number;
}

/**
 * TTS adapter interface
 */
export interface TTSAdapter {
  /** Adapter type identifier */
  readonly type: 'browser-synthesis' | 'transformers';

  /** Current initialization state */
  readonly initState: InitState;

  /**
   * Ensure the adapter is initialized
   * @param onProgress Optional progress callback for downloads
   */
  ensureInitialized(onProgress?: OnProgress): Promise<void>;

  /**
   * Get adapter capabilities
   */
  getCapabilities(): TTSCapabilities;

  /**
   * Get available voices
   */
  getVoices(): TTSVoice[];

  /**
   * Speak text
   * @param text Text to speak
   * @param options Synthesis options
   * @returns Promise that resolves when speech is complete
   */
  speak(text: string, options?: TTSOptions): Promise<void>;

  /**
   * Stop current speech
   */
  stop(): void;

  /**
   * Pause current speech
   */
  pause(): void;

  /**
   * Resume paused speech
   */
  resume(): void;

  /**
   * Check if currently speaking
   */
  isSpeaking(): boolean;

  /**
   * Check if paused
   */
  isPaused(): boolean;

  /**
   * Register callback for when speech starts
   */
  onStart(callback: () => void): () => void;

  /**
   * Register callback for when speech ends
   */
  onEnd(callback: () => void): () => void;

  /**
   * Register callback for errors
   */
  onError(callback: (error: Error) => void): () => void;

  /**
   * Register callback for word boundary events
   */
  onBoundary(
    callback: (charIndex: number, charLength: number) => void,
  ): () => void;

  /**
   * Dispose of resources
   */
  dispose(): Promise<void>;
}
