/**
 * Presentational types for the feature-flag management UI.
 *
 * Deliberately free of the `@smrt()` model classes and of `@happyvertical/smrt-core`
 * so the Svelte bundle stays a thin presentation layer. The effect strings match
 * `FeatureOverrideEffect`'s values, so a `FeatureSettingsRow` produced by
 * `FeatureSettingsService.listFeatureSettings()` is structurally assignable to
 * {@link FeatureSettingsView} with no mapping step.
 *
 * @module
 */

/** The three states an override control offers, matching `FeatureOverrideEffect`. */
export type FeatureSettingsEffect = 'inherit' | 'enable' | 'disable';

/** A render-ready view of one feature's settings. */
export interface FeatureSettingsView {
  /**
   * The persisted identifier. Shown verbatim so an operator can correlate the
   * row with code and with support requests — renaming a key orphans its
   * overrides, so it is stable enough to quote.
   */
  featureKey: string;
  /** Human label; falls back to the key when empty. */
  label?: string;
  /** Human description; falls back to the key when empty. */
  description?: string;
  /** Owning package, shown as provenance when present. */
  packageName?: string;
  /** The code-owned default, used to label the "Default" option. */
  defaultEnabled: boolean;
  /** What the resolver reports for the current context. */
  effectiveEnabled: boolean;
  /** Effect of the global override row, or `null`/absent when there is none. */
  globalEffect?: FeatureSettingsEffect | null;
  /** Effect of the tenant override row, or `null`/absent when there is none. */
  tenantEffect?: FeatureSettingsEffect | null;
  /**
   * What this feature resolves to for this tenant with **no override of its
   * own** — the state returning the tenant scope to Default actually produces.
   *
   * Only the server can know this: with a tenant hierarchy configured, an
   * ancestor tenant's override sits between the global scope and this tenant,
   * so it is not derivable from `defaultEnabled` and `globalEffect`. Leave it
   * `null`/absent when it is not known and the panel says "Default (inherited)"
   * rather than naming a state it cannot vouch for.
   */
  inheritedEnabled?: boolean | null;
}

/** One override change requested from the panel. */
export interface FeatureSettingsChange {
  /** The feature the operator was editing. */
  featureKey: string;
  /** Requested tenant-scope effect. */
  tenantEffect: FeatureSettingsEffect;
  /**
   * Requested global-scope effect — present only when the panel rendered an
   * editable global column.
   */
  globalEffect?: FeatureSettingsEffect;
}

/** Narrow an untrusted string to a {@link FeatureSettingsEffect}, defaulting to `inherit`. */
export function toFeatureSettingsEffect(value: unknown): FeatureSettingsEffect {
  return value === 'enable' || value === 'disable' ? value : 'inherit';
}

/** Label for the "back to default" option, naming the state it returns to. */
export function defaultOptionLabel(enabledWhenDefault: boolean): string {
  return `Default (${enabledWhenDefault ? 'enabled' : 'disabled'})`;
}

/**
 * Label for the option that removes the **tenant** override.
 *
 * `defaultEnabled` is the wrong thing to name here: the tenant scope inherits
 * whatever the levels above it resolve to — the global override, and, when a
 * tenant hierarchy is configured, any ancestor tenant's override. So this names
 * the inherited state only when the row carries one, and otherwise says
 * "Default (inherited)" rather than claiming a state it cannot know.
 */
export function inheritedOptionLabel(feature: FeatureSettingsView): string {
  return typeof feature.inheritedEnabled === 'boolean'
    ? defaultOptionLabel(feature.inheritedEnabled)
    : 'Default (inherited)';
}

/** Badge text for a feature's effective state. */
export function effectiveStateLabel(effectiveEnabled: boolean): string {
  return effectiveEnabled ? 'Enabled' : 'Disabled';
}
