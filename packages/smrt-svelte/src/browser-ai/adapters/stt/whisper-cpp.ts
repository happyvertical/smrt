/**
 * Whisper.cpp adapter using @remotion/whisper-web
 *
 * Uses whisper.cpp compiled to WASM for high-accuracy speech recognition.
 * More stable than transformers.js implementation.
 */

import { importOptional } from '@happyvertical/smrt-ui/utils/import-optional.js';
import {
  CapabilityNotAvailableError,
  InitializationError,
} from '../../core/errors.js';
import type { InitState, OnProgress } from '../../core/types.js';
import type {
  STTAdapter,
  STTCapabilities,
  STTOptions,
  STTResult,
  WhisperCppSTTOptions,
} from './types.js';

// Model download sizes (approximate)
const MODEL_SIZES: Record<string, number> = {
  'tiny.en': 75 * 1024 * 1024,
  'base.en': 142 * 1024 * 1024,
  'small.en': 466 * 1024 * 1024,
  tiny: 75 * 1024 * 1024,
  base: 142 * 1024 * 1024,
  small: 466 * 1024 * 1024,
};

type WhisperModel =
  | 'tiny.en'
  | 'base.en'
  | 'small.en'
  | 'tiny'
  | 'base'
  | 'small';

/**
 * Minimal structural type for the subset of `@remotion/whisper-web`'s API
 * this adapter touches. The package is an optional peer dependency loaded
 * via `importOptional`, so its full types aren't pulled into this module's
 * surface — this local describes only the shapes consumed here.
 */
interface WhisperWebModule {
  canUseWhisperWeb(
    model: string,
  ): Promise<{ supported: boolean; error?: string }>;
  downloadWhisperModel(params: {
    model: string;
    onProgress?: (progress: { progress: number }) => void;
  }): Promise<unknown>;
  resampleTo16Khz(params: {
    file: File;
    onProgress?: (progress: number) => void;
  }): Promise<{ channelWaveform?: Float32Array } & Record<string, unknown>>;
  transcribe(params: {
    channelWaveform: unknown;
    model: string;
    onProgress?: (progress: number) => void;
  }): Promise<{ transcription: Array<{ text: string }> }>;
}

/**
 * Whisper.cpp adapter for high-accuracy speech recognition
 */
export class WhisperCppSTTAdapter implements STTAdapter {
  readonly type = 'whisper-cpp' as const;

  private _initState: InitState = 'uninitialized';
  private options: WhisperCppSTTOptions;
  private _isListening = false;

  // Audio recording
  private mediaRecorder: MediaRecorder | null = null;
  private audioChunks: Blob[] = [];
  private stream: MediaStream | null = null;

  // Event listeners
  private resultListeners = new Set<(result: STTResult) => void>();
  private errorListeners = new Set<(error: Error) => void>();
  private startListeners = new Set<() => void>();
  private endListeners = new Set<() => void>();

  // @remotion/whisper-web module
  private whisperWeb: WhisperWebModule | null = null;
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: Used in init/dispose
  private modelDownloaded = false;

  // Promise that resolves when transcription is complete
  private processingPromise: Promise<void> | null = null;
  private processingResolve: (() => void) | null = null;

  constructor(options: Partial<WhisperCppSTTOptions> = {}) {
    this.options = {
      type: 'whisper-cpp',
      model: 'tiny.en',
      ...options,
    } as WhisperCppSTTOptions;
  }

  get initState(): InitState {
    return this._initState;
  }

  private get model(): WhisperModel {
    return this.options.model || 'tiny.en';
  }

  async ensureInitialized(onProgress?: OnProgress): Promise<void> {
    if (this._initState === 'ready') return;
    if (this._initState === 'initializing') {
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
      // Check WASM support
      if (typeof WebAssembly === 'undefined') {
        throw new CapabilityNotAvailableError('WebAssembly', 'whisper-cpp');
      }

      const totalSize = MODEL_SIZES[this.model] || MODEL_SIZES['tiny.en'];

      onProgress?.({
        state: 'downloading',
        bytesLoaded: 0,
        bytesTotal: totalSize,
        percent: 0,
        currentFile: `whisper-${this.model}`,
      });

      // Dynamically import @remotion/whisper-web
      this.whisperWeb = await this.importWhisperWeb();

      // Check cross-origin isolation first
      const isCrossOriginIsolated =
        typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated;
      console.log('[WhisperCpp] crossOriginIsolated:', isCrossOriginIsolated);

      if (!isCrossOriginIsolated) {
        throw new CapabilityNotAvailableError(
          'Cross-origin isolation required. Add headers: Cross-Origin-Opener-Policy: same-origin, Cross-Origin-Embedder-Policy: require-corp',
          'whisper-cpp',
        );
      }

      // Check if whisper-web is supported
      const { supported, error } = await this.whisperWeb.canUseWhisperWeb(
        this.model,
      );
      console.log('[WhisperCpp] canUseWhisperWeb:', { supported, error });
      if (!supported) {
        throw new CapabilityNotAvailableError(
          error || 'whisper-web not supported in this browser',
          'whisper-cpp',
        );
      }

      // Download the model
      await this.whisperWeb.downloadWhisperModel({
        model: this.model,
        onProgress: (progress: { progress: number }) => {
          const percent = Math.round(progress.progress * 100);
          onProgress?.({
            state: 'downloading',
            bytesLoaded: Math.round((totalSize * percent) / 100),
            bytesTotal: totalSize,
            percent,
            currentFile: `whisper-${this.model}`,
          });
        },
      });

      this.modelDownloaded = true;

      onProgress?.({
        state: 'complete',
        bytesLoaded: totalSize,
        bytesTotal: totalSize,
        percent: 100,
      });

      this._initState = 'ready';
      console.log('[WhisperCpp] Initialized successfully');
    } catch (error) {
      this._initState = 'error';
      console.error('[WhisperCpp] Initialization error:', error);
      throw error instanceof Error
        ? error
        : new InitializationError('whisper-cpp', String(error));
    }
  }

  private async importWhisperWeb(): Promise<WhisperWebModule> {
    try {
      return await importOptional<WhisperWebModule>('@remotion/whisper-web');
    } catch {
      throw new InitializationError(
        'whisper-cpp',
        '@remotion/whisper-web not installed. Run: npm install @remotion/whisper-web',
      );
    }
  }

  getCapabilities(): STTCapabilities {
    return {
      continuous: false,
      interimResults: false,
      languages: this.model.endsWith('.en')
        ? ['en']
        : [
            'en',
            'es',
            'fr',
            'de',
            'it',
            'pt',
            'nl',
            'pl',
            'ru',
            'zh',
            'ja',
            'ko',
            'ar',
            'hi',
            'tr',
            'vi',
            'th',
          ],
      accuracy: this.model.includes('small') ? 'high' : 'medium',
      requiresDownload: true,
      downloadSize: MODEL_SIZES[this.model] || MODEL_SIZES['tiny.en'],
    };
  }

  async start(_options: STTOptions = {}): Promise<void> {
    await this.ensureInitialized();

    if (this._isListening) return;

    try {
      // Get microphone access
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
        },
      });

      this.audioChunks = [];

      // Create MediaRecorder
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType: this.getSupportedMimeType(),
      });

      this.mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          this.audioChunks.push(event.data);
        }
      };

      this.mediaRecorder.onstop = async () => {
        await this.processRecording();
        this.processingResolve?.();
      };

      this.processingPromise = new Promise((resolve) => {
        this.processingResolve = resolve;
      });

      this.mediaRecorder.start();
      this._isListening = true;
      for (const cb of this.startListeners) {
        cb();
      }
      console.log('[WhisperCpp] Started recording');
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      for (const cb of this.errorListeners) {
        cb(err);
      }
      throw err;
    }
  }

  private getSupportedMimeType(): string {
    const types = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];

    for (const type of types) {
      if (MediaRecorder.isTypeSupported(type)) {
        return type;
      }
    }

    return 'audio/webm';
  }

  private async processRecording(): Promise<void> {
    console.log(
      '[WhisperCpp] Processing recording, chunks:',
      this.audioChunks.length,
    );

    if (this.audioChunks.length === 0) {
      console.log('[WhisperCpp] No audio chunks captured');
      return;
    }

    const audioBlob = new Blob(this.audioChunks, { type: 'audio/webm' });
    console.log('[WhisperCpp] Audio blob size:', audioBlob.size);

    try {
      if (!this.whisperWeb) {
        throw new Error('whisper-web not initialized');
      }

      // Convert blob to File for resampleTo16Khz
      const audioFile = new File([audioBlob], 'recording.webm', {
        type: audioBlob.type,
      });

      // Resample to 16kHz as required by Whisper
      console.log('[WhisperCpp] Resampling audio...');
      const resampleResult = await this.whisperWeb.resampleTo16Khz({
        file: audioFile,
        onProgress: (p: number) =>
          console.log('[WhisperCpp] Resample progress:', p),
      });
      console.log('[WhisperCpp] Resample result:', resampleResult);
      console.log(
        '[WhisperCpp] Resample result keys:',
        Object.keys(resampleResult),
      );

      // Handle different possible return structures
      const channelWaveform = resampleResult.channelWaveform ?? resampleResult;
      console.log('[WhisperCpp] Resampled, samples:', channelWaveform?.length);

      // Transcribe
      console.log('[WhisperCpp] Starting transcription...');
      const { transcription } = await this.whisperWeb.transcribe({
        channelWaveform,
        model: this.model,
        onProgress: (p: number) =>
          console.log('[WhisperCpp] Transcribe progress:', p),
      });

      console.log('[WhisperCpp] Transcription result:', transcription);

      // Extract text from transcription segments
      const text = transcription
        .map((segment: { text: string }) => segment.text)
        .join(' ')
        .trim();

      const result: STTResult = {
        text,
        confidence: 0.95,
        isFinal: true,
        timestamp: Date.now(),
      };

      for (const cb of this.resultListeners) {
        cb(result);
      }
    } catch (error) {
      console.error('[WhisperCpp] Processing error:', error);
      const err = error instanceof Error ? error : new Error(String(error));
      for (const cb of this.errorListeners) {
        cb(err);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.mediaRecorder && this._isListening) {
      this.mediaRecorder.stop();

      if (this.stream) {
        for (const track of this.stream.getTracks()) {
          track.stop();
        }
      }
      this.stream = null;

      if (this.processingPromise) {
        await this.processingPromise;
        this.processingPromise = null;
        this.processingResolve = null;
      }

      this._isListening = false;
      for (const cb of this.endListeners) {
        cb();
      }
      console.log('[WhisperCpp] Stopped recording');
    }
  }

  abort(): void {
    if (this.mediaRecorder && this._isListening) {
      this.mediaRecorder.stop();
      this._isListening = false;
      this.audioChunks = [];

      if (this.stream) {
        for (const track of this.stream.getTracks()) {
          track.stop();
        }
      }
      this.stream = null;

      for (const cb of this.endListeners) {
        cb();
      }
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
    this.whisperWeb = null;
    this.modelDownloaded = false;
    this.resultListeners.clear();
    this.errorListeners.clear();
    this.startListeners.clear();
    this.endListeners.clear();
    this._initState = 'uninitialized';
  }
}
