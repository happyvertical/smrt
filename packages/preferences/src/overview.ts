/**
 * The overview layer (#3727 phase 3): overview-shaped load, save, reset,
 * page load and widget load over the generic preference store, kind
 * `overview`, surface id = `OverviewDefinition.id`.
 *
 * Tiers, low to high: the page's `definition.defaults`, the tenant default,
 * then the user's override. The tenant tier merges into the defaults first
 * and the user tier applies to that result, so a user override is a delta
 * against the tenant default. Saves are strict (`checkOverviewOverride`, only
 * the canonical override is stored); loads are lenient (a bad entry is
 * dropped and reported, the rest render).
 */
import {
  type LoadedOverview,
  type LoadOverviewOptions,
  loadOverview,
  type OverviewDefinition,
  type OverviewDocument,
  type OverviewIssue,
  type OverviewOverride,
  optionsEqual,
  parseOverviewDocument,
  resolveOverview,
  sanitizeOverview,
  type WidgetLoadInput,
  type WidgetRegistry,
} from '@happyvertical/smrt-svelte/overview/server';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  OVERVIEW_PREFERENCE_KIND,
  type OverviewKindOptions,
  toOverviewIssue,
  withTenantDefaults,
} from './kinds/overview.js';
import type { PreferenceScope } from './kinds.js';
import { createPreferenceStore, type PreferenceStore } from './store.js';

/** One stored tier, resolved. */
export interface OverviewTierState {
  /** The document this tier applies to (sanitized). */
  base: OverviewDocument;
  /** The document after this tier (sanitized). */
  document: OverviewDocument;
  /** The stored override, canonical with invalid entries removed, or `null`. */
  override: OverviewOverride | null;
  /** Concurrency token: echo it back on save or reset; `null` = no row. */
  revision: string | null;
  /** Entries of the stored override dropped on load, and why. */
  issues: OverviewIssue[];
}

/** What a page load needs to render and edit one overview. */
export interface OverviewState {
  overviewId: string;
  /** The tenant default over `definition.defaults`. */
  tenant: OverviewTierState;
  /** The user's override over the tenant default; `null` without a user. */
  user: OverviewTierState | null;
  /** What the principal sees: the user tier's document, else the tenant's. */
  document: OverviewDocument;
  /** Every stored-tier issue (tenant first). Page-default issues excluded. */
  issues: OverviewIssue[];
  /** Feed `createOverview({ canCustomize })` for the tier being edited. */
  canCustomize: { tenant: boolean; user: boolean };
}

export type OverviewWriteFailure =
  | { ok: false; reason: 'not_allowed' }
  | { ok: false; reason: 'conflict' }
  | { ok: false; reason: 'invalid'; issues: OverviewIssue[] };

export type OverviewSaveResult =
  | { ok: true; override: OverviewOverride | null; revision: string | null }
  | OverviewWriteFailure;

export type OverviewResetResult = { ok: true } | OverviewWriteFailure;

export interface OverviewSaveInput {
  scope: PreferenceScope;
  /** The client's override (untrusted). `null` resets the tier. */
  override: unknown;
  /**
   * The `revision` the client loaded for this tier (`null` when it loaded no
   * row). A stale revision fails with `conflict`, never overwrites.
   */
  revision: string | null;
}

export interface OverviewResetInput {
  scope: PreferenceScope;
  /** Guard the delete with the loaded revision; omit to reset regardless. */
  revision?: string | null;
}

export interface OverviewPageOptions extends LoadOverviewOptions {
  /** Which tier's document to load: `user` (default) or `tenant` (editing defaults). */
  scope?: PreferenceScope;
}

export type OverviewWidgetResult =
  | { ok: true; data: unknown }
  | { ok: false; reason: 'not_allowed' }
  | { ok: false; reason: 'invalid'; issues: OverviewIssue[] }
  | {
      ok: false;
      reason: 'load_failed';
      code: 'load_failed' | 'timeout' | 'invalid_data';
    };

export interface OverviewStoreOptions {
  db: DatabaseInterface;
  /** Share a generic store (default: one over `db`). */
  preferences?: PreferenceStore;
}

export interface OverviewStore {
  /** Read both tiers for the principal and resolve the merge. */
  load(
    definition: OverviewDefinition,
    registry: WidgetRegistry,
  ): Promise<OverviewState>;
  /** Validate and store one tier's override (canonical form only). */
  save(
    definition: OverviewDefinition,
    registry: WidgetRegistry,
    input: OverviewSaveInput,
  ): Promise<OverviewSaveResult>;
  /** Delete one tier's row, returning that tier to the tier below. */
  reset(
    definition: OverviewDefinition,
    input: OverviewResetInput,
  ): Promise<OverviewResetResult>;
  /** `load` plus `loadOverview`, for a page's server load. */
  loadPage(
    definition: OverviewDefinition,
    registry: WidgetRegistry,
    ctx: WidgetLoadInput,
    options?: OverviewPageOptions,
  ): Promise<OverviewState & { loaded: LoadedOverview }>;
  /** The data of one widget, for the controller's `loadWidget` remote function. */
  loadWidget(
    definition: OverviewDefinition,
    registry: WidgetRegistry,
    widget: unknown,
    ctx: WidgetLoadInput,
    options?: LoadOverviewOptions,
  ): Promise<OverviewWidgetResult>;
}

function sameWidget(
  a: OverviewDocument['widgets'][number],
  b: OverviewDocument['widgets'][number],
): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    (a.version ?? 1) === (b.version ?? 1) &&
    optionsEqual(a.options, b.options)
  );
}

/**
 * The persistence and server-load API of overview surfaces. Every call acts
 * as the ambient principal.
 */
export function createOverviewStore(
  options: OverviewStoreOptions,
): OverviewStore {
  const preferences =
    options.preferences ?? createPreferenceStore({ db: options.db });
  const kindOptions = (
    definition: OverviewDefinition,
    registry: WidgetRegistry,
  ): OverviewKindOptions => ({ definition, registry });

  const store: OverviewStore = {
    async load(definition, registry) {
      const state = await preferences.load(
        OVERVIEW_PREFERENCE_KIND,
        definition.id,
        { options: kindOptions(definition, registry) },
      );
      const tenantOverride = state.tenant.payload as OverviewOverride | null;
      const tenantResolved = resolveOverview(
        definition,
        tenantOverride,
        registry,
      );
      const tenant: OverviewTierState = {
        base: tenantResolved.base,
        document: tenantResolved.document,
        override: tenantOverride,
        revision: state.tenant.revision,
        issues: state.tenant.issues.map(toOverviewIssue),
      };
      let user: OverviewTierState | null = null;
      if (state.user) {
        const userOverride = state.user.payload as OverviewOverride | null;
        const userResolved = resolveOverview(
          withTenantDefaults(definition, tenant.document),
          userOverride,
          registry,
        );
        user = {
          base: userResolved.base,
          document: userResolved.document,
          override: userOverride,
          revision: state.user.revision,
          issues: state.user.issues.map(toOverviewIssue),
        };
      }
      return {
        overviewId: definition.id,
        tenant,
        user,
        document: user?.document ?? tenant.document,
        issues: [...tenant.issues, ...(user?.issues ?? [])],
        canCustomize: state.canCustomize,
      };
    },

    async save(definition, registry, input) {
      const result = await preferences.save(
        OVERVIEW_PREFERENCE_KIND,
        definition.id,
        {
          scope: input.scope,
          payload: input.override,
          revision: input.revision,
          options: kindOptions(definition, registry),
        },
      );
      if (result.ok) {
        return {
          ok: true,
          override: result.payload as OverviewOverride | null,
          revision: result.revision,
        };
      }
      if (result.reason === 'invalid') {
        return {
          ok: false,
          reason: 'invalid',
          issues: result.issues.map(toOverviewIssue),
        };
      }
      return result;
    },

    async reset(definition, input) {
      const result = await preferences.reset(
        OVERVIEW_PREFERENCE_KIND,
        definition.id,
        input,
      );
      if (!result.ok && result.reason === 'invalid') {
        return {
          ok: false,
          reason: 'invalid',
          issues: result.issues.map(toOverviewIssue),
        };
      }
      return result as OverviewResetResult;
    },

    async loadPage(definition, registry, ctx, pageOptions = {}) {
      const { scope = 'user', ...loadOptions } = pageOptions;
      const state = await store.load(definition, registry);
      const document =
        scope === 'tenant' ? state.tenant.document : state.document;
      const loaded = await loadOverview(
        document,
        definition,
        registry,
        ctx,
        loadOptions,
      );
      return { ...state, loaded };
    },

    async loadWidget(definition, registry, widget, ctx, loadOptions = {}) {
      const state = await store.load(definition, registry);
      const parsed = parseOverviewDocument({ widgets: [widget] });
      const candidate = parsed.document.widgets[0];
      if (!candidate || parsed.issues.length > 0) {
        return { ok: false, reason: 'invalid', issues: parsed.issues };
      }
      // A viewer may reload a widget that is on their overview; loading any
      // other widget (an add or a reconfigure in progress) needs a customize
      // permission on some tier, like the save it precedes.
      const onPage = [
        ...state.document.widgets,
        ...state.tenant.document.widgets,
      ].some((existing) => sameWidget(existing, candidate));
      if (!onPage && !state.canCustomize.tenant && !state.canCustomize.user) {
        return { ok: false, reason: 'not_allowed' };
      }
      const sanitized = sanitizeOverview(
        { widgets: [candidate] },
        { registry, definition },
      );
      if (sanitized.issues.length > 0) {
        return { ok: false, reason: 'invalid', issues: sanitized.issues };
      }
      const loaded = await loadOverview(
        sanitized.document,
        definition,
        registry,
        ctx,
        loadOptions,
      );
      const result = loaded.widgets[0];
      if (!result) return { ok: false, reason: 'invalid', issues: [] };
      if (result.status === 'error') {
        return {
          ok: false,
          reason: 'load_failed',
          code: result.error?.code ?? 'load_failed',
        };
      }
      return { ok: true, data: result.data };
    },
  };
  return store;
}
