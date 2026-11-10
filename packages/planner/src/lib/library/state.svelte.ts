import { setSamplePack } from '../data/packs.ts';
import { workspaceStorage } from '../planner/workspace-storage.ts';

/** Which cookbook the visitor last applied; a UI note, not part of the cookbook. */
export const COOKBOOK_KEY = 'smrt-planner:cookbook';
/** The `workFingerprint` of the document the visitor last applied, as applied. */
export const APPLIED_WORK_KEY = 'smrt-planner:cookbook-applied';

class CookbookState {
  private appliedListeners = new Set<() => void>();
  /** Observe successful explicit applications, never hydration or failed commands. */
  onApplied(listener: () => void): () => void {
    this.appliedListeners.add(listener);
    return () => this.appliedListeners.delete(listener);
  }
  active = $state<string | null>(null);
  /** What applying `active` set up, to tell later edits from none. */
  appliedWork = $state<string | null>(null);

  /** Read the remembered cookbook (browser only; never throws). */
  load(storage: Storage | null = workspaceStorage()): void {
    try {
      this.active = storage?.getItem(COOKBOOK_KEY) ?? null;
      this.appliedWork = storage?.getItem(APPLIED_WORK_KEY) ?? null;
    } catch {
      this.active = null;
      this.appliedWork = null;
    }
    // The sample data follows the cookbook the visitor last applied.
    setSamplePack(this.active);
  }

  select(
    id: string,
    work: string | null = null,
    storage: Storage | null = workspaceStorage(),
  ): void {
    this.active = id;
    this.appliedWork = work;
    for (const listener of this.appliedListeners) listener();
    try {
      storage?.setItem(COOKBOOK_KEY, id);
      if (work === null) storage?.removeItem(APPLIED_WORK_KEY);
      else storage?.setItem(APPLIED_WORK_KEY, work);
    } catch {
      // Remembered in memory only.
    }
  }
}

export const libraryState = new CookbookState();
