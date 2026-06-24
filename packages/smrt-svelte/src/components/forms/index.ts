/**
 * SMRT Form components with voice input capabilities.
 *
 * The Provider-FREE base primitives (`Input`, `Select`, `Textarea`, `Toggle`,
 * `FormGroup`) were relocated to `@happyvertical/smrt-ui/forms` (#1589
 * deferred-forms phase) so domain packages can adopt them without the Provider
 * or a build-graph cycle. They are re-exported here so this subpath stays the
 * one-stop barrel for form primitives. The Provider-REQUIRED inputs (the rich
 * `Form`, `CheckboxInput`, `TextInput`, …) still live in this package.
 */

// Provider-free base primitives — relocated to the smrt-ui leaf (#1589).
export {
  FormGroup,
  Input,
  Select,
  Textarea,
  Toggle,
} from '@happyvertical/smrt-ui/forms';

// SMRT-enhanced form components with voice support (v2.0 naming)
export { default as AddressInput } from './AddressInput.svelte';
export { default as CheckboxInput } from './CheckboxInput.svelte';
export { default as DateRangeInput } from './DateRangeInput.svelte';
export { default as DateTimeInput } from './DateTimeInput.svelte';
export { default as FileUpload } from './FileUpload.svelte';
export { default as Form } from './Form.svelte';
export { default as FormMicButton } from './FormMicButton.svelte';
export { default as MeasurementInput } from './MeasurementInput.svelte';
export { default as MoneyInput } from './MoneyInput.svelte';
export { default as NumberInput } from './NumberInput.svelte';
export { default as PhoneInput } from './PhoneInput.svelte';
export { default as SearchInput } from './SearchInput.svelte';
export { default as SelectInput } from './SelectInput.svelte';
export { default as TextareaInput } from './TextareaInput.svelte';
export { default as TextInput } from './TextInput.svelte';

// Types
export type {
  AddressValue,
  DateRangeValue,
  LLMModelId,
  MeasurementUnit,
  MeasurementValue,
  SelectOption,
  STTAdapterType,
} from './types.js';
