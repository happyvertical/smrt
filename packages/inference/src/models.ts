/**
 * @happyvertical/smrt-inference/models — the `_smrt_inference_overrides`
 * model (#4754). Generated consumer registration imports it from here; apps
 * write through `InferenceSettingsService` / `InferenceOverrideService` in
 * `./server`, never through the collection directly unless they made their
 * own authorization decision.
 */

// Self-register this package's manifest before the decorator fires (#1132).
import './__smrt-register__.js';

export {
  APP_INFERENCE_SCOPE_ID,
  InferenceOverride,
  type InferenceOverrideOptions,
} from './models/InferenceOverride.js';
export {
  InferenceOverrideCollection,
  type InferenceOverrideScopeType,
} from './models/InferenceOverrideCollection.js';
