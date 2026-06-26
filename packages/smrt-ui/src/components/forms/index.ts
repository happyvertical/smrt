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
export { default as Form } from './Form.svelte';
export { default as FormGroup } from './FormGroup.svelte';
export {
  type FormGroupContextValue,
  nextFieldId,
  setFormGroupContext,
  tryGetFormGroupContext,
} from './form-group-context.js';
export { default as Input } from './Input.svelte';
export { default as Select } from './Select.svelte';
export { default as Textarea } from './Textarea.svelte';
export { default as Toggle } from './Toggle.svelte';
