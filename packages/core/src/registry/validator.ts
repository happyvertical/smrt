/**
 * Validator module for the SMRT ObjectRegistry.
 *
 * Compiles validation functions from field definitions for runtime use.
 *
 * Extracted from registry.ts as part of issue #1006.
 * @see https://github.com/happyvertical/smrt/issues/1006
 */

import type { SmrtObject } from '../object';
import type { FieldDefinition, FieldMeta } from '../scanner/types.js';
import type { ValidatorFunction } from './types';

/**
 * Read a runtime field value off a SmrtObject instance by dynamic field name.
 *
 * Compiled validators index the instance by `fieldName` (a manifest-driven
 * string), but `SmrtObject` has no string index signature, so a direct
 * `instance[fieldName]` is an implicit-`any` access (TS7053). This single
 * documented view casts through `unknown` to a `Record<string, unknown>` so the
 * dynamic read is typed `unknown` (not `any`) while preserving exact runtime
 * behavior. Routing every validator's field read through here keeps the cast in
 * one place instead of scattering it across each closure.
 */
function readInstanceField(instance: SmrtObject, fieldName: string): unknown {
  return (instance as unknown as Record<string, unknown>)[fieldName];
}

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
  fields: Map<string, FieldDefinition>,
): ValidatorFunction[] {
  const validators: ValidatorFunction[] = [];

  for (const [fieldName, field] of fields) {
    const options: FieldMeta = field._meta ?? {};

    // Skip transient fields (they're not persisted, so no validation needed)
    if (options.transient || field.transient) {
      continue;
    }

    // Required field validator. Check both the `_meta` bag and the top-level
    // `field.required` (some registration paths, e.g. tenantScoped injection,
    // set the top-level flag) — mirrors the `transient` check above.
    if (options.required || field.required) {
      validators.push(async (instance) => {
        const value = readInstanceField(instance, fieldName);
        if (value === null || value === undefined || value === '') {
          const ValidationError = await import('../errors').then(
            (m) => m.ValidationError,
          );
          return ValidationError.requiredField(fieldName, className);
        }
        return null;
      });
    }

    // Numeric range validators. The scanner's `FieldDefinition['type']` union
    // does not list `'number'`, but external/legacy manifests can still carry
    // it, so widen the comparison to a string check rather than dropping it.
    const fieldType: string = field.type;
    if (
      fieldType === 'integer' ||
      fieldType === 'decimal' ||
      fieldType === 'number'
    ) {
      const { min, max } = options;
      if (min !== undefined) {
        validators.push(async (instance) => {
          // Numeric-field branch: the runtime value is treated as a number for
          // the range comparison (JS coercion semantics preserved — the cast is
          // erased, so the runtime read/compare is unchanged).
          const value = readInstanceField(instance, fieldName) as number;
          if (value !== null && value !== undefined && value < min) {
            const ValidationError = await import('../errors').then(
              (m) => m.ValidationError,
            );
            return ValidationError.rangeError(fieldName, value, min, max);
          }
          return null;
        });
      }

      if (max !== undefined) {
        validators.push(async (instance) => {
          // See the `min` branch: numeric-field value typed as `number` for the
          // range comparison; runtime behavior is unchanged.
          const value = readInstanceField(instance, fieldName) as number;
          if (value !== null && value !== undefined && value > max) {
            const ValidationError = await import('../errors').then(
              (m) => m.ValidationError,
            );
            return ValidationError.rangeError(fieldName, value, min, max);
          }
          return null;
        });
      }
    }

    // String length validators
    if (fieldType === 'text') {
      const { minLength, maxLength, pattern } = options;
      if (minLength !== undefined) {
        validators.push(async (instance) => {
          const value = readInstanceField(instance, fieldName);
          if (value && typeof value === 'string' && value.length < minLength) {
            const ValidationError = await import('../errors').then(
              (m) => m.ValidationError,
            );
            return ValidationError.invalidValue(
              fieldName,
              value,
              `string with minimum length ${minLength}`,
            );
          }
          return null;
        });
      }

      if (maxLength !== undefined) {
        validators.push(async (instance) => {
          const value = readInstanceField(instance, fieldName);
          if (value && typeof value === 'string' && value.length > maxLength) {
            const ValidationError = await import('../errors').then(
              (m) => m.ValidationError,
            );
            return ValidationError.invalidValue(
              fieldName,
              value,
              `string with maximum length ${maxLength}`,
            );
          }
          return null;
        });
      }

      // Pattern validator (regex). `FieldMeta.pattern` is `unknown` (a string
      // source, a `RegExp`, or an opaque `{}` from a JSON-collapsed manifest);
      // only string/RegExp sources can build a usable regex.
      if (typeof pattern === 'string' || pattern instanceof RegExp) {
        const regex = new RegExp(pattern);
        validators.push(async (instance) => {
          const value = readInstanceField(instance, fieldName);
          if (value && typeof value === 'string' && !regex.test(value)) {
            const ValidationError = await import('../errors').then(
              (m) => m.ValidationError,
            );
            return ValidationError.invalidValue(
              fieldName,
              value,
              `string matching pattern ${String(pattern)}`,
            );
          }
          return null;
        });
      }
    }

    // Custom validator function. `validate`/`customMessage` arrive through the
    // open `FieldMeta` index signature as `unknown`; narrow to the callable and
    // string shapes the validator relies on.
    const customValidate = options.validate;
    if (typeof customValidate === 'function') {
      const validateFn = customValidate as (
        value: unknown,
      ) => boolean | Promise<boolean>;
      const customMessage =
        typeof options.customMessage === 'string'
          ? options.customMessage
          : undefined;
      validators.push(async (instance) => {
        const value = readInstanceField(instance, fieldName);
        try {
          const isValid = await validateFn(value);
          if (!isValid) {
            const ValidationError = await import('../errors').then(
              (m) => m.ValidationError,
            );
            const message =
              customMessage || `Field ${fieldName} failed custom validation`;
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
