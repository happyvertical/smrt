/**
 * @happyvertical/browser-ai
 *
 * Framework-agnostic browser AI capabilities with adapter pattern.
 * Provides STT, TTS, and LLM functionality with multiple backend options.
 */

// LLM adapters
export * from './adapters/llm/index.js';
// STT adapters
export * from './adapters/stt/index.js';
// TTS adapters
export * from './adapters/tts/index.js';
// Capability detection
export * from './capabilities/detector.js';
// Core types and errors
export * from './core/index.js';
