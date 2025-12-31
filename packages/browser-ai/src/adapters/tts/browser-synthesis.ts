/**
 * Browser Speech Synthesis API adapter
 *
 * Uses the Web Speech API (SpeechSynthesis) available in most modern browsers.
 * No download required, works immediately.
 */

import { CapabilityNotAvailableError } from '../../core/errors.js';
import type { InitState, OnProgress } from '../../core/types.js';
import type {
  BrowserSynthesisTTSOptions,
  TTSAdapter,
  TTSCapabilities,
  TTSOptions,
  TTSVoice,
} from './types.js';

/**
 * Browser Speech Synthesis adapter
 */
export class BrowserSynthesisTTSAdapter implements TTSAdapter {
  readonly type = 'browser-synthesis' as const;

  private _initState: InitState = 'uninitialized';
  private synthesis: SpeechSynthesis | null = null;
  private options: BrowserSynthesisTTSOptions;
  private voices: SpeechSynthesisVoice[] = [];

  // Event listeners
  private startListeners = new Set<() => void>();
  private endListeners = new Set<() => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private boundaryListeners = new Set<
    (charIndex: number, charLength: number) => void
  >();

  constructor(options: BrowserSynthesisTTSOptions = {}) {
    this.options = {
      defaultLanguage: 'en-US',
      defaultRate: 1,
      defaultPitch: 1,
      defaultVolume: 1,
      ...options,
    };
  }

  get initState(): InitState {
    return this._initState;
  }

  async ensureInitialized(_onProgress?: OnProgress): Promise<void> {
    if (this._initState === 'ready') return;
    if (this._initState === 'initializing') {
      // Wait for existing initialization
      return new Promise((resolve, reject) => {
        const check = () => {
          if (this._initState === 'ready') resolve();
          else if (this._initState === 'error')
            reject(new Error('Initialization failed'));
          else setTimeout(check, 50);
        };
        check();
      });
    }

    this._initState = 'initializing';

    try {
      if (typeof window === 'undefined' || !window.speechSynthesis) {
        throw new CapabilityNotAvailableError(
          'Web Speech Synthesis API',
          'browser-synthesis',
        );
      }

      this.synthesis = window.speechSynthesis;

      // Load voices - they may load asynchronously
      await this.loadVoices();

      this._initState = 'ready';
    } catch (error) {
      this._initState = 'error';
      throw error;
    }
  }

  private async loadVoices(): Promise<void> {
    if (!this.synthesis) return;

    // Get voices - may be empty initially in some browsers
    this.voices = this.synthesis.getVoices();

    if (this.voices.length === 0) {
      // Wait for voices to load
      await new Promise<void>((resolve) => {
        const handleVoicesChanged = () => {
          this.voices = this.synthesis?.getVoices();
          if (this.voices.length > 0) {
            this.synthesis?.removeEventListener(
              'voiceschanged',
              handleVoicesChanged,
            );
            resolve();
          }
        };

        this.synthesis?.addEventListener('voiceschanged', handleVoicesChanged);

        // Timeout after 2 seconds - some browsers may not fire the event
        setTimeout(() => {
          this.voices = this.synthesis?.getVoices();
          resolve();
        }, 2000);
      });
    }
  }

  getCapabilities(): TTSCapabilities {
    return {
      voices: this.getVoices(),
      ssml: false, // Browser API doesn't support SSML
      rateRange: { min: 0.1, max: 10 },
      pitchRange: { min: 0, max: 2 },
      requiresDownload: false,
    };
  }

  getVoices(): TTSVoice[] {
    return this.voices.map((voice) => ({
      id: voice.voiceURI,
      name: voice.name,
      language: voice.lang,
      local: voice.localService,
      default: voice.default,
    }));
  }

  private findVoice(
    voiceNameOrId?: string,
    language?: string,
  ): SpeechSynthesisVoice | undefined {
    if (!voiceNameOrId && !language) {
      // Use default voice
      return this.voices.find((v) => v.default) || this.voices[0];
    }

    if (voiceNameOrId) {
      // Try to find by name or URI
      const voice = this.voices.find(
        (v) => v.name === voiceNameOrId || v.voiceURI === voiceNameOrId,
      );
      if (voice) return voice;
    }

    if (language) {
      // Find voice matching language
      const exactMatch = this.voices.find((v) => v.lang === language);
      if (exactMatch) return exactMatch;

      // Try language prefix match (e.g., 'en' matches 'en-US')
      const langPrefix = language.split('-')[0];
      const prefixMatch = this.voices.find((v) =>
        v.lang.startsWith(langPrefix),
      );
      if (prefixMatch) return prefixMatch;
    }

    // Fallback to default
    return this.voices.find((v) => v.default) || this.voices[0];
  }

  async speak(text: string, options: TTSOptions = {}): Promise<void> {
    await this.ensureInitialized();

    if (!this.synthesis) {
      throw new Error('Synthesis not initialized');
    }

    // Cancel any current speech
    this.stop();

    return new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(text);

      // Set voice
      const voice = this.findVoice(
        options.voice || this.options.defaultVoice,
        options.language || this.options.defaultLanguage,
      );
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      } else if (options.language) {
        utterance.lang = options.language;
      }

      // Set parameters
      utterance.rate = options.rate ?? this.options.defaultRate ?? 1;
      utterance.pitch = options.pitch ?? this.options.defaultPitch ?? 1;
      utterance.volume = options.volume ?? this.options.defaultVolume ?? 1;

      // Set up event handlers
      utterance.onstart = () => {
        for (const cb of this.startListeners) {
          cb();
        }
      };

      utterance.onend = () => {
        this.currentUtterance = null;
        for (const cb of this.endListeners) {
          cb();
        }
        resolve();
      };

      utterance.onerror = (event) => {
        this.currentUtterance = null;
        const error = new Error(`Speech synthesis error: ${event.error}`);
        for (const cb of this.errorListeners) {
          cb(error);
        }
        reject(error);
      };

      utterance.onboundary = (event) => {
        for (const cb of this.boundaryListeners) {
          cb(event.charIndex, event.charLength || 1);
        }
      };

      this.currentUtterance = utterance;
      this.synthesis?.speak(utterance);
    });
  }

  stop(): void {
    if (this.synthesis) {
      this.synthesis.cancel();
      this.currentUtterance = null;
    }
  }

  pause(): void {
    if (this.synthesis) {
      this.synthesis.pause();
    }
  }

  resume(): void {
    if (this.synthesis) {
      this.synthesis.resume();
    }
  }

  isSpeaking(): boolean {
    return this.synthesis?.speaking ?? false;
  }

  isPaused(): boolean {
    return this.synthesis?.paused ?? false;
  }

  onStart(callback: () => void): () => void {
    this.startListeners.add(callback);
    return () => this.startListeners.delete(callback);
  }

  onEnd(callback: () => void): () => void {
    this.endListeners.add(callback);
    return () => this.endListeners.delete(callback);
  }

  onError(callback: (error: Error) => void): () => void {
    this.errorListeners.add(callback);
    return () => this.errorListeners.delete(callback);
  }

  onBoundary(
    callback: (charIndex: number, charLength: number) => void,
  ): () => void {
    this.boundaryListeners.add(callback);
    return () => this.boundaryListeners.delete(callback);
  }

  async dispose(): Promise<void> {
    this.stop();
    this.synthesis = null;
    this.voices = [];
    this.startListeners.clear();
    this.endListeners.clear();
    this.errorListeners.clear();
    this.boundaryListeners.clear();
    this._initState = 'uninitialized';
  }
}
