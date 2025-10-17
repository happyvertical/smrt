/**
 * Signal System - Universal Event Distribution
 *
 * Provides automatic method tracking and event distribution
 * for logging, metrics, pub/sub, and other observability needs.
 */

export type {
  SignalAdapter,
  Signal,
  SignalType,
} from '@smrt/types';
export { SignalBus } from './bus.js';
export type { SanitizationConfig } from './sanitizer.js';
export { SignalSanitizer } from './sanitizer.js';
