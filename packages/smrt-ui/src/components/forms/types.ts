import type { ControlOption } from './control-interaction.js';

export interface FormError {
  controlId: string;
  message: string;
  label?: string;
}

export interface RangeSliderValue {
  min: number;
  max: number;
}

export interface SegmentedControlOption extends ControlOption {
  icon?: string;
}
