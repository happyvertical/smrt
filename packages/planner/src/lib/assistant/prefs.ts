import { DEFAULT_MODEL_ID, getModel } from './models.ts';

/**
 * A UI preference, not part of the cookbook: which model to use and which the
 * visitor has agreed to download. Kept in localStorage; every access is
 * guarded because it can throw or be empty (private windows, blocked storage).
 */
export interface AssistantPrefs {
  modelId: string;
  /** Models whose download the visitor has accepted. */
  consented: string[];
}

export const PREFS_KEY = 'smrt-planner:assistant:v1';

export function defaultPrefs(): AssistantPrefs {
  return { modelId: DEFAULT_MODEL_ID, consented: [] };
}

export function loadPrefs(storage: Storage | null): AssistantPrefs {
  const prefs = defaultPrefs();
  try {
    const raw = storage?.getItem(PREFS_KEY);
    if (!raw) return prefs;
    const value = JSON.parse(raw) as Partial<AssistantPrefs>;
    if (typeof value.modelId === 'string' && getModel(value.modelId)) {
      prefs.modelId = value.modelId;
    }
    if (Array.isArray(value.consented)) {
      prefs.consented = value.consented.filter(
        (id): id is string => typeof id === 'string' && !!getModel(id),
      );
    }
  } catch {
    // Unreadable or unavailable: start from the defaults.
  }
  return prefs;
}

export function savePrefs(
  storage: Storage | null,
  prefs: AssistantPrefs,
): void {
  try {
    storage?.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Not saved; the choice still holds for this visit.
  }
}
