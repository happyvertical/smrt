/**
 * Validator module for the SMRT ObjectRegistry.
 *
 * Compiles validation functions from field definitions for runtime use.
 *
 * Extracted from registry.ts as part of issue #1006.
 * @see https://github.com/happyvertical/smrt/issues/1006
 */

import type { ValidatorFunction } from './types';

/**
 * Compile validation functions from field definitions.
 *
 * Extracts validation rules from field options and compiles them into
 * efficient validation functions that can be executed at runtime.
 *
 * @param className - Name of the class being validated
 * @param fields - Map of field definitions
 * @returns Array of compiled validation functions
 */
export function compileValidators(
  className: string,
  fields: Map<string, any>,
): ValidatorFunction[] {
  const validators: ValidatorFunction[] = [];

  for (const [fieldName, field] of fields) {
    const options = field._meta || {};

    // Skip transient fields (they're not persisted, so no validation needed)
    if (options.transient || field.transient) {
      continue;
    }

    // Required field validator
    if (options.required) {
      validators.push(async (instance: any) => {
        const value = instance[fieldName];
        if (value === null || value === undefined || value === '') {
          const ValidationError = await import('../errors').then(
            (m) => m.ValidationError,
          );
          return ValidationError.requiredField(fieldName, className);
        }
        return null;
      });
    }

    // Numeric range validators
    if (
      field.type === 'integer' ||
      field.type === 'decimal' ||
      field.type === 'number'
    ) {
      if (options.min !== undefined) {
        validators.push(async (instance: any) => {
          const value = instance[fieldName];
          if (value !== null && value !== undefined && value < options.min) {
            const ValidationError = await import('../errors').then(
              (m) => m.ValidationError,
            );
            return ValidationError.rangeError(
              fieldName,
              value,
              options.min,
              options.max,
            );
          }
          return null;
        });
      }

      if (options.max !== undefined) {
        validators.push(async (instance: any) => {
          const value = instance[fieldName];
          if (value !== null && value !== undefined && value > options.max) {
            const ValidationError = await import('../errors').then(
              (m) => m.ValidationError,
            );
            return ValidationError.rangeError(
              fieldName,
              value,
              options.min,
              options.max,
            );
          }
          return null;
        });
      }
    }

    // String length validators
    if (field.type === 'text') {
      if (options.minLength !== undefined) {
        validators.push(async (instance: any) => {
          const value = instance[fieldName];
          if (
            value &&
            typeof value === 'string' &&
            value.length < options.minLength
          ) {
            const ValidationError = await import('../errors').then(
              (m) => m.ValidationError,
            );
            return ValidationError.invalidValue(
              fieldName,
              value,
              `string with minimum length ${options.minLength}`,
            );
          }
          return null;
        });
      }

      if (options.maxLength !== undefined) {
        validators.push(async (instance: any) => {
          const value = instance[fieldName];
          if (
            value &&
            typeof value === 'string' &&
            value.length > options.maxLength
          ) {
            const ValidationError = await import('../errors').then(
              (m) => m.ValidationError,
            );
            return ValidationError.invalidValue(
              fieldName,
              value,
              `string with maximum length ${options.maxLength}`,
            );
          }
          return null;
        });
      }

      // Pattern validator (regex)
      if (options.pattern) {
        const regex = new RegExp(options.pattern);
        validators.push(async (instance: any) => {
          const value = instance[fieldName];
          if (value && typeof value === 'string' && !regex.test(value)) {
            const ValidationError = await import('../errors').then(
              (m) => m.ValidationError,
            );
            return ValidationError.invalidValue(
              fieldName,
              value,
              `string matching pattern ${options.pattern}`,
            );
          }
          return null;
        });
      }
    }

    // Custom validator function
    if (options.validate && typeof options.validate === 'function') {
      validators.push(async (instance: any) => {
        const value = instance[fieldName];
        try {
          const isValid = await options.validate(value);
          if (!isValid) {
            const ValidationError = await import('../errors').then(
              (m) => m.ValidationError,
            );
            const message =
              options.customMessage ||
              `Field ${fieldName} failed custom validation`;
            return ValidationError.invalidValue(fieldName, value, message);
          }
        } catch (error) {
          const ValidationError = await import('../errors').then(
            (m) => m.ValidationError,
          );
          return ValidationError.invalidValue(
            fieldName,
            value,
            `custom validation error: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        return null;
      });
    }
  }

  return validators;
}
