/**
 * Code validation utilities for checking generated code before execution
 *
 * Provides functions to validate code syntax, check for dangerous patterns,
 * and verify code meets security requirements before sandbox execution.
 */
/**
 * Options for code validation
 */
export interface ValidationOptions {
    /**
     * List of allowed global variables
     * If provided, code will be checked for undeclared variables
     */
    allowedGlobals?: string[];
    /**
     * List of disallowed patterns (regex)
     * Code containing these patterns will fail validation
     */
    disallowedPatterns?: RegExp[];
    /**
     * Maximum code length in characters
     * Default: 50000
     */
    maxLength?: number;
    /**
     * Whether to allow require() calls
     * Default: false (dangerous in untrusted code)
     */
    allowRequire?: boolean;
    /**
     * Whether to allow import statements
     * Default: false (dangerous in untrusted code)
     */
    allowImport?: boolean;
    /**
     * Whether to allow eval() and Function() constructor
     * Default: false (dangerous in any code)
     */
    allowEval?: boolean;
    /**
     * Whether to perform syntax check
     * Default: true
     */
    checkSyntax?: boolean;
}
/**
 * Result of code validation
 */
export interface ValidationResult {
    /**
     * Whether the code passed all validation checks
     */
    valid: boolean;
    /**
     * Critical errors that prevent execution
     */
    errors: string[];
    /**
     * Non-critical warnings about the code
     */
    warnings: string[];
    /**
     * Statistics about the code
     */
    stats?: {
        length: number;
        lines: number;
        hasAsync: boolean;
        hasArrowFunctions: boolean;
        hasClasses: boolean;
    };
}
/**
 * Validates code before execution in a sandbox
 *
 * @param code - The code to validate
 * @param options - Validation options
 * @returns Validation result with errors and warnings
 *
 * @example
 * ```typescript
 * const result = validateCode(`
 *   function parse(data) {
 *     return JSON.parse(data);
 *   }
 * `, {
 *   allowedGlobals: ['JSON'],
 *   maxLength: 10000
 * });
 *
 * if (!result.valid) {
 *   console.error('Code validation failed:', result.errors);
 * }
 * ```
 */
export declare function validateCode(code: string, options?: ValidationOptions): ValidationResult;
/**
 * Quick validation to check if code is safe for execution
 * Returns true if code passes basic safety checks
 *
 * @param code - The code to check
 * @returns true if code is safe, false otherwise
 *
 * @example
 * ```typescript
 * if (isSafeCode('return x + y')) {
 *   // Safe to execute
 * }
 * ```
 */
export declare function isSafeCode(code: string): boolean;
//# sourceMappingURL=validation.d.ts.map