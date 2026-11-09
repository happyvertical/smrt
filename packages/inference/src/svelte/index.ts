/**
 * @happyvertical/smrt-inference/svelte
 *
 * Optional Svelte 5 UI for inference settings (#4754). Presentational only:
 * the panel takes rows and callbacks, does no fetching, and makes no
 * authorization decision. Hosts render it from a server load that used
 * `InferenceSettingsService` (`./server`) and wire saves to their own
 * permission-checked actions. The root entry stays Svelte-free.
 *
 * @packageDocumentation
 */

import type { ComponentProps } from 'svelte';
import InferenceSettingsPanel from './components/InferenceSettingsPanel.svelte';

export { InferenceSettingsPanel };
export type InferenceSettingsPanelProps = ComponentProps<
  typeof InferenceSettingsPanel
>;

export {
  candidateViewLabel,
  defaultTierRevertPreview,
  describeTargetView,
  INFERENCE_SETTINGS_MODES,
  INFERENCE_SETTINGS_TIERS,
  type InferenceAliasChange,
  type InferenceAliasView,
  type InferenceCandidateView,
  type InferenceConnectionRequest,
  type InferenceDefaultsChange,
  type InferenceDefaultsView,
  type InferenceDefaultTierChange,
  type InferenceDefaultTierView,
  type InferenceDiscoveryView,
  type InferenceFusionChange,
  type InferenceFusionView,
  type InferenceKeyChange,
  type InferenceProviderView,
  type InferenceSettingsLevelView,
  type InferenceSettingsMode,
  type InferenceSettingsScope,
  type InferenceSettingsTier,
  type InferenceTargetView,
  type InferenceTestResultView,
  type InferenceTierChange,
  type InferenceTierView,
  type InferenceTranscriptLinkFilters,
  type InferenceTranscriptSettingsChange,
  type InferenceTranscriptSettingsView,
  type InferenceTranscriptValuesView,
  type InferenceUsageDimension,
  type InferenceUsageView,
  inferenceLevelLabel,
  isRefAllowed,
  targetViewRef,
  tierRevertPreview,
  transcriptLinkFilters,
  usageColumns,
} from './types.js';
