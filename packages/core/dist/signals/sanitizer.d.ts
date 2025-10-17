import { Signal } from '@smrt/types';
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
 * Signal sanitizer
 *
 * Removes or redacts sensitive data from signal payloads before
 * they are processed by adapters.
 */
export declare class SignalSanitizer {
    private config;
    constructor(config?: SanitizationConfig);
    /**
     * Default replacer function
     *
     * Redacts sensitive keys and truncates long strings
     */
    private defaultReplacer;
    /**
     * Sanitize a value using the configured replacer
     */
    private sanitizeValue;
    /**
     * Sanitize a signal payload
     *
     * @param signal - Signal to sanitize
     * @returns Sanitized signal (new object, doesn't mutate original)
     */
    sanitize(signal: Signal): Signal;
}
//# sourceMappingURL=sanitizer.d.ts.map