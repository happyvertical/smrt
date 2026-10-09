import {
  isShellLayoutEmpty,
  type ShellLayout,
} from '@happyvertical/smrt-svelte/workspace/layout';
import { setSampleTaxRate } from '../data/packs.ts';
import { recipeState } from '../recipes/state.svelte.ts';
import {
  type AppSettings,
  hasTaxRateRow,
  readSettings,
  writeSettings,
} from '../settings/app-settings.ts';
import { compactTheme, type ThemeSetting } from '../theme/theme.ts';
import { cookbookFromLegacySearch, hasLegacyState } from './legacy.ts';
import {
  BACKUP_KEY,
  browserStorage,
  loadCookbook,
  PREVIOUS_STORAGE_KEY,
  removeKey,
  saveCookbook,
  writeKey,
} from './storage.ts';
import {
  COOKBOOK_SCHEMA,
  COOKBOOK_VERSION,
  type Cookbook,
  type CookbookResult,
} from './types.ts';
import { parseCookbookText } from './validate.ts';

/** Where the planner's AppShell keeps its own settings (panel states, sizes). */
export const SHELL_STORAGE_KEY = 'smrt-planner:shell';

export const SAVE_DELAY_MS = 300;

/** `ok`: saved. `memory`: storage unavailable or refusing, working in memory. */
export type PersistState = 'unknown' | 'ok' | 'memory';

/**
 * The single source of truth for what a visitor has built. Recipes and
 * options stay in `recipeState` (the one store views read); this adds the
 * `layout` field and the persistence around both. `snapshot()` is the
 * Cookbook, whether it is saved, exported or compared.
 */
export class CookbookStore {
  /** The shell layout, owned here and passed to `AppShell`. */
  layout = $state<ShellLayout | undefined>();
  /** The app's theme; undefined is the default. The shell applies it live. */
  theme = $state<ThemeSetting | undefined>();
  persist = $state<PersistState>('unknown');
  /** False until the saved cookbook has been read; nothing saves before. */
  loaded = $state(false);
  /** Why the saved cookbook was not used, if it was not. */
  loadNotice = $state('');

  /**
   * True when saving would destroy the only copy of something (an unreadable
   * value that could not be kept aside, or a saved cookbook a legacy link
   * replaced without a backup). Nothing is written until the visitor imports
   * or resets.
   */
  private saveBlocked = false;
  /** A migrated legacy link whose data is not safely stored: keep the URL. */
  keepLegacyUrl = $state(false);

  /** A cookbook was chosen (cookbook, import) before the saved one was read. */
  private replacedBeforeLoad = false;

  /** The pre-rename key still holds a backup; the next good save removes it. */
  private previousKept = false;

  private storage: Storage | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

  snapshot(): Cookbook {
    const cookbook: Cookbook = {
      $schema: COOKBOOK_SCHEMA,
      version: COOKBOOK_VERSION,
      ...recipeState.snapshot(),
    };
    if (this.layout) cookbook.layout = this.layout;
    const theme = compactTheme(
      $state.snapshot(this.theme) as ThemeSetting | undefined,
    );
    if (theme) cookbook.theme = theme;
    return cookbook;
  }

  /** An edit from the shell or its layout editor; an empty one clears it. */
  setLayout(next: ShellLayout): void {
    this.layout = isShellLayoutEmpty(next) ? undefined : next;
  }

  /** Replace everything from a validated cookbook. */
  apply(cookbook: Cookbook): void {
    recipeState.load(cookbook);
    this.layout = cookbook.layout;
    this.theme = cookbook.theme;
    setSampleTaxRate(
      hasTaxRateRow(cookbook) ? readSettings(cookbook).taxRate : undefined,
    );
  }

  /**
   * A sentence naming recipes and features the loaded cookbook has that this
   * version does not know (they are kept, not applied), or ''.
   */
  get unavailableNotice(): string {
    const ids = [
      ...recipeState.unavailableRecipes,
      ...recipeState.unavailableFeatures,
    ];
    if (!ids.length) return '';
    const n = ids.length;
    return `${n} ${n === 1 ? 'recipe' : 'recipes'} in this cookbook ${n === 1 ? "isn't" : "aren't"} available in this version: ${ids.join(', ')}. They are kept when you save or export.`;
  }

  /** Remove the unavailable ids from the cookbook, on the visitor's say. */
  removeUnavailable(): void {
    recipeState.removeUnavailable();
    this.scheduleSave();
  }

  /** Change the theme; the default (or an empty one) clears it. */
  setTheme(next: ThemeSetting | undefined): void {
    this.theme = compactTheme(next);
  }

  /** The app settings (currency, tax rate, payment terms), read from the policy rows. */
  settings(): AppSettings {
    return readSettings(this.snapshot());
  }

  /** Write the settings as policy rows. Existing records are untouched. */
  setSettings(settings: AppSettings): void {
    const next = writeSettings(this.snapshot(), settings);
    recipeState.rows = next.policies.map((row) => ({ ...row }));
    setSampleTaxRate(
      hasTaxRateRow(next) ? readSettings(next).taxRate : undefined,
    );
  }

  /** Replace on the visitor's say-so (an import): saving is allowed again. */
  replace(cookbook: Cookbook): void {
    this.apply(cookbook);
    if (!this.loaded) this.replacedBeforeLoad = true;
    this.saveBlocked = false;
    this.keepLegacyUrl = false;
  }

  /** Back to an empty cookbook, and the shell's own settings to defaults. */
  reset(): void {
    recipeState.clear();
    this.layout = undefined;
    this.theme = undefined;
    try {
      globalThis.localStorage?.removeItem(SHELL_STORAGE_KEY);
    } catch {
      // Storage may be unavailable (private mode); the cookbook still resets.
    }
    this.saveBlocked = false;
    this.keepLegacyUrl = false;
  }

  /** Validate and apply JSON text, e.g. a chosen file. Applies nothing on failure. */
  importText(text: string): CookbookResult {
    const result = parseCookbookText(text);
    if (result.ok) this.replace(result.cookbook);
    return result;
  }

  /**
   * Read the saved cookbook, then migrate a legacy `?r=` / `?o=` link into it.
   * Call once in the browser, before `loaded` lets saving start. Returns true
   * when a legacy link was imported, so the caller can clean the URL.
   */
  hydrate(search: string, storage: Storage | null = browserStorage()): boolean {
    this.storage = storage;
    const outcome = loadCookbook(storage);
    if (outcome.status === 'loaded') this.previousKept = outcome.previousKept;
    // What the visitor chose a moment ago (before the first navigation settled)
    // wins over what was saved; the next save keeps it.
    if (outcome.status === 'loaded' && !this.replacedBeforeLoad) {
      this.apply(outcome.cookbook);
    } else if (outcome.status === 'unreadable') {
      this.saveBlocked = !outcome.keptAside;
      this.loadNotice = outcome.keptAside
        ? `The saved cookbook could not be read (${outcome.reason}) and was kept aside; starting empty.`
        : `The saved cookbook could not be read (${outcome.reason}). Starting empty without overwriting it; import or reset to save again.`;
    }

    let migrated = false;
    if (hasLegacyState(search)) {
      // An explicit link wins, but what it replaces is backed up first.
      if (
        outcome.status === 'loaded' &&
        !writeKey(storage, BACKUP_KEY, JSON.stringify(outcome.cookbook))
      ) {
        this.saveBlocked = true;
      }
      this.apply(cookbookFromLegacySearch(search));
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
    const saved = saveCookbook(this.storage, this.snapshot());
    this.persist = saved ? 'ok' : 'memory';
    if (saved && this.previousKept) {
      this.previousKept = !removeKey(this.storage, PREVIOUS_STORAGE_KEY);
    }
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

export const cookbookStore = new CookbookStore();
