import { getPackageConfig } from '@happyvertical/smrt-config';
import type {
  SmrtClassOptions,
  SmrtCollectionOptions,
} from '@happyvertical/smrt-core';
import { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import type { PromptOverride } from './models/PromptOverride.js';
import {
  assertValidPromptScope,
  type PromptOverrideAuthorizer,
  PromptOverrideService,
} from './prompt-override-service.js';
import { PromptRegistry } from './prompt-registry.js';
import {
  APP_PROMPT_SCOPE_ID,
  type PromptDefinition,
  type PromptEditableConfig,
  type PromptLayer,
  type PromptOverrideScopeType,
  type PromptPackageConfig,
} from './types.js';
import { mergePromptLayers, normalizePromptLayer } from './utils.js';

function getPromptConfig(): PromptPackageConfig {
  return getPackageConfig<PromptPackageConfig>('prompts', {
    profiles: {},
    prompts: {},
  });
}

/**
 * The caller's options with its list bounds removed.
 *
 * `SmrtCollection.create()` forwards `defaultListLimit`/`maxListLimit` from
 * any options bag it is handed (#2367), so a host that sets those
 * application-wide would silently cap the bulk override-enumeration read
 * {@link PromptSettingsService.listPromptSettings} runs
 * (`getOverrideMapForKeys`) — a management screen showing every prompt, not a
 * user-facing page of results. A dropped row here is an override an operator
 * cannot see, and the prompt then reports as unoverridden, silently (the
 * `#3056` hazard class in `@happyvertical/smrt-features`'s `getOverrideMap`,
 * applied here proactively rather than left for a follow-up). Only the list
 * bounds are stripped; the database and every other option still apply.
 */
function withoutListBounds(
  options: SmrtClassOptions | SmrtCollectionOptions,
): SmrtCollectionOptions {
  return { ...options, defaultListLimit: undefined, maxListLimit: undefined };
}

/** The level that supplied a prompt's effective template. */
export type PromptSettingsLevel = 'default' | 'config' | 'app' | 'tenant';

/**
 * One prompt, rendered for a management screen: the code-owned definition,
 * the text actually in effect for the requested tenant, and the raw override
 * state at each scope so the UI can show *why* it is in effect and what
 * reverting a scope produces.
 */
export interface PromptSettingsRow {
  /**
   * The persisted identifier. Renaming it orphans every existing override —
   * see the warning on {@link PromptSettingsService}.
   */
  key: string;
  /** Human description from the definition; may be empty. */
  description: string;
  /** Which fields a stored override may change, from the definition. */
  editable: PromptEditableConfig;
  /** The code-registered template, before the config layer or any override. */
  defaultTemplate: string;
  /**
   * What {@link resolvePrompt} resolves the template to for the requested
   * context — the text the application actually uses (unrendered: no
   * `{variable}` substitution).
   */
  effectiveTemplate: string;
  /** The app-level override row's `template` field, or `null` when there is none. */
  appTemplate: string | null;
  /**
   * The tenant-level override row's `template` field, or `null` when there is
   * none (or when no `tenantId` was requested).
   */
  tenantTemplate: string | null;
  /**
   * What the **app** scope's "revert to default" produces: the code default
   * merged with the config-file layer. Always knowable — nothing sits above
   * the app scope — unlike {@link inheritedTemplate}.
   */
  appDefaultTemplate: string;
  /**
   * What the **tenant** scope's "revert to default" produces: the code
   * default, the config-file layer, and the app-level override, merged with
   * no tenant override of its own. `null` when no `tenantId` was requested.
   *
   * This is the value a "revert to default" control for the tenant scope must
   * show or apply — never {@link defaultTemplate}, which ignores the config
   * layer and any app-level override and would silently discard them.
   */
  inheritedTemplate: string | null;
  /** Which level supplied {@link effectiveTemplate}. */
  supplyingLevel: PromptSettingsLevel;
}

/** Selection for {@link PromptSettingsService.listPromptSettings}. */
export interface ListPromptSettingsOptions {
  /**
   * Tenant whose overrides and effective template to report. Omit for an
   * app-only view.
   */
  tenantId?: string | null;
  /**
   * Restrict to an explicit allowlist of keys. Keys with no definition are
   * simply absent from the result — this filters, it does not validate.
   */
  keys?: string[];
}

/** One override write requested through {@link PromptSettingsService}. */
export interface SetPromptOverrideRequest {
  key: string;
  scopeType: PromptOverrideScopeType;
  scopeId: string;
  /** `null` clears the override, returning the scope to whatever it inherits. */
  template: string | null;
}

/**
 * Thrown when a write names a `key` that has no registered {@link PromptDefinition}.
 * Nothing is written.
 *
 * This is the generalized form of the per-app "is this one of my keys?" guard
 * every consumer would otherwise hand-roll to keep a form post from creating an
 * override for an arbitrary string.
 */
export class UnknownPromptKeyError extends Error {
  readonly status = 400;
  constructor(readonly key: string) {
    super(`Unknown prompt key: ${key}`);
    this.name = 'UnknownPromptKeyError';
  }
}

/**
 * Thrown when a write would set a field the definition's `editable` config
 * does not allow overriding. Nothing is written.
 */
export class PromptFieldNotEditableError extends Error {
  readonly status = 400;
  constructor(
    readonly key: string,
    readonly field: string,
  ) {
    super(`Prompt "${key}" does not allow ${field} overrides`);
    this.name = 'PromptFieldNotEditableError';
  }
}

/** Options for {@link PromptSettingsService.create}. */
export interface PromptSettingsServiceOptions {
  /**
   * The host's authorization decision for each override write, bound to the
   * current caller. **Omitting it makes the service read-only**: every write
   * then fails closed with `PromptOverrideAuthorizationError`. This package
   * never decides who may write.
   */
  authorize?: PromptOverrideAuthorizer;
}

/**
 * Read and write side of a prompt management screen, so consumers do not
 * re-derive the row shape or the unknown-key guard.
 *
 * **Authorization stays with the consumer.** This service makes no
 * authorization decision of its own: reads are unfiltered, and every write is
 * delegated to {@link PromptOverrideService}, which asks the host-supplied
 * {@link PromptOverrideAuthorizer} first and fails closed. Call it only from
 * server code that has already established who the caller is. See
 * `packages/prompts/README.md` for the consumer recipe.
 *
 * **Prompt keys are persisted identifiers.** Overrides are stored keyed by the
 * exact `key` string and resolved by that string at runtime. Renaming a key
 * orphans every existing override, silently reverting all tenants to the
 * registry default. Treat a key as immutable once shipped; a rename needs a
 * data migration, not an edit.
 */
export class PromptSettingsService {
  private readonly writes: PromptOverrideService;

  constructor(
    private readonly overrides: PromptOverrideCollection,
    authorize?: PromptOverrideAuthorizer,
  ) {
    this.writes = new PromptOverrideService(
      overrides,
      authorize ?? (() => false),
    );
  }

  /**
   * Build a service over the given database options.
   *
   * The internal bulk override-enumeration read {@link listPromptSettings}
   * runs is always issued without the caller's
   * `defaultListLimit`/`maxListLimit` — see {@link withoutListBounds}. Only
   * that read is affected; a `db` option is still honored.
   *
   * @param options - SMRT database options, as passed to any collection.
   * @param serviceOptions - Host authorizer. Omit for a read-only (load-function) service.
   */
  static async create(
    options: SmrtClassOptions = {},
    serviceOptions: PromptSettingsServiceOptions = {},
  ): Promise<PromptSettingsService> {
    const overrides = await PromptOverrideCollection.create(
      withoutListBounds(options),
    );
    return new PromptSettingsService(
      overrides as PromptOverrideCollection,
      serviceOptions.authorize,
    );
  }

  /**
   * One {@link PromptSettingsRow} per matching registered prompt, ordered by
   * key, so a rendered list is stable across loads.
   *
   * Makes no authorization decision — the caller has already decided that this
   * principal may see this tenant's prompts.
   */
  async listPromptSettings(
    options: ListPromptSettingsOptions = {},
  ): Promise<PromptSettingsRow[]> {
    const definitions = this.loadDefinitions(options);
    const keys = definitions.map((definition) => definition.key);
    const tenantId = options.tenantId;

    // Two bulk reads instead of up to 2N: see getOverrideMapForKeys for why
    // these must run through a bounds-stripped collection (#3056 class).
    const [appOverrides, tenantOverrides] = await Promise.all([
      this.overrides.getOverrideMapForKeys(keys, 'app', APP_PROMPT_SCOPE_ID),
      tenantId
        ? this.overrides.getOverrideMapForKeys(keys, 'tenant', tenantId)
        : Promise.resolve(new Map<string, PromptOverride>()),
    ]);

    return definitions.map((definition) =>
      this.toRow(
        definition,
        tenantId,
        appOverrides.get(definition.key) ?? null,
        tenantOverrides.get(definition.key) ?? null,
      ),
    );
  }

  /** The single row for one key, or `null` when no definition owns that key. */
  async getPromptSetting(
    key: string,
    tenantId?: string | null,
  ): Promise<PromptSettingsRow | null> {
    const definition = PromptRegistry.get(key);
    if (!definition) {
      return null;
    }

    const [appOverride, tenantOverride] = await Promise.all([
      this.overrides.getAppOverride(key),
      tenantId
        ? this.overrides.getTenantOverride(key, tenantId)
        : Promise.resolve(null),
    ]);

    return this.toRow(definition, tenantId, appOverride, tenantOverride);
  }

  /**
   * Apply one override change to the `template` field.
   *
   * Refuses any `key` without a registered {@link PromptDefinition}, any scope
   * the resolver would never read back, and a non-`null` template when the
   * definition's `editable.template` is `false`, then delegates to
   * {@link PromptOverrideService} so the host authorizer decides whether this
   * caller may write this scope. `template: null` clears the override.
   *
   * @throws {UnknownPromptKeyError} when the key has no definition.
   * @throws {InvalidPromptScopeError} when the scope is not one the resolver reads.
   * @throws {PromptFieldNotEditableError} when the definition disallows template overrides.
   * @throws `PromptOverrideAuthorizationError` when the authorizer declines.
   */
  async setPromptOverride(
    request: SetPromptOverrideRequest,
  ): Promise<PromptOverride> {
    const { key, scopeType, scopeId, template } = request;

    assertValidPromptScope(scopeType, scopeId);
    const definition = this.assertKnownPromptKey(key);

    if (template !== null && !definition.editable.template) {
      throw new PromptFieldNotEditableError(key, 'template');
    }

    return this.writes.setTemplateOverride(key, scopeType, scopeId, template);
  }

  /** {@link setPromptOverride} for the app-wide scope. */
  async setAppPromptOverride(
    key: string,
    template: string | null,
  ): Promise<PromptOverride> {
    return this.setPromptOverride({
      key,
      scopeType: 'app',
      scopeId: APP_PROMPT_SCOPE_ID,
      template,
    });
  }

  /** {@link setPromptOverride} for one tenant. */
  async setTenantPromptOverride(
    key: string,
    tenantId: string,
    template: string | null,
  ): Promise<PromptOverride> {
    return this.setPromptOverride({
      key,
      scopeType: 'tenant',
      scopeId: tenantId,
      template,
    });
  }

  private assertKnownPromptKey(key: string): PromptDefinition {
    const trimmed = typeof key === 'string' ? key.trim() : '';
    if (!trimmed || trimmed !== key) {
      throw new UnknownPromptKeyError(String(key));
    }
    const definition = PromptRegistry.get(trimmed);
    if (!definition) {
      throw new UnknownPromptKeyError(trimmed);
    }
    return definition;
  }

  private loadDefinitions(
    options: ListPromptSettingsOptions,
  ): PromptDefinition[] {
    const all = PromptRegistry.getAll();
    const allowed = options.keys ? new Set(options.keys) : null;
    const selected = allowed
      ? all.filter((definition) => allowed.has(definition.key))
      : all;

    return [...selected].sort((a, b) => a.key.localeCompare(b.key));
  }

  private toRow(
    definition: PromptDefinition,
    tenantId: string | null | undefined,
    appOverride: PromptOverride | null,
    tenantOverride: PromptOverride | null,
  ): PromptSettingsRow {
    const { key } = definition;
    const config = getPromptConfig();

    const registryLayer: PromptLayer = {
      template: definition.template,
      profile: definition.ai.profile ?? null,
      model: definition.ai.model ?? null,
      params: definition.ai.params,
    };
    const configLayer = normalizePromptLayer(config.prompts?.[key]);

    const appLayer = appOverride ? appOverride.toPromptLayer() : null;
    const tenantLayer = tenantOverride ? tenantOverride.toPromptLayer() : null;

    // What the "app" scope's own revert-to-default produces: registry + config
    // only. This intentionally excludes the app override itself, so it must
    // NOT be reused as the app-only effective value below (that bug shipped
    // and broke both `effectiveTemplate` when no tenant is requested and every
    // tenant's inherited fallback until caught by this package's own tests).
    const appDefaultMerge = mergePromptLayers(registryLayer, configLayer);
    const inheritedMerge = tenantId
      ? mergePromptLayers(registryLayer, configLayer, appLayer)
      : null;
    // The effective template always includes the app override when present;
    // only the tenant layer is conditional on a requested tenantId.
    const effectiveMerge = mergePromptLayers(
      registryLayer,
      configLayer,
      appLayer,
      tenantId ? tenantLayer : null,
    );

    const appTemplate = appOverride?.template ?? null;
    const tenantTemplate = tenantId ? (tenantOverride?.template ?? null) : null;

    let supplyingLevel: PromptSettingsLevel = 'default';
    if (tenantId && tenantTemplate != null) {
      supplyingLevel = 'tenant';
    } else if (appTemplate != null) {
      supplyingLevel = 'app';
    } else if (configLayer.template != null) {
      supplyingLevel = 'config';
    }

    return {
      key,
      description: definition.description,
      editable: definition.editable,
      defaultTemplate: definition.template,
      effectiveTemplate: effectiveMerge.template,
      appTemplate,
      tenantTemplate,
      appDefaultTemplate: appDefaultMerge.template,
      inheritedTemplate: inheritedMerge ? inheritedMerge.template : null,
      supplyingLevel,
    };
  }
}

/**
 * Reject a scope the resolver would never read back.
 *
 * `PromptOverride` rows are looked up by the exact `(key, tenantId)` pair —
 * `tenantId: null` for the app scope, a tenant id otherwise. A row written
 * under a scope nothing queries is invisible state: it never takes effect,
 * and the host authorizer cannot catch it, because `scopeType: 'app'` with
 * someone else's tenant id looks like an ordinary app write to an authorizer
 * that only gates the app scope.
 */
