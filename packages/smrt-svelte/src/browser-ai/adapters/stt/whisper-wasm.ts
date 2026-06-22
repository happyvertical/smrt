/**
 * Whisper adapter using @xenova/transformers (v2)
 *
 * Uses Whisper models running in the browser via WASM.
 * V2 uses a simpler, more stable pipeline API.
 * Requires downloading model files (~40MB-150MB depending on model size).
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
  WhisperWasmSTTOptions,
} from './types.js';

// Model IDs - using Xenova's quantized models for v2
const MODEL_IDS: Record<string, string> = {
  tiny: 'Xenova/whisper-tiny.en',
  base: 'Xenova/whisper-base.en',
  small: 'Xenova/whisper-small.en',
};

// Approximate download sizes
const MODEL_SIZES: Record<string, number> = {
  tiny: 40 * 1024 * 1024, // ~40MB
  base: 75 * 1024 * 1024, // ~75MB
  small: 150 * 1024 * 1024, // ~150MB
};

/**
 * Whisper adapter for high-accuracy speech recognition
 * Uses transformers.js v2 pipeline API
 */
export class WhisperWasmSTTAdapter implements STTAdapter {
  readonly type = 'whisper-wasm' as const;

  private _initState: InitState = 'uninitialized';
  private options: WhisperWasmSTTOptions;
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

  // Transformers.js v2 pipeline
  private transcriber: any = null;

  // Promise that resolves when transcription is complete
  private processingPromise: Promise<void> | null = null;
  private processingResolve: (() => void) | null = null;

  constructor(options: Partial<WhisperWasmSTTOptions> = {}) {
    this.options = {
      type: 'whisper-wasm',
      modelSize: 'tiny',
      defaultLanguage: 'en',
      ...options,
    } as WhisperWasmSTTOptions;
  }

  get initState(): InitState {
    return this._initState;
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
        throw new CapabilityNotAvailableError('WebAssembly', 'whisper-wasm');
      }

      const modelSize = this.options.modelSize || 'tiny';
      const modelId = MODEL_IDS[modelSize] || MODEL_IDS.tiny;
      const totalSize = MODEL_SIZES[modelSize] || MODEL_SIZES.tiny;

      onProgress?.({
        state: 'downloading',
        bytesLoaded: 0,
        bytesTotal: totalSize,
        percent: 0,
        currentFile: `${modelId}`,
      });

      // Dynamically import transformers.js v2
      const transformers = await this.importTransformers();
      const { pipeline } = transformers;

      console.log('[Whisper v2] Loading pipeline...');

      // Create ASR pipeline - v2 uses simpler API
      this.transcriber = await pipeline(
        'automatic-speech-recognition',
        modelId,
        {
          progress_callback: (progress: any) => {
            if (
              progress.status === 'progress' &&
              progress.progress !== undefined
            ) {
              const percent = Math.round(progress.progress);
              onProgress?.({
                state: 'downloading',
                bytesLoaded: Math.round((totalSize * percent) / 100),
                bytesTotal: totalSize,
                percent,
                currentFile: progress.file || modelId,
              });
            }
          },
        },
      );

      console.log('[Whisper v2] Pipeline loaded successfully');

      onProgress?.({
        state: 'complete',
        bytesLoaded: totalSize,
        bytesTotal: totalSize,
        percent: 100,
      });

      this._initState = 'ready';
    } catch (error) {
      this._initState = 'error';
      console.error('[Whisper v2] Initialization error:', error);
      throw error instanceof Error
        ? error
        : new InitializationError('whisper-wasm', String(error));
    }
  }

  // Store the transformers module for read_audio utility
  private transformersModule: any = null;

  private async importTransformers(): Promise<any> {
    try {
      // Try v2 (@xenova/transformers) first
      this.transformersModule = await importOptional('@xenova/transformers');
      this.configureTransformersEnv(this.transformersModule);
      return this.transformersModule;
    } catch {
      try {
        // Fall back to v3 (@huggingface/transformers)
        this.transformersModule = await importOptional(
          '@huggingface/transformers',
        );
        this.configureTransformersEnv(this.transformersModule);
        return this.transformersModule;
      } catch {
        throw new InitializationError(
          'whisper-wasm',
          'Neither @xenova/transformers nor @huggingface/transformers installed.',
        );
      }
    }
  }

  /**
   * Configure transformers.js environment settings
   */
  private configureTransformersEnv(transformers: any): void {
    if (transformers.env) {
      // Default to remote models unless explicitly allowing local
      const allowLocal = this.options.allowLocalModels ?? false;
      transformers.env.allowLocalModels = allowLocal;

      // Always use browser cache for better performance
      transformers.env.useBrowserCache = true;

      console.log('[Whisper v2] Configured env:', {
        allowLocalModels: allowLocal,
        useBrowserCache: true,
      });
    }
  }

  getCapabilities(): STTCapabilities {
    const modelSize = this.options.modelSize || 'tiny';

    return {
      continuous: false, // Whisper processes chunks, not continuous
      interimResults: false, // No interim results in standard Whisper
      languages: [
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
      accuracy: modelSize === 'tiny' ? 'medium' : 'high',
      requiresDownload: true,
      downloadSize: MODEL_SIZES[modelSize] || MODEL_SIZES.tiny,
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
          sampleRate: 16000, // Whisper expects 16kHz
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

      // Create promise that resolves when transcription is done
      this.processingPromise = new Promise((resolve) => {
        this.processingResolve = resolve;
      });

      // Start with timeslice to capture audio in chunks (more reliable)
      this.mediaRecorder.start(500);
      this._isListening = true;
      for (const cb of this.startListeners) {
        cb();
      }
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

    return 'audio/webm'; // Fallback
  }

  private async processRecording(): Promise<void> {
    console.log(
      '[Whisper v2] processRecording called, chunks:',
      this.audioChunks.length,
    );

    if (this.audioChunks.length === 0) {
      console.log('[Whisper v2] No audio chunks captured');
      return;
    }

    // Use the actual MIME type from the recorder
    const mimeType = this.mediaRecorder?.mimeType || 'audio/webm';
    const audioBlob = new Blob(this.audioChunks, { type: mimeType });
    console.log(
      '[Whisper v2] Audio blob size:',
      audioBlob.size,
      'type:',
      mimeType,
    );

    try {
      if (!this.transcriber || !this.transformersModule) {
        throw new Error('Whisper not initialized');
      }

      // Decode audio using Web Audio API for better format support
      console.log('[Whisper v2] Decoding audio with Web Audio API...');
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      // Get mono audio data
      const audioData = audioBuffer.getChannelData(0);
      console.log(
        '[Whisper v2] Audio decoded - length:',
        audioData.length,
        'samples, duration:',
        audioBuffer.duration.toFixed(2),
        's',
      );

      // Debug: check audio levels
      let maxLevel = 0;
      let sumSquares = 0;
      for (let i = 0; i < audioData.length; i++) {
        const abs = Math.abs(audioData[i]);
        if (abs > maxLevel) maxLevel = abs;
        sumSquares += audioData[i] * audioData[i];
      }
      const rms = Math.sqrt(sumSquares / audioData.length);
      console.log(
        '[Whisper v2] Audio levels - max:',
        maxLevel.toFixed(4),
        'RMS:',
        rms.toFixed(4),
      );

      if (maxLevel < 0.01) {
        console.warn('[Whisper v2] Audio appears to be silent or very quiet!');
      }

      // Close audio context
      await audioContext.close();

      console.log('[Whisper v2] Starting transcription...');
      const startTime = performance.now();

      // Pass the Float32Array audio data
      const result = await this.transcriber(audioData);

      const elapsedTime = performance.now() - startTime;
      console.log(
        '[Whisper v2] Transcription completed in',
        Math.round(elapsedTime),
        'ms',
      );
      console.log('[Whisper v2] Result:', result);

      const text = result.text?.trim() || '';
      console.log('[Whisper v2] Transcription result:', text);

      const sttResult: STTResult = {
        text,
        confidence: 0.95,
        isFinal: true,
        timestamp: Date.now(),
      };

      for (const cb of this.resultListeners) {
        cb(sttResult);
      }
    } catch (error) {
      console.error('[Whisper v2] Processing error:', error);
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
    this.transcriber = null;
    this.transformersModule = null;
    this.resultListeners.clear();
    this.errorListeners.clear();
    this.startListeners.clear();
    this.endListeners.clear();
    this._initState = 'uninitialized';
  }
}
