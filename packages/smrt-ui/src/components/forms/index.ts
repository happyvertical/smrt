/**
 * Form primitives — subpath `@happyvertical/smrt-ui/forms`.
 *
 * The Provider-FREE base form primitives, relocated here from
 * `@happyvertical/smrt-svelte/forms` (issue #1589 deferred-forms phase) so domain
 * packages can adopt them without pulling in the smrt-svelte Provider or closing
 * a build-graph cycle. smrt-ui is the leaf everyone may depend on.
 *
 * `Form`, `Input`, `Select`, `Textarea`, `Toggle`, `FormGroup` are generic,
 * tokenised, a11y-checked building blocks with no Provider/i18n/spoken-input
 * dependency. The Provider-REQUIRED inputs (`CheckboxInput`, `TextInput`,
 * `MoneyInput`, the rich `Form`, …) stay in `@happyvertical/smrt-svelte/forms`.
 */

export { default as Checkbox } from './Checkbox.svelte';
export { default as Combobox } from './Combobox.svelte';
export {
  type ControlBatchResult,
  type ControlCapability,
  type ControlCommand,
  type ControlCommandAction,
  type ControlCommandContext,
  type ControlCommandResult,
  type ControlCommandSource,
  type ControlConstraints,
  type ControlExtensionContext,
  type ControlIdentity,
  type ControlInteractionEvent,
  type ControlInteractionOptions,
  type ControlInteractionPolicy,
  type ControlInteractionRegistry,
  type ControlKind,
  type ControlMetadata,
  type ControlOption,
  type ControlRegistration,
  type ControlRuntimeState,
  type ControlSensitivity,
  type ControlSnapshot,
  type ControlStagedEntry,
  type ControlStagedProvenance,
  type ControlSubject,
  type ControlValueValidationResult,
  createControlInteractionRegistry,
  executeLocalControlBatch,
  executeLocalControlCommand,
} from './control-interaction.js';
export {
  type ControlInteractionContextValue,
  getControlInteractionContext,
  setControlInteractionContext,
  tryGetControlInteractionContext,
} from './control-interaction-context.js';
export { default as DatePicker } from './DatePicker.svelte';
export { default as ErrorSummary } from './ErrorSummary.svelte';
export { default as Fieldset } from './Fieldset.svelte';
export { default as FilePicker } from './FilePicker.svelte';
export { default as Form } from './Form.svelte';
export { default as Field, default as FormGroup } from './FormGroup.svelte';
export {
  type FormGroupContextValue,
  nextFieldId,
  setFormGroupContext,
  tryGetFormGroupContext,
} from './form-group-context.js';
export { default as Input } from './Input.svelte';
export { default as InputGroup } from './InputGroup.svelte';
export { default as Listbox } from './Listbox.svelte';
export { default as MultiSelect } from './MultiSelect.svelte';
export { default as Radio } from './Radio.svelte';
export { default as RadioGroup } from './RadioGroup.svelte';
export { default as RangeSlider } from './RangeSlider.svelte';
export { default as SegmentedControl } from './SegmentedControl.svelte';
export { default as Select } from './Select.svelte';
export { default as Slider } from './Slider.svelte';
export { default as StagedControlReview } from './StagedControlReview.svelte';
export { default as Switch } from './Switch.svelte';
export type { StagedControlReviewLabels } from './staged-control-review.js';
export { default as TagsInput } from './TagsInput.svelte';
export { default as Textarea } from './Textarea.svelte';
export { default as TimePicker } from './TimePicker.svelte';
export { default as Toggle } from './Toggle.svelte';
export { default as ToggleButton } from './ToggleButton.svelte';
export type {
  FormError,
  RangeSliderValue,
  SegmentedControlOption,
} from './types.js';
