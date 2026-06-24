/**
 * TypeScript type definitions for @have/profiles package
 */

import type { Profile } from './models/Profile';

/**
 * Handler function interface for reciprocal relationships
 *
 * @param from - The profile initiating the relationship
 * @param to - The target profile
 * @param context - Optional context profile for tertiary relationships
 * @param options - Additional options for the handler
 */
export type ReciprocalHandler = (
  from: Profile,
  to: Profile,
  context?: Profile,
  options?: Record<string, unknown>,
) => Promise<void>;

/**
 * Validation schema structure for profile metadata fields
 */
export interface ValidationSchema {
  /** Type constraint */
  type?: 'string' | 'number' | 'boolean' | 'date' | 'json';

  /** Regex pattern for string validation */
  pattern?: string;

  /** Minimum string length */
  minLength?: number;

  /** Maximum string length */
  maxLength?: number;

  /** Minimum numeric value */
  min?: number;

  /** Maximum numeric value */
  max?: number;

  /** Custom validator function name */
  custom?: string;

  /** Custom validation error message */
  message?: string;
}

/**
 * Custom validator function type
 */
export type ValidatorFunction = (value: unknown) => boolean | Promise<boolean>;
