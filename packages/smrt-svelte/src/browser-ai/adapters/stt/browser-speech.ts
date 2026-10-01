/// <reference path="../../../../web-speech.d.ts" />

/**
 * Browser Speech Recognition API adapter
 *
 * Uses the Web Speech API (SpeechRecognition) available in most modern browsers.
 * No download required, works immediately.
 */

import {
  CapabilityNotAvailableError,
  PermissionDeniedError,
} from '../../core/errors.js';
import type { InitState, OnProgress } from '../../core/types.js';
import type {
  BrowserSpeechSTTOptions,
  STTAdapter,
  STTCapabilities,
  STTOptions,
  STTResult,
} from './types.js';

/**
 * Get the SpeechRecognition constructor (handles vendor prefix)
 */
function getSpeechRecognition(): typeof SpeechRecognition | null {
  if (typeof window === 'undefined') return null;

  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/**
 * An error from the browser's speech recognition. `speechError` is the Web
 * Speech error code (`network`, `not-allowed`, `service-not-allowed`,
 * `no-speech`, `audio-capture`, `aborted`, `language-not-supported`, …).
 */
export type BrowserSpeechError = Error & {
  speechError?: string;
  speechMessage?: string;
};

/**
 * Browser Speech Recognition adapter
 */
export class BrowserSpeechSTTAdapter implements STTAdapter {
  readonly type = 'browser-speech' as const;

  private _initState: InitState = 'uninitialized';
  private recognition: SpeechRecognition | null = null;
  private options: BrowserSpeechSTTOptions;
  private _isListening = false;
  /** Set while our own `abort()` runs, so its `aborted` error is not reported. */
  private aborting = false;

  // Event listeners
  private resultListeners = new Set<(result: STTResult) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private startListeners = new Set<() => void>();
  private endListeners = new Set<() => void>();

  constructor(options: BrowserSpeechSTTOptions = {}) {
    this.options = {
      defaultLanguage: 'en-US',
      maxAlternatives: 3,
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
      const SpeechRecognitionCtor = getSpeechRecognition();

      if (!SpeechRecognitionCtor) {
        throw new CapabilityNotAvailableError(
          'Web Speech API (SpeechRecognition)',
          'browser-speech',
        );
      }

      this.recognition = new SpeechRecognitionCtor();
      this.setupRecognitionHandlers();

      this._initState = 'ready';
    } catch (error) {
      this._initState = 'error';
      throw error;
    }
  }

  private setupRecognitionHandlers(): void {
    if (!this.recognition) return;

    this.recognition.onresult = (event: SpeechRecognitionEvent) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const sttResult: STTResult = {
          text: result[0].transcript,
          confidence: result[0].confidence,
          isFinal: result.isFinal,
          timestamp: Date.now(),
          alternatives: Array.from(
            { length: result.length },
            (_, index) => result[index],
          )
            .slice(1)
            .map((alt: SpeechRecognitionAlternative) => ({
              text: alt.transcript,
              confidence: alt.confidence,
            })),
        };

        for (const cb of this.resultListeners) {
          cb(sttResult);
        }
      }
    };

    this.recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      const code = event.error;
      if (code === 'aborted' && this.aborting) {
        // We called abort() ourselves: not an error.
        return;
      }
      let error: Error;

      switch (code) {
        case 'not-allowed':
        case 'service-not-allowed':
          error = new PermissionDeniedError('microphone', 'browser-speech');
          break;
        case 'no-speech':
          error = new Error('No speech detected');
          break;
        case 'audio-capture':
          error = new Error('Audio capture failed - check microphone');
          break;
        case 'network':
          error = new Error('Network error during speech recognition');
          break;
        case 'aborted':
          // Not our abort(): the browser (or another tab) cut it off.
          error = new Error('Speech recognition was aborted');
          break;
        default:
          error = new Error(`Speech recognition error: ${code}`);
      }
      // The Web Speech error code, so callers can tell `service-not-allowed`
      // (the browser has no speech service, e.g. Brave) from `not-allowed`
      // (the microphone is blocked), and `network` from everything else.
      (error as BrowserSpeechError).speechError = code;
      if (event.message)
        (error as BrowserSpeechError).speechMessage = event.message;

      for (const cb of this.errorListeners) {
        cb(error);
      }
    };

    this.recognition.onstart = () => {
      this._isListening = true;
      for (const cb of this.startListeners) {
        cb();
      }
    };

    this.recognition.onend = () => {
      this._isListening = false;
      this.aborting = false;
      for (const cb of this.endListeners) {
        cb();
      }
    };
  }

  getCapabilities(): STTCapabilities {
    return {
      continuous: true,
      interimResults: true,
      languages: [
        'en-US',
        'en-GB',
        'en-AU',
        'es-ES',
        'es-MX',
        'fr-FR',
        'fr-CA',
        'de-DE',
        'it-IT',
        'pt-BR',
        'pt-PT',
        'zh-CN',
        'zh-TW',
        'ja-JP',
        'ko-KR',
        // Many more supported, this is a subset
      ],
      accuracy: 'medium',
      requiresDownload: false,
    };
  }

  async start(options: STTOptions = {}): Promise<void> {
    await this.ensureInitialized();

    if (!this.recognition) {
      throw new Error('Recognition not initialized');
    }

    if (this._isListening) {
      return; // Already listening
    }

    // Configure recognition
    this.recognition.lang =
      options.language || this.options.defaultLanguage || 'en-US';
    this.recognition.continuous = options.continuous ?? false;
    this.recognition.interimResults = options.interimResults ?? true;
    this.recognition.maxAlternatives = this.options.maxAlternatives || 3;

    this.recognition.start();
  }

  async stop(): Promise<void> {
    if (this.recognition && this._isListening) {
      this.recognition.stop();
    }
  }

  abort(): void {
    if (this.recognition && this._isListening) {
      this.aborting = true;
      this.recognition.abort();
    }
  }

  isListening(): boolean {
    return this._isListening;
  }

  onResult(callback: (result: STTResult) => void): () => void {
    this.resultListeners.add(callback);
    return () => this.resultListeners.delete(callback);
  }

  onError(callback: (error: Error) => void): () => void {
    this.errorListeners.add(callback);
    return () => this.errorListeners.delete(callback);
  }

  onStart(callback: () => void): () => void {
    this.startListeners.add(callback);
    return () => this.startListeners.delete(callback);
  }

  onEnd(callback: () => void): () => void {
    this.endListeners.add(callback);
    return () => this.endListeners.delete(callback);
  }

  async dispose(): Promise<void> {
    this.abort();
    this.recognition = null;
    this.resultListeners.clear();
    this.errorListeners.clear();
    this.startListeners.clear();
    this.endListeners.clear();
    this._initState = 'uninitialized';
  }
}
