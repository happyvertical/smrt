import { getContext, setContext } from 'svelte';
import type { ControlOption } from './control-interaction.js';

const RADIO_GROUP_KEY = Symbol('smrt-radio-group');
export interface RadioGroupContextValue {
  readonly name: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly required: boolean;
  setValue(value: string): void;
  registerOption(option: ControlOption): () => void;
}
export function setRadioGroupContext(value: RadioGroupContextValue): void {
  setContext(RADIO_GROUP_KEY, value);
}
export function getRadioGroupContext(): RadioGroupContextValue {
  const value = getContext<RadioGroupContextValue | undefined>(RADIO_GROUP_KEY);
  if (!value) throw new Error('<Radio> must be rendered inside <RadioGroup>.');
  return value;
}
