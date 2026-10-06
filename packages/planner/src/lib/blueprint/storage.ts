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
  | { status: 'unreadable'; reason: string };

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
  const parsed = parseBlueprintText(raw);
  if (parsed.ok) return { status: 'loaded', blueprint: parsed.blueprint };
  // Keep what we could not read; the next save would otherwise destroy it.
  try {
    storage.setItem(UNREADABLE_KEY, raw);
  } catch {
    // Nothing more to do: it stays under STORAGE_KEY until overwritten.
  }
  return { status: 'unreadable', reason: parsed.error };
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
