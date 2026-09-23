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
 * What a feature resolves to for a tenant with no override of its own — the
 * global override when there is one, otherwise the code default.
 *
 * This, not `defaultEnabled`, is what returning the *tenant* scope to Default
 * actually produces. Labelling that option from `defaultEnabled` would tell an
 * operator "Default (disabled)" for a feature a global override has enabled,
 * and choosing it would leave the feature on.
 *
 * A row that omits `globalEffect` is read as having no global override.
 */
export function inheritedEnabled(feature: FeatureSettingsView): boolean {
  if (feature.globalEffect === 'enable') return true;
  if (feature.globalEffect === 'disable') return false;
  return feature.defaultEnabled;
}

/** Badge text for a feature's effective state. */
export function effectiveStateLabel(effectiveEnabled: boolean): string {
  return effectiveEnabled ? 'Enabled' : 'Disabled';
}
