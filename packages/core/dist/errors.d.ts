/**
 * Comprehensive error handling system for SMRT framework
 *
 * Provides specialized error types for different failure scenarios
 * with proper error codes, messages, and debugging information.
 */
/**
 * Base error class for all SMRT framework errors
 */
export declare abstract class SmrtError extends Error {
    readonly code: string;
    readonly category: 'database' | 'ai' | 'filesystem' | 'validation' | 'network' | 'configuration' | 'runtime';
    readonly details?: Record<string, any>;
    readonly cause?: Error;
    constructor(message: string, code: string, category: SmrtError['category'], details?: Record<string, any>, cause?: Error);
    /**
     * Converts error to a serializable object for logging/debugging
     */
    toJSON(): {
        name: string;
        message: string;
        code: string;
        category: "database" | "ai" | "filesystem" | "validation" | "network" | "configuration" | "runtime";
        details: Record<string, any> | undefined;
        stack: string | undefined;
        cause: {
            name: string;
            message: string;
            stack: string | undefined;
        } | undefined;
    };
}
/**
 * Database-related errors
 */
export declare class DatabaseError extends SmrtError {
    constructor(message: string, code: string, details?: Record<string, any>, cause?: Error);
    static connectionFailed(dbUrl: string, cause?: Error): DatabaseError;
    static queryFailed(query: string, cause?: Error): DatabaseError;
    static schemaError(tableName: string, operation: string, cause?: Error): DatabaseError;
    static constraintViolation(constraint: string, value: any, cause?: Error): DatabaseError;
}
/**
 * AI integration errors
 */
export declare class AIError extends SmrtError {
    constructor(message: string, code: string, details?: Record<string, any>, cause?: Error);
    static providerError(provider: string, operation: string, cause?: Error): AIError;
    static rateLimitExceeded(provider: string, retryAfter?: number): AIError;
    static invalidResponse(provider: string, response: any): AIError;
    static authenticationFailed(provider: string): AIError;
}
/**
 * Filesystem operation errors
 */
export declare class FilesystemError extends SmrtError {
    constructor(message: string, code: string, details?: Record<string, any>, cause?: Error);
    static fileNotFound(path: string): FilesystemError;
    static permissionDenied(path: string, operation: string): FilesystemError;
    static diskSpaceExceeded(path: string, requiredBytes: number): FilesystemError;
}
/**
 * Data validation errors
 */
export declare class ValidationError extends SmrtError {
    constructor(message: string, code: string, details?: Record<string, any>, cause?: Error);
    static requiredField(fieldName: string, objectType: string): ValidationError;
    static invalidValue(fieldName: string, value: any, expectedType: string): ValidationError;
    static uniqueConstraint(fieldName: string, value: any): ValidationError;
    static rangeError(fieldName: string, value: number, min?: number, max?: number): ValidationError;
}
/**
 * Network and external service errors
 */
export declare class NetworkError extends SmrtError {
    constructor(message: string, code: string, details?: Record<string, any>, cause?: Error);
    static requestFailed(url: string, status?: number, responseBody?: string | Error): NetworkError;
    static timeout(url: string, timeoutMs: number): NetworkError;
    static serviceUnavailable(service: string, reason?: string): NetworkError;
}
/**
 * Configuration and setup errors
 */
export declare class ConfigurationError extends SmrtError {
    constructor(message: string, code: string, details?: Record<string, any>, cause?: Error);
    static missingConfiguration(configKey: string, context?: string): ConfigurationError;
    static invalidConfiguration(configKey: string, value: any, expected: string): ConfigurationError;
    static initializationFailed(component: string, cause?: Error): ConfigurationError;
}
/**
 * Runtime execution errors
 */
export declare class RuntimeError extends SmrtError {
    constructor(message: string, code: string, details?: Record<string, any>, cause?: Error);
    static operationFailed(operation: string, context?: string, cause?: Error): RuntimeError;
    static invalidState(message: string, context?: Record<string, any>): RuntimeError;
    static resourceExhausted(resource: string, limit: number): RuntimeError;
}
/**
 * Utility functions for error handling
 */
export declare class ErrorUtils {
    /**
     * Wraps a function with error handling and automatic retry logic
     */
    static withRetry<T>(operation: () => Promise<T>, maxRetries?: number, delay?: number, backoffMultiplier?: number): Promise<T>;
    /**
     * Checks if an error is retryable
     */
    static isRetryable(error: Error): boolean;
    /**
     * Sanitizes an error for safe logging (removes sensitive information)
     */
    static sanitizeError(error: Error): Record<string, any>;
}
/**
 * Validation report that collects multiple validation errors
 *
 * Useful for validating an entire object and reporting all errors
 * at once rather than stopping at the first error.
 *
 * @example
 * ```typescript
 * const report = new ValidationReport('Product');
 * report.addError(ValidationError.requiredField('name', 'Product'));
 * report.addError(ValidationError.rangeError('price', -10, 0));
 *
 * if (report.hasErrors()) {
 *   console.error(report.toString());
 *   // Output:
 *   // Validation failed for Product with 2 errors:
 *   // - name: Required field 'name' is missing for Product
 *   // - price: Value -10 for field 'price' is outside allowed range [0, undefined]
 * }
 * ```
 */
export declare class ValidationReport {
    private errors;
    private objectType;
    constructor(objectType: string);
    /**
     * Add a validation error to the report
     */
    addError(error: ValidationError): void;
    /**
     * Check if there are any validation errors
     */
    hasErrors(): boolean;
    /**
     * Get all validation errors
     */
    getErrors(): ValidationError[];
    /**
     * Get the number of validation errors
     */
    getErrorCount(): number;
    /**
     * Convert to a human-readable string
     */
    toString(): string;
    /**
     * Convert to JSON format
     */
    toJSON(): object;
    /**
     * Throw the first error if there are any errors
     */
    throwIfErrors(): void;
    /**
     * Clear all errors
     */
    clear(): void;
}
/**
 * Validation utility functions
 */
export declare class ValidationUtils {
    /**
     * Validate a single field value
     *
     * @param fieldName - Name of the field
     * @param value - Value to validate
     * @param options - Validation options (required, min, max, etc.)
     * @returns ValidationError if validation fails, null otherwise
     */
    static validateField(fieldName: string, value: any, options: {
        required?: boolean;
        min?: number;
        max?: number;
        minLength?: number;
        maxLength?: number;
        pattern?: string | RegExp;
        type?: string;
        customValidator?: (value: any) => boolean | Promise<boolean>;
        customMessage?: string;
    }, objectType?: string): Promise<ValidationError | null>;
    /**
     * Validate required field
     */
    static validateRequired(fieldName: string, value: any, objectType?: string): ValidationError | null;
    /**
     * Validate numeric range
     */
    static validateRange(fieldName: string, value: number, min?: number, max?: number): ValidationError | null;
    /**
     * Validate string length
     */
    static validateLength(fieldName: string, value: string, minLength?: number, maxLength?: number): ValidationError | null;
    /**
     * Validate string pattern
     */
    static validatePattern(fieldName: string, value: string, pattern: string | RegExp): ValidationError | null;
}
//# sourceMappingURL=errors.d.ts.map