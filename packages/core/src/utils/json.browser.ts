/**
 * Browser build of `json.ts` (#2838): selected through `package.json#browser`.
 *
 * `json.ts` asks `@happyvertical/json` for an adapter, and that package's
 * SIMD adapter loader reaches `node:module`, `node:path` and `node:url`. A
 * page has no SIMD adapter to pick, so this build is the native `JSON`
 * implementation `json.ts` already falls back to. Typed against `json.ts`,
 * so the two cannot drift.
 */
import type * as NodeJson from './json.js';

export const parse: typeof NodeJson.parse = <T = unknown>(text: string): T =>
  JSON.parse(text) as T;

export const stringify: typeof NodeJson.stringify = (value, replacer, space) =>
  JSON.stringify(
    value,
    replacer as Parameters<typeof JSON.stringify>[1],
    space,
  );

export const clone: typeof NodeJson.clone = <T>(value: T): T =>
  JSON.parse(JSON.stringify(value)) as T;

export const safeParse: typeof NodeJson.safeParse = <T = unknown>(
  text: string,
) => {
  try {
    return { success: true, value: JSON.parse(text) as T } as const;
  } catch (error) {
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    } as const;
  }
};

export const safeStringify: typeof NodeJson.safeStringify = (value) => {
  try {
    return { success: true, value: JSON.stringify(value) } as const;
  } catch (error) {
    return {
      success: false,
      error: {
        message: error instanceof Error ? error.message : String(error),
      },
    } as const;
  }
};

export const isValid: typeof NodeJson.isValid = (text) => {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

export const getAdapterInfo: typeof NodeJson.getAdapterInfo = () => ({
  name: 'native',
  isNative: true,
  simdEnabled: false,
});
