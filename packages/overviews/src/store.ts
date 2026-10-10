/**
 * Production persistence for overview surfaces (#3727 phase 3).
 *
 * Tiers, low to high: the page's `definition.defaults` (the cookbook), the
 * tenant default, then the user's override. Each tier is a canonical sparse
 * `OverviewOverride` from `@happyvertical/smrt-svelte/overview/server`; the
 * tenant tier merges into the defaults first and the user tier applies to
 * that result, so a user override is a delta against the tenant default.
 *
 * Saves are strict (`checkOverviewOverride`: any issue refuses the save, and
 * only the canonical re-derived override is stored); loads are lenient
 * (`resolveOverview`: a bad entry is dropped and reported, the rest render).
 * Identity always comes from the ambient principal.
 */
import { RuntimeError } from '@happyvertical/smrt-core';
import {
  checkOverviewOverride,
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
import { checkOperationPermission } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { OverviewOverrideRecordCollection } from './collections/OverviewOverrideRecordCollection.js';
import {
  type OverviewPrincipal,
  requireOverviewPrincipal,
  withPrincipal,
} from './context.js';
import type {
  OverviewOverrideRecord,
  OverviewScope,
} from './models/OverviewOverrideRecord.js';
import {
  CUSTOMIZE_OVERVIEW_PERMISSION,
  OVERVIEW_PERMISSION_COLLECTION,
  PERSONALIZE_OVERVIEW_PERMISSION,
} from './permissions.js';

/** One stored tier, resolved. */
export interface OverviewTierState {
  /** The document this tier applies to (sanitized). */
  base: OverviewDocument;
  /** The document after this tier (sanitized). */
  document: OverviewDocument;
  /** The stored override as parsed (well-formed entries only), or `null`. */
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
  scope: OverviewScope;
  /** The client's override (untrusted). `null` resets the tier. */
  override: unknown;
  /**
   * The `revision` the client loaded for this tier (`null` when it loaded no
   * row). A stale revision fails with `conflict`, never overwrites.
   */
  revision: string | null;
}

export interface OverviewResetInput {
  scope: OverviewScope;
  /** Guard the delete with the loaded revision; omit to reset regardless. */
  revision?: string | null;
}

export interface OverviewPageOptions extends LoadOverviewOptions {
  /** Which tier's document to load: `user` (default) or `tenant` (editing defaults). */
  scope?: OverviewScope;
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

/**
 * `definition` with another tier's document as its defaults: the definition a
 * user-tier controller and save are validated against
 * (`withTenantDefaults(definition, state.tenant.document)`).
 */
export function withTenantDefaults(
  definition: OverviewDefinition,
  document: OverviewDocument,
): OverviewDefinition {
  return { ...definition, defaults: document.widgets };
}

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof RuntimeError && error.code === 'RUNTIME_REVISION_CONFLICT'
  );
}

function storedOverride(row: OverviewOverrideRecord | null): {
  value: unknown;
  issues: OverviewIssue[];
} {
  if (!row) return { value: null, issues: [] };
  try {
    return { value: JSON.parse(row.overrideJson), issues: [] };
  } catch {
    return {
      value: null,
      issues: [
        {
          widgetId: null,
          type: null,
          code: 'malformed',
          message: 'stored override is not JSON',
        },
      ],
    };
  }
}

function resolveTier(
  definition: OverviewDefinition,
  registry: WidgetRegistry,
  row: OverviewOverrideRecord | null,
): OverviewTierState {
  const stored = storedOverride(row);
  const resolved = resolveOverview(definition, stored.value, registry);
  return {
    base: resolved.base,
    document: resolved.document,
    override: resolved.override,
    revision: row?.revision ?? null,
    issues: [...stored.issues, ...resolved.overrideIssues],
  };
}

async function hasPermission(
  principal: OverviewPrincipal,
  slug: string,
  db: DatabaseInterface,
): Promise<boolean> {
  const decision = await checkOperationPermission({
    collection: OVERVIEW_PERMISSION_COLLECTION,
    action: slug.slice(OVERVIEW_PERMISSION_COLLECTION.length + 1),
    db,
    tenantId: principal.tenantId,
    userId: principal.userId ?? null,
    permissionSet: principal.permissions,
    onDeny: 'return',
  });
  return decision.allowed;
}

async function canWrite(
  principal: OverviewPrincipal,
  scope: OverviewScope,
  db: DatabaseInterface,
): Promise<boolean> {
  if (scope === 'user') {
    return (
      Boolean(principal.userId) &&
      (await hasPermission(principal, PERSONALIZE_OVERVIEW_PERMISSION, db))
    );
  }
  return hasPermission(principal, CUSTOMIZE_OVERVIEW_PERMISSION, db);
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
 * The persistence and server-load API of overview surfaces. One per database;
 * every call acts as the ambient principal.
 */
export function createOverviewStore(
  options: OverviewStoreOptions,
): OverviewStore {
  const { db } = options;
  const collection = (): Promise<OverviewOverrideRecordCollection> =>
    OverviewOverrideRecordCollection.create({ db });

  async function readState(
    principal: OverviewPrincipal,
    definition: OverviewDefinition,
    registry: WidgetRegistry,
  ): Promise<OverviewState> {
    const records = await collection();
    const [tenantRow, userRow] = await Promise.all([
      records.findTier(principal.tenantId, definition.id, 'tenant'),
      principal.userId
        ? records.findTier(
            principal.tenantId,
            definition.id,
            'user',
            principal.userId,
          )
        : Promise.resolve(null),
    ]);
    const tenant = resolveTier(definition, registry, tenantRow);
    const user = principal.userId
      ? resolveTier(
          withTenantDefaults(definition, tenant.document),
          registry,
          userRow,
        )
      : null;
    const [tenantWrite, userWrite] = await Promise.all([
      canWrite(principal, 'tenant', db),
      canWrite(principal, 'user', db),
    ]);
    return {
      overviewId: definition.id,
      tenant,
      user,
      document: user?.document ?? tenant.document,
      issues: [...tenant.issues, ...(user?.issues ?? [])],
      canCustomize: { tenant: tenantWrite, user: userWrite },
    };
  }

  const store: OverviewStore = {
    async load(definition, registry) {
      const principal = requireOverviewPrincipal();
      return withPrincipal(principal, () =>
        readState(principal, definition, registry),
      );
    },

    async save(definition, registry, input) {
      const principal = requireOverviewPrincipal();
      return withPrincipal(principal, async () => {
        if (!(await canWrite(principal, input.scope, db))) {
          return { ok: false, reason: 'not_allowed' };
        }
        const records = await collection();
        let scopeDefinition = definition;
        if (input.scope === 'user') {
          const tenantRow = await records.findTier(
            principal.tenantId,
            definition.id,
            'tenant',
          );
          const tenant = resolveTier(definition, registry, tenantRow);
          scopeDefinition = withTenantDefaults(definition, tenant.document);
        }
        const checked = checkOverviewOverride(
          scopeDefinition,
          input.override,
          registry,
        );
        if (!checked.ok) {
          return { ok: false, reason: 'invalid', issues: checked.issues };
        }
        const userId = input.scope === 'user' ? principal.userId : undefined;
        const existing = await records.findTier(
          principal.tenantId,
          definition.id,
          input.scope,
          userId,
        );
        const revision = input.revision ?? null;
        if (checked.override === null) {
          // Back on the tier below: store nothing.
          if (!existing) {
            return revision === null
              ? { ok: true, override: null, revision: null }
              : { ok: false, reason: 'conflict' };
          }
          if (revision === null) return { ok: false, reason: 'conflict' };
          try {
            await existing.delete({ expectedUpdatedAt: revision });
          } catch (error) {
            if (isRevisionConflict(error)) {
              return { ok: false, reason: 'conflict' };
            }
            throw error;
          }
          return { ok: true, override: null, revision: null };
        }
        if (existing) {
          if (revision === null) return { ok: false, reason: 'conflict' };
          existing.setOverride(checked.override);
          try {
            await existing.save({ expectedUpdatedAt: revision });
          } catch (error) {
            if (isRevisionConflict(error)) {
              return { ok: false, reason: 'conflict' };
            }
            throw error;
          }
          return {
            ok: true,
            override: checked.override,
            revision: existing.revision,
          };
        }
        if (revision !== null) return { ok: false, reason: 'conflict' };
        try {
          const created = await records.create({
            tenantId: principal.tenantId,
            overviewId: definition.id,
            scopeType: input.scope,
            userId: userId ?? null,
            overrideJson: JSON.stringify(checked.override),
            formatVersion: 1,
            _insertOnly: true,
          });
          return {
            ok: true,
            override: checked.override,
            revision: created.revision,
          };
        } catch (error) {
          // A concurrent first write took the natural key: the strict insert
          // refuses instead of overwriting it.
          const raced = await records.findTier(
            principal.tenantId,
            definition.id,
            input.scope,
            userId,
          );
          if (raced) return { ok: false, reason: 'conflict' };
          throw error;
        }
      });
    },

    async reset(definition, input) {
      const principal = requireOverviewPrincipal();
      return withPrincipal(principal, async () => {
        if (!(await canWrite(principal, input.scope, db))) {
          return { ok: false, reason: 'not_allowed' };
        }
        const records = await collection();
        const existing = await records.findTier(
          principal.tenantId,
          definition.id,
          input.scope,
          input.scope === 'user' ? principal.userId : undefined,
        );
        if (!existing) return { ok: true };
        try {
          await existing.delete(
            typeof input.revision === 'string'
              ? { expectedUpdatedAt: input.revision }
              : {},
          );
        } catch (error) {
          if (isRevisionConflict(error)) {
            return { ok: false, reason: 'conflict' };
          }
          throw error;
        }
        return { ok: true };
      });
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
