/**
 * @happyvertical/smrt-overviews
 *
 * Production persistence for the customizable overview surfaces of
 * `@happyvertical/smrt-svelte/overview` (#3727 phase 3): tenant defaults and
 * per-user overrides in the `_smrt_overview_overrides` system table, with the
 * server load, save, reset and widget-load helpers a page calls.
 *
 * @packageDocumentation
 */

import './__smrt-register__.js';

export { OverviewOverrideRecordCollection } from './collections/OverviewOverrideRecordCollection.js';
export {
  getOverviewPrincipal,
  OverviewAccessError,
  type OverviewPrincipal,
} from './context.js';
export {
  OVERVIEW_SCOPES,
  OverviewOverrideRecord,
  type OverviewScope,
  TENANT_SCOPE_KEY,
} from './models/OverviewOverrideRecord.js';
export {
  CUSTOMIZE_OVERVIEW_PERMISSION,
  ensureOverviewPermissionsRegistered,
  OVERVIEW_PERMISSION_COLLECTION,
  OVERVIEW_PERMISSION_DEFINITIONS,
  PERSONALIZE_OVERVIEW_PERMISSION,
} from './permissions.js';
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
  withTenantDefaults,
} from './store.js';
