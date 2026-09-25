/**
 * Presentational types for the prompt management UI.
 *
 * Deliberately free of the `@smrt()` model classes and of `@happyvertical/smrt-core`
 * so the Svelte bundle stays a thin presentation layer. Field names match
 * `PromptSettingsRow` produced by `PromptSettingsService.listPromptSettings()`,
 * so a row is structurally assignable to {@link PromptSettingsView} with no
 * mapping step.
 *
 * @module
 */

/** Which level supplied a prompt's effective template. */
export type PromptSettingsSupplyingLevel =
  | 'default'
  | 'config'
  | 'app'
  | 'tenant';

/** A render-ready view of one prompt's settings. */
export interface PromptSettingsView {
  /**
   * The persisted identifier. Shown verbatim so an operator can correlate the
   * row with code — renaming a key orphans its overrides, so it is stable
   * enough to quote.
   */
  key: string;
  /** Human description; falls back to the key when empty. */
  description?: string;
  /** The text actually in effect for the requested tenant (unrendered). */
  effectiveTemplate: string;
  /** Which level supplied {@link effectiveTemplate}. */
  supplyingLevel?: PromptSettingsSupplyingLevel;
  /** Whether a stored override may change the template; hides the editor when `false`. */
  editable?: { template?: boolean };
  /** The app-level override's text, or `null`/absent when there is none. */
  appTemplate?: string | null;
  /** The tenant-level override's text, or `null`/absent when there is none. */
  tenantTemplate?: string | null;
  /** What the **app** scope's "revert to default" produces. */
  appDefaultTemplate?: string;
  /**
   * What the **tenant** scope's "revert to default" produces. `null`/absent
   * when not known (e.g. no tenant was requested) — the panel then falls back
   * to {@link appDefaultTemplate} or {@link effectiveTemplate} rather than
   * claiming a value nothing computed.
   */
  inheritedTemplate?: string | null;
}

/** One override change requested from the panel. */
export interface PromptSettingsChange {
  /** The prompt the operator was editing. */
  key: string;
  /**
   * Requested tenant-scope text, or `null` to revert (return the tenant scope
   * to whatever it inherits).
   */
  tenantTemplate: string | null;
  /**
   * Requested app-scope text, or `null` to revert — present only when the
   * panel rendered an editable app column.
   */
  appTemplate?: string | null;
}

/** Human label for {@link PromptSettingsView.supplyingLevel}. */
export function supplyingLevelLabel(
  level: PromptSettingsSupplyingLevel | undefined,
): string {
  switch (level) {
    case 'tenant':
      return 'Tenant override';
    case 'app':
      return 'App override';
    case 'config':
      return 'Config override';
    default:
      return 'Registry default';
  }
}

/**
 * What the tenant scope's "revert to default" control returns to: the app
 * override if there is one, otherwise the config/registry value. Falls back to
 * {@link PromptSettingsView.effectiveTemplate} only when the row supplies
 * neither computed fallback (e.g. a minimal test fixture), rather than
 * rendering nothing.
 */
export function tenantRevertPreview(view: PromptSettingsView): string {
  return (
    view.inheritedTemplate ?? view.appDefaultTemplate ?? view.effectiveTemplate
  );
}

/** What the app scope's "revert to default" control returns to. */
export function appRevertPreview(view: PromptSettingsView): string {
  return view.appDefaultTemplate ?? view.effectiveTemplate;
}

/** Whether the panel may offer an editor for this prompt's template at all. */
export function isTemplateEditable(view: PromptSettingsView): boolean {
  return view.editable?.template !== false;
}
