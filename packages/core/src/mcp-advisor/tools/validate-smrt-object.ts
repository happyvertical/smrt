/**
 * Validate SMRT object class structure and configuration
 */

import { readFile } from 'node:fs/promises';
import type { ValidateSmrtObjectInput, ValidationResult } from '../types.js';

/**
 * Validate a SMRT object file
 */
export async function validateSmrtObject(
  input: ValidateSmrtObjectInput,
): Promise<ValidationResult> {
  try {
    const { filePath, strictMode = false } = input;

    // Read file
    const content = await readFile(filePath, 'utf-8');

    const errors: ValidationResult['errors'] = [];

    // Check for @smrt decorator
    const hasDecorator = /@smrt\s*\(/.test(content);
    if (!hasDecorator) {
      errors.push({
        type: 'error',
        message: 'Missing @smrt() decorator',
        suggestion: 'Add @smrt() decorator above your class definition',
      });
    }

    // Check for class extends SmrtObject
    const classMatch = content.match(
      /class\s+(\w+)\s+extends\s+(SmrtObject|SmrtCollection)/,
    );
    if (!classMatch) {
      errors.push({
        type: 'error',
        message: 'Class must extend SmrtObject or SmrtCollection',
        suggestion:
          'Ensure your class declaration includes "extends SmrtObject"',
      });
    }

    const className = classMatch?.[1];

    // Check for static _itemClass (if SmrtCollection)
    const isSmrtCollection = classMatch?.[2] === 'SmrtCollection';
    if (isSmrtCollection) {
      const hasItemClass = /static\s+readonly\s+_itemClass/.test(content);
      if (!hasItemClass) {
        errors.push({
          type: 'error',
          message: 'SmrtCollection must define static readonly _itemClass',
          suggestion: 'Add: static readonly _itemClass = YourItemClass;',
        });
      }
    }

    // Check for constructor
    const hasConstructor = /constructor\s*\(/.test(content);
    if (!hasConstructor && !isSmrtCollection) {
      errors.push({
        type: 'warning',
        message: 'No constructor found',
        suggestion:
          'Add constructor that calls super(options) and assigns properties',
      });
    }

    // Check constructor calls super
    if (hasConstructor) {
      const hasSuperCall = /super\s*\(/.test(content);
      if (!hasSuperCall) {
        errors.push({
          type: 'error',
          message: 'Constructor must call super()',
          suggestion: 'Add super(options) as first line of constructor',
        });
      }
    }

    // Check for required imports
    const requiredImports = [
      { pattern: /from\s+['"]@have\/smrt['"]/, name: '@smrt/core' },
    ];

    for (const { pattern, name } of requiredImports) {
      if (!pattern.test(content)) {
        errors.push({
          type: 'error',
          message: `Missing import from ${name}`,
          suggestion: `Add: import { SmrtObject, smrt } from '${name}';`,
        });
      }
    }

    // Count fields (properties with field type calls)
    const fieldMatches = content.match(/\s+\w+\s*=\s*\w+\(/g);
    const fieldCount = fieldMatches ? fieldMatches.length : 0;

    if (fieldCount === 0 && !isSmrtCollection) {
      errors.push({
        type: 'warning',
        message: 'No field definitions found',
        suggestion: 'Add properties using field types from @smrt/core/fields',
      });
    }

    // Strict mode checks
    if (strictMode) {
      // Check for TypeScript types on properties
      const hasUntypedProps =
        /\s+\w+\s*=/.test(content) && !/:\s*\w+\s*=/.test(content);
      if (hasUntypedProps) {
        errors.push({
          type: 'warning',
          message: 'Properties should have explicit TypeScript types',
          suggestion: 'Add type annotations: name: string = text();',
        });
      }

      // Check for JSDoc comments
      const hasJSDoc = /\/\*\*/.test(content);
      if (!hasJSDoc) {
        errors.push({
          type: 'warning',
          message: 'Missing JSDoc documentation',
          suggestion: 'Add JSDoc comments to class and methods',
        });
      }
    }

    return {
      valid: errors.filter((e) => e.type === 'error').length === 0,
      errors,
      className,
      hasDecorator,
      hasRequiredMethods: hasConstructor,
      fieldCount,
    };
  } catch (error) {
    return {
      valid: false,
      errors: [
        {
          type: 'error',
          message:
            error instanceof Error ? error.message : 'Unknown validation error',
        },
      ],
    };
  }
}
