/**
 * FormGroup accessibility context (Sweep L1, #1420).
 *
 * `FormGroup` publishes the wiring a wrapped input needs to be programmatically
 * accessible — the input's `id` (so the `<label for>` resolves), the
 * space-joined ids of the hint/error text (for `aria-describedby`), and whether
 * the field is currently in an error state (`aria-invalid`). The base form
 * primitives (`Input`, `Select`, `Textarea`) read this and auto-apply those
 * attributes when the consumer hasn't set them explicitly, so an input dropped
 * inside a `<FormGroup>` is accessible with no extra wiring.
 *
 * The value is a getter so the consuming input always reads the *current*
 * reactive state (id is stable; describedBy/invalid change as hint/error do).
 */
import { getContext, setContext } from 'svelte';

export interface FormGroupContextValue {
  /** Stable id for the field control; matches the FormGroup label's `for`. */
  inputId: string;
  /** Space-joined ids of the visible hint/error text, or undefined if none. */
  describedBy: string | undefined;
  /** Whether the field is currently showing an error. */
  invalid: boolean;
}

const FORM_GROUP_KEY = Symbol('smrt-form-group');

export function setFormGroupContext(get: () => FormGroupContextValue): void {
  setContext(FORM_GROUP_KEY, get);
}

export function tryGetFormGroupContext():
  | (() => FormGroupContextValue)
  | undefined {
  return getContext<(() => FormGroupContextValue) | undefined>(FORM_GROUP_KEY);
}

let autoIdCounter = 0;

/** Deterministic, collision-resistant id for a FormGroup that wasn't given one. */
export function nextFieldId(): string {
  autoIdCounter += 1;
  return `smrt-field-${autoIdCounter}`;
}
