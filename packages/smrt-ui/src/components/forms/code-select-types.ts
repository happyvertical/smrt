import type { DOMAttributes, HTMLSelectAttributes } from 'svelte/elements';
import type { ControlInteractionOptions } from './control-interaction.js';

/** A caller-authorized native choice; supplied labels are displayed verbatim. */
export interface CodeSelectOption {
  /** Exact submitted code, never normalized by the control. */
  value: string;
  /** Optional localized text; defaults to the code. */
  label?: string;
  /** Native disabled option; selected disabled options are omitted from FormData. */
  disabled?: boolean;
}
/** Shared single-choice contract; children and multiple are intentionally excluded. */
export interface CodeSelectProps
  extends Omit<
    HTMLSelectAttributes,
    'children' | 'multiple' | 'value' | 'class'
  > {
  /** Exact bound and submitted value. */
  value?: string;
  /** Additional CSS classes. */
  class?: string;
  /** Control target density. */
  density?: 'comfortable' | 'touch';
  /** Optional shared agent interaction registration. */
  interaction?: ControlInteractionOptions | false;
  /** Custom choices replace defaults; an empty list is an intentional override. */
  options?: readonly CodeSelectOption[];
  /** Visible label rendered above the control with the shared field label; becomes its accessible name. */
  label?: string;
  /** Shows the required marker on `label`. */
  required?: boolean;
  /** Locale used for built-in currency/country display names; invalid locales use English. */
  locale?: string;
  /** Empty choice label. Defaults to an em dash and never auto-selects a code. */
  placeholder?: string;
  /** Disable editing while submitting the unchanged value through a hidden input. */
  readOnly?: boolean;
}
/** Currency control with existing ISO 4217 defaults. */
export interface CurrencySelectProps extends CodeSelectProps {}
/** Country control with ISO 3166-1 alpha-2 defaults. */
export interface CountrySelectProps extends CodeSelectProps {}
/** Region control; event targets may be Select or the unsupported-country Input fallback. */
export interface ProvinceSelectProps
  extends Omit<CodeSelectProps, keyof DOMAttributes<HTMLSelectElement>>,
    Omit<DOMAttributes<HTMLInputElement | HTMLSelectElement>, 'children'> {
  /** Country code selecting CA/US subdivisions; other countries permit free text. */
  country?: string;
}
