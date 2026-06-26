/**
 * JSON utilities with optional SIMD acceleration
 *
 * Uses @happyvertical/json for faster parsing when available,
 * with automatic fallback to native JSON.
 *
 * Performance: 2-3x faster parsing on large JSON files (680KB manifests)
 */

import {
  type JSONAdapter,
  JSONFactory,
  type ParseError,
  type Result,
  type StringifyError,
} from '@happyvertical/json';

// Singleton adapter instance
let adapter: JSONAdapter | null = null;

/**
 * Get or create the JSON adapter instance
 */
function getAdapter(): JSONAdapter {
  if (!adapter) {
    adapter = JSONFactory.create({
      adapter: 'auto', // Use SIMD when available, fallback to native
      fallback: true,
    });
  }
  return adapter;
}

/**
 * Parse JSON string with optional SIMD acceleration
 *
 * @example
 * ```typescript
 * import { parse } from '@happyvertical/smrt-core/utils/json';
 *
 * const data = parse<MyType>('{"key": "value"}');
 * ```
 */
export function parse<T = unknown>(text: string): T {
  return getAdapter().parse<T>(text);
}

/**
 * Stringify value to JSON with optional SIMD acceleration
 *
 * @example
 * ```typescript
 * import { stringify } from '@happyvertical/smrt-core/utils/json';
 *
 * const json = stringify({ key: 'value' });
 * const pretty = stringify({ key: 'value' }, null, 2);
 * ```
 */
export function stringify(
  value: unknown,
  replacer?:
    | ((key: string, value: unknown) => unknown)
    | (string | number)[]
    | null,
  space?: number | string,
): string {
  return getAdapter().stringify(value, replacer, space);
}

/**
 * Deep clone via JSON round-trip with optional SIMD acceleration
 *
 * @example
 * ```typescript
 * import { clone } from '@happyvertical/smrt-core/utils/json';
 *
 * const copy = clone(original);
 * ```
 */
export function clone<T>(value: T): T {
  return getAdapter().clone(value);
}

/**
 * Parse JSON without throwing - returns Result type
 *
 * @example
 * ```typescript
 * import { safeParse } from '@happyvertical/smrt-core/utils/json';
 *
 * const result = safeParse<Config>(configJson);
 * if (result.success) {
 *   console.log(result.value);
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export function safeParse<T = unknown>(text: string): Result<T, ParseError> {
  return getAdapter().safeParse<T>(text);
}

/**
 * Stringify without throwing - returns Result type
 *
 * @example
 * ```typescript
 * import { safeStringify } from '@happyvertical/smrt-core/utils/json';
 *
 * const result = safeStringify(data);
 * if (result.success) {
 *   console.log(result.value);
 * } else {
 *   console.error(result.error.message);
 * }
 * ```
 */
export function safeStringify(value: unknown): Result<string, StringifyError> {
  return getAdapter().safeStringify(value);
}

/**
 * Check if a string is valid JSON
 *
 * @example
 * ```typescript
 * import { isValid } from '@happyvertical/smrt-core/utils/json';
 *
 * if (isValid(userInput)) {
 *   // Safe to parse
 * }
 * ```
 */
export function isValid(text: string): boolean {
  return getAdapter().isValid(text);
}

/**
 * Get information about the active JSON adapter
 *
 * @example
 * ```typescript
 * import { getAdapterInfo } from '@happyvertical/smrt-core/utils/json';
 *
 * const info = getAdapterInfo();
 * console.log(`Using ${info.name} adapter, SIMD: ${info.simdEnabled}`);
 * ```
 */
export function getAdapterInfo(): {
  name: string;
  isNative: boolean;
  version?: string;
  simdEnabled?: boolean;
} {
  return getAdapter().getInfo();
}

/**
 * Re-export types for convenience
 */
export type { JSONAdapter, ParseError, Result, StringifyError };
