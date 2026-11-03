/**
 * Shared checks for the closed bundle manifests (versions 1 and 2): every
 * object is closed, every string bounded, every key a short token.
 */
import {
  type CourseBundleRefusalReason,
  CourseBundleRefusedError,
} from './course-bundle-contracts.js';
import { isWellFormedString } from './course-bundle-zip.js';

export const MANIFEST_KEY = /^[A-Za-z0-9._:-]{1,120}$/;
export const MANIFEST_CONTROL =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters in text
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export const refuse = (
  reason: CourseBundleRefusalReason,
  entry?: string,
): never => {
  throw new CourseBundleRefusedError(reason, entry);
};

/** An object whose keys are all in `allowed`; any other key is `manifest_unknown_key`. */
export function closedObject(
  value: unknown,
  allowed: readonly string[],
  path: string,
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return refuse('manifest_invalid', path);
  for (const key of Object.keys(value))
    if (!allowed.includes(key))
      return refuse('manifest_unknown_key', `${path}.${key}`);
  return value as Record<string, unknown>;
}

export function manifestText(
  value: unknown,
  path: string,
  max: number,
): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    !isWellFormedString(value) ||
    MANIFEST_CONTROL.test(value)
  )
    return refuse('manifest_invalid', path);
  return value;
}

export function manifestKey(value: unknown, path: string): string {
  if (typeof value !== 'string' || !MANIFEST_KEY.test(value))
    return refuse('manifest_invalid', path);
  return value;
}

/** The `version` of a manifest document, or null when it is not a JSON object with one. */
export function manifestVersionOf(bytes: Uint8Array): number | null {
  try {
    const parsed = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    ) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const version = (parsed as Record<string, unknown>).version;
      return typeof version === 'number' ? version : null;
    }
  } catch {
    // an unreadable manifest is refused by the reader that parses it
  }
  return null;
}
