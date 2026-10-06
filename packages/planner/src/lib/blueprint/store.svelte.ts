import { recipeState } from '../recipes/state.svelte.ts';
import type { ShellLayout } from '../upstream/shellLayout.ts';
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
  /** The shell layout (smrt#3603). Carried through, not yet applied. */
  layout = $state<ShellLayout | undefined>();
  persist = $state<PersistState>('unknown');
  /** False until the saved blueprint has been read; nothing saves before. */
  loaded = $state(false);
  /** Why the saved blueprint was not used, if it was not. */
  loadNotice = $state('');

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

  /** Replace everything from a validated blueprint. */
  apply(blueprint: Blueprint): void {
    recipeState.load(blueprint);
    this.layout = blueprint.layout;
  }

  /** Back to an empty blueprint. */
  reset(): void {
    recipeState.clear();
    this.layout = undefined;
  }

  /** Validate and apply JSON text, e.g. a chosen file. Applies nothing on failure. */
  importText(text: string): BlueprintResult {
    const result = parseBlueprintText(text);
    if (result.ok) this.apply(result.blueprint);
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
      this.loadNotice = `The saved blueprint could not be read (${outcome.reason}) and was kept aside; starting empty.`;
    }

    let migrated = false;
    if (hasLegacyState(search)) {
      // An explicit link wins, but what it replaces is backed up first.
      if (outcome.status === 'loaded') {
        writeKey(storage, BACKUP_KEY, JSON.stringify(outcome.blueprint));
      }
      this.apply(blueprintFromLegacySearch(search));
      migrated = true;
    }

    this.persist = outcome.status === 'unavailable' ? 'memory' : 'unknown';
    this.loaded = true;
    // Persist a migration at once: the URL is about to lose its copy.
    if (migrated) this.save();
    return migrated;
  }

  /** Save now. Falls back to memory-only (and says so) if storage refuses. */
  save(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.loaded) return;
    this.persist = saveBlueprint(this.storage, this.snapshot())
      ? 'ok'
      : 'memory';
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
