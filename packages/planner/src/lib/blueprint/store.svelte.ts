import {
  isShellLayoutEmpty,
  type ShellLayout,
} from '@happyvertical/smrt-svelte/workspace/layout';
import { recipeState } from '../recipes/state.svelte.ts';
import { blueprintFromLegacySearch, hasLegacyState } from './legacy.ts';
import {
  BACKUP_KEY,
  browserStorage,
  loadBlueprint,
  saveBlueprint,
  writeKey,
} from './storage.ts';
import {
  BLUEPRINT_SCHEMA,
  BLUEPRINT_VERSION,
  type Blueprint,
  type BlueprintResult,
} from './types.ts';
import { parseBlueprintText } from './validate.ts';

export const SAVE_DELAY_MS = 300;

/** `ok`: saved. `memory`: storage unavailable or refusing, working in memory. */
export type PersistState = 'unknown' | 'ok' | 'memory';

/**
 * The single source of truth for what a visitor has built. Recipes and
 * options stay in `recipeState` (the one store views read); this adds the
 * `layout` field and the persistence around both. `snapshot()` is the
 * Blueprint, whether it is saved, exported or compared.
 */
export class BlueprintStore {
  /** The shell layout, owned here and passed to `AppShell`. */
  layout = $state<ShellLayout | undefined>();
  persist = $state<PersistState>('unknown');
  /** False until the saved blueprint has been read; nothing saves before. */
  loaded = $state(false);
  /** Why the saved blueprint was not used, if it was not. */
  loadNotice = $state('');

  /**
   * True when saving would destroy the only copy of something (an unreadable
   * value that could not be kept aside, or a saved blueprint a legacy link
   * replaced without a backup). Nothing is written until the visitor imports
   * or resets.
   */
  private saveBlocked = false;
  /** A migrated legacy link whose data is not safely stored: keep the URL. */
  keepLegacyUrl = $state(false);

  private storage: Storage | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  snapshot(): Blueprint {
    const blueprint: Blueprint = {
      $schema: BLUEPRINT_SCHEMA,
      version: BLUEPRINT_VERSION,
      ...recipeState.snapshot(),
    };
    if (this.layout) blueprint.layout = this.layout;
    return blueprint;
  }

  /** An edit from the shell or its layout editor; an empty one clears it. */
  setLayout(next: ShellLayout): void {
    this.layout = isShellLayoutEmpty(next) ? undefined : next;
  }

  /** Replace everything from a validated blueprint. */
  apply(blueprint: Blueprint): void {
    recipeState.load(blueprint);
    this.layout = blueprint.layout;
  }

  /** Replace on the visitor's say-so (an import): saving is allowed again. */
  replace(blueprint: Blueprint): void {
    this.apply(blueprint);
    this.saveBlocked = false;
    this.keepLegacyUrl = false;
  }

  /** Back to an empty blueprint. */
  reset(): void {
    recipeState.clear();
    this.layout = undefined;
    this.saveBlocked = false;
    this.keepLegacyUrl = false;
  }

  /** Validate and apply JSON text, e.g. a chosen file. Applies nothing on failure. */
  importText(text: string): BlueprintResult {
    const result = parseBlueprintText(text);
    if (result.ok) this.replace(result.blueprint);
    return result;
  }

  /**
   * Read the saved blueprint, then migrate a legacy `?r=` / `?o=` link into it.
   * Call once in the browser, before `loaded` lets saving start. Returns true
   * when a legacy link was imported, so the caller can clean the URL.
   */
  hydrate(search: string, storage: Storage | null = browserStorage()): boolean {
    this.storage = storage;
    const outcome = loadBlueprint(storage);
    if (outcome.status === 'loaded') this.apply(outcome.blueprint);
    else if (outcome.status === 'unreadable') {
      this.saveBlocked = !outcome.keptAside;
      this.loadNotice = outcome.keptAside
        ? `The saved blueprint could not be read (${outcome.reason}) and was kept aside; starting empty.`
        : `The saved blueprint could not be read (${outcome.reason}). Starting empty without overwriting it; import or reset to save again.`;
    }

    let migrated = false;
    if (hasLegacyState(search)) {
      // An explicit link wins, but what it replaces is backed up first.
      if (
        outcome.status === 'loaded' &&
        !writeKey(storage, BACKUP_KEY, JSON.stringify(outcome.blueprint))
      ) {
        this.saveBlocked = true;
      }
      this.apply(blueprintFromLegacySearch(search));
      migrated = true;
    }

    this.persist = outcome.status === 'unavailable' ? 'memory' : 'unknown';
    this.loaded = true;
    // Persist a migration at once: the URL is about to lose its copy.
    if (migrated) {
      const saved = this.save();
      // The URL held the only copy unless it is now safely stored.
      this.keepLegacyUrl = !saved;
    }
    return migrated;
  }

  /** Save now. Falls back to memory-only (and says so) if storage refuses. */
  save(): boolean {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.loaded) return false;
    if (this.saveBlocked) {
      this.persist = 'memory';
      return false;
    }
    const saved = saveBlueprint(this.storage, this.snapshot());
    this.persist = saved ? 'ok' : 'memory';
    // Once stored, the legacy parameters are redundant and may be cleaned.
    if (saved) this.keepLegacyUrl = false;
    return saved;
  }

  /** Save soon; many quick edits make one write. */
  scheduleSave(): void {
    if (!this.loaded) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.save(), SAVE_DELAY_MS);
  }

  /** Save any pending change now (page hide). */
  flush(): void {
    if (this.timer !== undefined) this.save();
  }
}

export const blueprintStore = new BlueprintStore();
