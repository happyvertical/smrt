/**
 * Types for SMRT Form components
 */

/** Speech-to-text adapter type */
export type STTAdapterType = 'browser-speech' | 'whisper-wasm' | 'whisper-cpp';

/** LLM model ID for field extraction */
export type LLMModelId =
  | 'none'
  | 'smollm2-360m'
  | 'smollm2-1.7b'
  | 'qwen2.5-1.5b'
  | 'llama-3.2-1b';

/** Option for SMRTSelect component */
export interface SelectOption {
  value: string;
  label: string;
}

/** Address value for SMRTAddress component */
export interface AddressValue {
  street: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
}

/** Date range value for SMRTDateRange component */
export interface DateRangeValue {
  startDate: string;
  endDate: string;
}

/** Measurement unit types */
export type MeasurementUnit = 'ft' | 'in' | 'm' | 'cm' | 'mm' | 'yd';

/** Measurement value for SMRTMeasurement component */
export interface MeasurementValue {
  value: number;
  unit: MeasurementUnit;
}
