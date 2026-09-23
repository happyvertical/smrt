/**
 * @happyvertical/smrt-features/svelte
 *
 * Optional Svelte 5 UI for feature-flag management. Presentational only: the
 * panel takes rows and callbacks, does no fetching, and makes no authorization
 * decision. Hosts render it from a server load that used
 * `FeatureSettingsService` and wire saves to their own permission-checked
 * route. The root `@happyvertical/smrt-features` export stays Svelte-free.
 *
 * @packageDocumentation
 */

import type { ComponentProps } from 'svelte';
import FeatureSettingsPanel from './components/FeatureSettingsPanel.svelte';

export { FeatureSettingsPanel };
export type FeatureSettingsPanelProps = ComponentProps<
  typeof FeatureSettingsPanel
>;

export {
  defaultOptionLabel,
  effectiveStateLabel,
  type FeatureSettingsChange,
  type FeatureSettingsEffect,
  type FeatureSettingsView,
  toFeatureSettingsEffect,
} from './types.js';
