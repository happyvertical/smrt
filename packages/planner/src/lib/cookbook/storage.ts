import type { Cookbook } from './types.ts';
import { parseCookbookText } from './validate.ts';

/**
 * The cookbook's localStorage key. The version is in the key so a future
 * format reads the old key and migrates it; an unknown version is never
 * guessed at. (`smrt-planner:cookbook` alone is the library selection.)
 */
export const STORAGE_KEY = 'smrt-planner:cookbook-doc:v1';
/**
 * Where the document lived while it was called a blueprint. It is read once
 * when the new key is empty and kept as the backup until the next save.
 */
export const PREVIOUS_STORAGE_KEY = 'smrt-planner:blueprint:v1';
/** A value that could not be read is kept here, never silently overwritten. */
export const UNREADABLE_KEY = 'smrt-planner:cookbook-doc:unreadable';
/** The cookbook a legacy link replaced, so opening a link loses nothing. */
export const BACKUP_KEY = 'smrt-planner:cookbook-doc:backup';

export type LoadOutcome =
  | { status: 'unavailable' }
  | { status: 'empty' }
  | {
      status: 'loaded';
      cookbook: Cookbook;
      /**
       * The previous (blueprint) key still holds a value. It is kept as a
       * backup and removed by the first successful save of the new key.
       */
      previousKept: boolean;
    }
  | {
      status: 'unreadable';
      reason: string;
      /** Whether the raw value was copied to UNREADABLE_KEY. */
      keptAside: boolean;
    };

/** The browser's localStorage, or null when reaching for it throws. */
export function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Read the saved cookbook. Never throws. */
export function loadCookbook(storage: Storage | null): LoadOutcome {
  if (!storage) return { status: 'unavailable' };
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { status: 'unavailable' };
  }
  let previous: string | null = null;
  try {
    previous = storage.getItem(PREVIOUS_STORAGE_KEY);
  } catch {
    // Treated as absent.
  }
  // Nothing under the new key: migrate the value saved while it was a blueprint.
  const fromPrevious = raw === null && previous !== null;
  const source = fromPrevious ? previous : raw;
  if (source === null) return { status: 'empty' };
  // A saved cookbook from an older build may name recipes this one no longer
  // has: they are kept in the document (and noticed by the store), and a
  // theme preset this build lacks is dropped rather than discarding the rest.
  const parsed = parseCookbookText(source, { dropUnknownRecipes: true });
  if (parsed.ok) {
    // Write the migrated document under the new key now; the old key stays as
    // a backup until the next successful save. If this write fails the old
    // key simply remains the only copy.
    if (fromPrevious) {
      writeKey(storage, STORAGE_KEY, JSON.stringify(parsed.cookbook));
    }
    return {
      status: 'loaded',
      cookbook: parsed.cookbook,
      previousKept: previous !== null,
    };
  }
  raw = source;
  // Keep what we could not read; the next save would otherwise destroy it.
  const keptAside = writeKey(storage, UNREADABLE_KEY, raw);
  return { status: 'unreadable', reason: parsed.error, keptAside };
}

/** Write a value under a key; false when storage refused. Never throws. */
export function writeKey(
  storage: Storage | null,
  key: string,
  value: string,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Remove a key; false when storage refused. Never throws. */
export function removeKey(storage: Storage | null, key: string): boolean {
  if (!storage) return false;
  try {
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}

export function saveCookbook(
  storage: Storage | null,
  cookbook: Cookbook,
): boolean {
  return writeKey(storage, STORAGE_KEY, JSON.stringify(cookbook));
}
