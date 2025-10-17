/**
 * Signal payload sanitization for security
 *
 * Prevents sensitive data (passwords, tokens, PII) from being leaked
 * into logs, metrics, or other signal outputs.
 */

import type { Signal } from '@smrt/types';

/**
 * Sanitization configuration
 */
export interface SanitizationConfig {
  /**
   * Keys to redact from signal payloads
   * Default: common sensitive fields
   */
  redactKeys?: string[];

  /**
   * Custom replacer function for sanitization
   * Return undefined to redact the value entirely
   */
  replacer?: (key: string, value: any) => any;

  /**
   * Replacement value for redacted fields
   * Default: '[REDACTED]'
   */
  redactedValue?: string;

  /**
   * Maximum number of stack trace lines to include in sanitized errors
   * Default: 10
   */
  maxStackLines?: number;
}

/**
 * Default sensitive keys to redact
 */
const DEFAULT_REDACT_KEYS = [
  'password',
  'passwd',
  'pwd',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'privateKey',
  'private_key',
  'authToken',
  'auth_token',
  'bearerToken',
  'bearer_token',
  'sessionId',
  'session_id',
  'ssn',
  'creditCard',
  'credit_card',
  'cvv',
  'pin',
];

/**
 * Signal sanitizer
 *
 * Removes or redacts sensitive data from signal payloads before
 * they are processed by adapters.
 */
export class SignalSanitizer {
  private config: Required<SanitizationConfig>;

  constructor(config: SanitizationConfig = {}) {
    this.config = {
      redactKeys: config.redactKeys ?? DEFAULT_REDACT_KEYS,
      replacer: config.replacer ?? this.defaultReplacer.bind(this),
      redactedValue: config.redactedValue ?? '[REDACTED]',
      maxStackLines: config.maxStackLines ?? 10,
    };
  }

  /**
   * Default replacer function
   *
   * Redacts sensitive keys and truncates long strings
   */
  private defaultReplacer(key: string, value: any): any {
    // Check if key should be redacted
    const lowerKey = key.toLowerCase();
    if (
      this.config.redactKeys.some((k) => lowerKey.includes(k.toLowerCase()))
    ) {
      return this.config.redactedValue;
    }

    // Truncate very long strings (potential data dumps)
    if (typeof value === 'string' && value.length > 1000) {
      return `${value.substring(0, 1000)}... [TRUNCATED]`;
    }

    return value;
  }

  /**
   * Sanitize a value using the configured replacer
   */
  private sanitizeValue(value: any, seen = new WeakSet()): any {
    // Handle null/undefined
    if (value == null) {
      return value;
    }

    // Handle primitives
    if (typeof value !== 'object') {
      return value;
    }

    // Prevent circular reference infinite loops
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);

    // Handle arrays
    if (Array.isArray(value)) {
      return value.map((item) => this.sanitizeValue(item, seen));
    }

    // Handle Error objects specially
    if (value instanceof Error) {
      return {
        message: value.message,
        name: value.name,
        stack: value.stack
          ? value.stack
              .split('\n')
              .slice(0, this.config.maxStackLines)
              .join('\n')
          : undefined,
      };
    }

    // Handle regular objects
    const sanitized: Record<string, any> = {};
    for (const [key, val] of Object.entries(value)) {
      const replacedValue = this.config.replacer(key, val);
      if (replacedValue !== undefined) {
        sanitized[key] = this.sanitizeValue(replacedValue, seen);
      }
    }

    return sanitized;
  }

  /**
   * Sanitize a signal payload
   *
   * @param signal - Signal to sanitize
   * @returns Sanitized signal (new object, doesn't mutate original)
   */
  sanitize(signal: Signal): Signal {
    return {
      id: signal.id,
      objectId: signal.objectId,
      className: signal.className,
      method: signal.method,
      type: signal.type,
      timestamp: signal.timestamp,
      ...(signal.step && { step: signal.step }),
      ...(signal.duration !== undefined && { duration: signal.duration }),
      ...(signal.args && { args: this.sanitizeValue(signal.args) }),
      ...(signal.result && { result: this.sanitizeValue(signal.result) }),
      ...(signal.error && { error: this.sanitizeValue(signal.error) }),
      ...(signal.metadata && { metadata: this.sanitizeValue(signal.metadata) }),
    };
  }
}
