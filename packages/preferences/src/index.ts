/**
 * @happyvertical/smrt-preferences
 *
 * Tenant defaults and per-user preferences for user-interface surfaces
 * (#3727), stored in the `_smrt_ui_preferences` system table and validated
 * per registered kind. Built-in kinds: `overview` (customizable overview
 * pages of `@happyvertical/smrt-svelte/overview`) and `shell-layout` (the
 * AdminShell settings delta).
 *
 * @packageDocumentation
 */

import './__smrt-register__.js';
import './kinds/builtin.js';

export { UiPreferenceRecordCollection } from './collections/UiPreferenceRecordCollection.js';
export {
  getPreferencePrincipal,
  PreferenceAccessError,
  type PreferencePrincipal,
} from './context.js';
export { ensureBuiltinPreferenceKinds } from './kinds/builtin.js';
export {
  OVERVIEW_PREFERENCE_KIND,
  type OverviewKindOptions,
  overviewPreferenceKind,
  withTenantDefaults,
} from './kinds/overview.js';
export {
  createShellSettingsPreferences,
  SHELL_LAYOUT_PREFERENCE_KIND,
  type ShellSettingsPreferenceRead,
  type ShellSettingsPreferences,
  type ShellSettingsPreferenceWriteOptions,
  shellLayoutPreferenceKind,
} from './kinds/shell-layout.js';
export {
  getPreferenceKind,
  listPreferenceKinds,
  PREFERENCE_KIND_PATTERN,
  PREFERENCE_SCOPES,
  PREFERENCE_SURFACE_PATTERN,
  type PreferenceIssue,
  type PreferenceKindDefinition,
  type PreferenceScope,
  type PreferenceValidateContext,
  type PreferenceValidation,
  registerPreferenceKind,
  requirePreferenceKind,
  UnknownPreferenceKindError,
} from './kinds.js';
export {
  TENANT_SCOPE_KEY,
  UiPreferenceRecord,
} from './models/UiPreferenceRecord.js';
export {
  createOverviewStore,
  type OverviewPageOptions,
  type OverviewResetInput,
  type OverviewResetResult,
  type OverviewSaveInput,
  type OverviewSaveResult,
  type OverviewState,
  type OverviewStore,
  type OverviewStoreOptions,
  type OverviewTierState,
  type OverviewWidgetResult,
  type OverviewWriteFailure,
} from './overview.js';
export {
  CUSTOMIZE_OVERVIEW_PERMISSION,
  CUSTOMIZE_SHELL_PERMISSION,
  ensurePreferencePermissionsRegistered,
  PERSONALIZE_OVERVIEW_PERMISSION,
  PERSONALIZE_SHELL_PERMISSION,
  PREFERENCE_PERMISSION_DEFINITIONS,
  splitPermissionSlug,
} from './permissions.js';
export {
  createPreferenceStore,
  type PreferenceLoadInput,
  type PreferenceResetInput,
  type PreferenceResetResult,
  type PreferenceSaveInput,
  type PreferenceSaveResult,
  type PreferenceState,
  type PreferenceStore,
  type PreferenceStoreOptions,
  type PreferenceTier,
  type PreferenceWriteFailure,
} from './store.js';
