import type { Blueprint } from './types.ts';
import { parseBlueprintText } from './validate.ts';

/**
 * The blueprint's localStorage key. The version is in the key so a future
 * format reads the old key and migrates it; an unknown version is never
 * guessed at.
 */
export const STORAGE_KEY = 'smrt-planner:blueprint:v1';
/** A value that could not be read is kept here, never silently overwritten. */
export const UNREADABLE_KEY = 'smrt-planner:blueprint:unreadable';
/** The blueprint a legacy link replaced, so opening a link loses nothing. */
export const BACKUP_KEY = 'smrt-planner:blueprint:backup';

export type LoadOutcome =
  | { status: 'unavailable' }
  | { status: 'empty' }
  | { status: 'loaded'; blueprint: Blueprint }
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

/** Read the saved blueprint. Never throws. */
export function loadBlueprint(storage: Storage | null): LoadOutcome {
  if (!storage) return { status: 'unavailable' };
  let raw: string | null;
  try {
    raw = storage.getItem(STORAGE_KEY);
  } catch {
    return { status: 'unavailable' };
  }
  if (raw === null) return { status: 'empty' };
  // A saved blueprint from an older build may name recipes this one no longer
  // has: keep the rest rather than discarding the visitor's work.
  const parsed = parseBlueprintText(raw, { dropUnknownRecipes: true });
  if (parsed.ok) return { status: 'loaded', blueprint: parsed.blueprint };
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

export function saveBlueprint(
  storage: Storage | null,
  blueprint: Blueprint,
): boolean {
  return writeKey(storage, STORAGE_KEY, JSON.stringify(blueprint));
}
