import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import type { FeatureDefinition } from './feature-definition.js';
import { FeatureDefinitionCollection } from './feature-definitions.js';
import type { FeatureOverride } from './feature-override.js';
import {
  type FeatureOverrideAuthorizer,
  FeatureOverrideService,
} from './feature-override-service.js';
import { FeatureOverrideCollection } from './feature-overrides.js';
import { FeatureResolver } from './feature-resolver.js';
import {
  type FeatureMetadata,
  FeatureOverrideEffect,
  type FeatureResolverOptions,
  type FeatureScopeType,
  GLOBAL_FEATURE_SCOPE_ID,
} from './types.js';

/**
 * One feature, rendered for a management screen: the code-owned definition,
 * the value that is actually in effect for the requested tenant, and the raw
 * override row at each scope level so the UI can show *why* it is in effect.
 *
 * Structurally assignable to the presentational `FeatureSettingsView` consumed
 * by `@happyvertical/smrt-features/svelte`, so a server load can hand its rows
 * straight to `FeatureSettingsPanel` without a mapping step.
 */
export interface FeatureSettingsRow {
  /**
   * The persisted identifier. Renaming it orphans every existing override —
   * see the warning on {@link FeatureSettingsService}.
   */
  featureKey: string;
  /** Human label from the definition; may be empty. */
  label: string;
  /** Human description from the definition; may be empty. */
  description: string;
  /** Owning package, as synced from the manifest. */
  packageName: string;
  /** Qualified `package:Class` name of the feature's target. */
  qualifiedClassName: string;
  /** Unqualified class name of the feature's target. */
  className: string;
  /** Class-local feature id. */
  localId: string;
  /** Definition visibility marker (`public` unless the seed says otherwise). */
  visibility: string;
  /** Parsed definition metadata. */
  metadata: FeatureMetadata;
  /** The code-owned default, used when no override applies. */
  defaultEnabled: boolean;
  /**
   * What {@link FeatureResolver} resolves for the requested context — the
   * value the application actually behaves by.
   */
  effectiveEnabled: boolean;
  /** Effect of the global override row, or `null` when there is none. */
  globalEffect: FeatureOverrideEffect | null;
  /**
   * Effect of the override row for the requested tenant, or `null` when there
   * is none (or when no `tenantId` was requested).
   */
  tenantEffect: FeatureOverrideEffect | null;
  /**
   * What this feature resolves to for the requested tenant with **no override
   * of its own** — the state that removing the tenant override would produce,
   * which is what a management UI must name on its "back to Default" control.
   *
   * `null` when no `tenantId` was requested — nothing tenant-inherited was
   * computed, and the global state is not an answer to a question about a
   * tenant — and `null` when the tenant holds an override of its own, because
   * then the inherited state depends on the levels above this tenant, which a
   * configured `FeatureTenantHierarchyProvider` extends to ancestor tenants'
   * overrides. It is reported only for a requested tenant with no override of
   * its own, where the inherited state *is* the effective state. Rows that
   * leave it `null` get the neutral "Default (inherited)" label in the panel,
   * never a claim about a state nothing computed.
   */
  inheritedEnabled: boolean | null;
}

/** Selection for {@link FeatureSettingsService.listFeatureSettings}. */
export interface ListFeatureSettingsOptions {
  /**
   * Tenant whose overrides and effective values to report. Omit for a
   * global-only view.
   */
  tenantId?: string;
  /** Restrict to one owning package (the usual case for an app's own screen). */
  packageName?: string;
  /**
   * Restrict to an explicit allowlist of keys. Keys with no definition are
   * simply absent from the result — this filters, it does not validate.
   */
  featureKeys?: string[];
}

/** One override write requested through {@link FeatureSettingsService}. */
export interface SetFeatureOverrideRequest {
  featureKey: string;
  scopeType: FeatureScopeType;
  scopeId: string;
  /**
   * `INHERIT` removes the override row at that scope, returning the feature to
   * whatever the next level up resolves to.
   */
  effect: FeatureOverrideEffect;
}

/**
 * Thrown when a write names a `featureKey` that has no {@link FeatureDefinition}
 * row. Nothing is written.
 *
 * This is the generalized form of the per-app "is this one of my keys?" guard
 * every consumer would otherwise hand-roll to keep a form post from creating an
 * override for an arbitrary string.
 */
export class UnknownFeatureKeyError extends Error {
  readonly status = 400;
  constructor(readonly featureKey: string) {
    super(`Unknown feature key: ${featureKey}`);
    this.name = 'UnknownFeatureKeyError';
  }
}

/** Options for {@link FeatureSettingsService.create}. */
export interface FeatureSettingsServiceOptions {
  /**
   * The host's authorization decision for each override write, bound to the
   * current caller. **Omitting it makes the service read-only**: every write
   * then fails closed with `FeatureOverrideAuthorizationError`. This
   * package never decides who may write.
   */
  authorize?: FeatureOverrideAuthorizer;
  /** Forwarded to {@link FeatureResolver} (e.g. the tenant-hierarchy loader). */
  resolver?: FeatureResolverOptions;
}

const KNOWN_EFFECTS = new Set<string>(Object.values(FeatureOverrideEffect));

/**
 * Coerce an untrusted value (a form field, a query parameter, a JSON body) to a
 * {@link FeatureOverrideEffect}. Anything unrecognized — including `null` and
 * `undefined` — becomes `INHERIT`, i.e. "back to the default", which is the
 * safe reading of a value the host could not parse.
 */
export function featureOverrideEffectFromValue(
  value: unknown,
): FeatureOverrideEffect {
  if (value === FeatureOverrideEffect.ENABLE)
    return FeatureOverrideEffect.ENABLE;
  if (value === FeatureOverrideEffect.DISABLE)
    return FeatureOverrideEffect.DISABLE;
  return FeatureOverrideEffect.INHERIT;
}

/**
 * Read and write side of a feature-flag management screen, so consumers do not
 * re-derive the row shape or the unknown-key guard.
 *
 * **Authorization stays with the consumer.** This service makes no
 * authorization decision of its own: reads are unfiltered, and every write is
 * delegated to {@link FeatureOverrideService}, which asks the host-supplied
 * {@link FeatureOverrideAuthorizer} first and fails closed. Call it only from
 * server code that has already established who the caller is. See
 * `packages/features/README.md` for the consumer recipe.
 *
 * **Feature keys are persisted identifiers.** Overrides are stored keyed by the
 * exact `featureKey` string and resolved by that string at runtime. Renaming a
 * key orphans every existing override, silently reverting all tenants to the
 * definition default. Treat a key as immutable once shipped; a rename needs a
 * data migration, not an edit.
 */
export class FeatureSettingsService {
  private readonly writes: FeatureOverrideService;

  constructor(
    private readonly definitions: FeatureDefinitionCollection,
    private readonly overrides: FeatureOverrideCollection,
    private readonly resolver: FeatureResolver,
    authorize?: FeatureOverrideAuthorizer,
  ) {
    this.writes = new FeatureOverrideService(
      overrides,
      authorize ?? (() => false),
    );
  }

  /**
   * Build a service over the given database options.
   *
   * @param options - SMRT database options, as passed to any collection.
   * @param serviceOptions - Host authorizer and resolver wiring. Omit
   *   `authorize` for a read-only (load-function) service.
   */
  static async create(
    options: SmrtClassOptions = {},
    serviceOptions: FeatureSettingsServiceOptions = {},
  ): Promise<FeatureSettingsService> {
    const [definitions, overrides] = await Promise.all([
      FeatureDefinitionCollection.create(options),
      FeatureOverrideCollection.create(options),
    ]);
    return new FeatureSettingsService(
      definitions as FeatureDefinitionCollection,
      overrides as FeatureOverrideCollection,
      new FeatureResolver(options, serviceOptions.resolver ?? {}),
      serviceOptions.authorize,
    );
  }

  /**
   * One {@link FeatureSettingsRow} per matching definition, ordered by owning
   * package, then label, then key, so a rendered list is stable across loads.
   *
   * Makes no authorization decision — the caller has already decided that this
   * principal may see this tenant's flags.
   */
  async listFeatureSettings(
    options: ListFeatureSettingsOptions = {},
  ): Promise<FeatureSettingsRow[]> {
    const definitions = await this.loadDefinitions(options);

    return Promise.all(
      definitions.map((definition) => this.toRow(definition, options.tenantId)),
    );
  }

  /** The single row for one key, or `null` when no definition owns that key. */
  async getFeatureSetting(
    featureKey: string,
    tenantId?: string,
  ): Promise<FeatureSettingsRow | null> {
    const definition = await this.definitions.findByFeatureKey(featureKey);
    return definition ? this.toRow(definition, tenantId) : null;
  }

  /**
   * Apply one override change.
   *
   * Refuses any `featureKey` without a {@link FeatureDefinition} row, then
   * delegates to {@link FeatureOverrideService} so the host authorizer decides
   * whether this caller may write this scope. `INHERIT` removes the row.
   *
   * @returns the stored override, or `null` when the row was removed (or was
   *   already absent).
   * @throws {UnknownFeatureKeyError} when the key has no definition.
   * @throws `FeatureOverrideAuthorizationError` when the authorizer declines.
   */
  async setFeatureOverride(
    request: SetFeatureOverrideRequest,
  ): Promise<FeatureOverride | null> {
    const { featureKey, scopeType, scopeId, effect } = request;

    if (!KNOWN_EFFECTS.has(effect)) {
      throw new TypeError(`Unknown feature override effect: ${String(effect)}`);
    }
    await this.assertKnownFeatureKey(featureKey);

    if (effect === FeatureOverrideEffect.INHERIT) {
      await this.writes.removeOverride(featureKey, scopeType, scopeId);
      return null;
    }

    return this.writes.setOverride(featureKey, scopeType, scopeId, effect);
  }

  /** {@link setFeatureOverride} for the global scope. */
  async setGlobalFeatureOverride(
    featureKey: string,
    effect: FeatureOverrideEffect,
  ): Promise<FeatureOverride | null> {
    return this.setFeatureOverride({
      featureKey,
      scopeType: 'global',
      scopeId: GLOBAL_FEATURE_SCOPE_ID,
      effect,
    });
  }

  /** {@link setFeatureOverride} for one tenant. */
  async setTenantFeatureOverride(
    featureKey: string,
    tenantId: string,
    effect: FeatureOverrideEffect,
  ): Promise<FeatureOverride | null> {
    return this.setFeatureOverride({
      featureKey,
      scopeType: 'tenant',
      scopeId: tenantId,
      effect,
    });
  }

  private async assertKnownFeatureKey(featureKey: string): Promise<void> {
    const key = typeof featureKey === 'string' ? featureKey.trim() : '';
    if (!key || key !== featureKey) {
      throw new UnknownFeatureKeyError(String(featureKey));
    }
    const definition = await this.definitions.findByFeatureKey(key);
    if (!definition) {
      throw new UnknownFeatureKeyError(key);
    }
  }

  private async loadDefinitions(
    options: ListFeatureSettingsOptions,
  ): Promise<FeatureDefinition[]> {
    const definitions = options.packageName
      ? await this.definitions.findByPackageName(options.packageName)
      : await this.definitions.list({});

    const allowed = options.featureKeys ? new Set(options.featureKeys) : null;
    const selected = allowed
      ? definitions.filter((definition) => allowed.has(definition.featureKey))
      : definitions;

    return [...selected].sort(compareDefinitions);
  }

  private async toRow(
    definition: FeatureDefinition,
    tenantId?: string,
  ): Promise<FeatureSettingsRow> {
    const { featureKey } = definition;
    const [globalOverride, tenantOverride, effectiveEnabled] =
      await Promise.all([
        this.overrides.getGlobalOverride(featureKey),
        tenantId
          ? this.overrides.getTenantOverride(featureKey, tenantId)
          : Promise.resolve(null),
        this.resolver.isEnabled(featureKey, tenantId ? { tenantId } : {}),
      ]);

    return {
      featureKey,
      label: definition.label,
      description: definition.description,
      packageName: definition.packageName,
      qualifiedClassName: definition.qualifiedClassName,
      className: definition.className,
      localId: definition.localId,
      visibility: definition.visibility,
      metadata: definition.getMetadata(),
      defaultEnabled: definition.defaultEnabled,
      effectiveEnabled,
      globalEffect: globalOverride?.effect ?? null,
      tenantEffect: tenantOverride?.effect ?? null,
      inheritedEnabled: tenantId && !tenantOverride ? effectiveEnabled : null,
    };
  }
}

function compareDefinitions(
  a: FeatureDefinition,
  b: FeatureDefinition,
): number {
  return (
    a.packageName.localeCompare(b.packageName) ||
    (a.label || a.featureKey).localeCompare(b.label || b.featureKey) ||
    a.featureKey.localeCompare(b.featureKey)
  );
}
