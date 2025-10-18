/**
 * Comprehensive error handling system for SMRT framework
 *
 * Provides specialized error types for different failure scenarios
 * with proper error codes, messages, and debugging information.
 */

/**
 * Base error class for all SMRT framework errors
 */
export abstract class SmrtError extends Error {
  public readonly code: string;
  public readonly category:
    | 'database'
    | 'ai'
    | 'filesystem'
    | 'validation'
    | 'network'
    | 'configuration'
    | 'runtime';
  public readonly details?: Record<string, any>;
  public readonly cause?: Error;

  constructor(
    message: string,
    code: string,
    category: SmrtError['category'],
    details?: Record<string, any>,
    cause?: Error,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.category = category;
    this.details = details;
    this.cause = cause;

    // Maintain proper stack trace for V8
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Converts error to a serializable object for logging/debugging
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      details: this.details,
      stack: this.stack,
      cause: this.cause
        ? {
            name: this.cause.name,
            message: this.cause.message,
            stack: this.cause.stack,
          }
        : undefined,
    };
  }
}

/**
 * Database-related errors
 */
export class DatabaseError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, any>,
    cause?: Error,
  ) {
    super(message, code, 'database', details, cause);
  }

  static connectionFailed(dbUrl: string, cause?: Error): DatabaseError {
    return new DatabaseError(
      `Failed to connect to database: ${dbUrl}`,
      'DB_CONNECTION_FAILED',
      { dbUrl },
      cause,
    );
  }

  static queryFailed(query: string, cause?: Error): DatabaseError {
    return new DatabaseError(
      `Database query failed: ${query.substring(0, 100)}${query.length > 100 ? '...' : ''}`,
      'DB_QUERY_FAILED',
      { query },
      cause,
    );
  }

  static schemaError(
    tableName: string,
    operation: string,
    cause?: Error,
  ): DatabaseError {
    return new DatabaseError(
      `Schema operation failed for table '${tableName}': ${operation}`,
      'DB_SCHEMA_ERROR',
      { tableName, operation },
      cause,
    );
  }

  static constraintViolation(
    constraint: string,
    value: any,
    cause?: Error,
  ): DatabaseError {
    return new DatabaseError(
      `Database constraint violation: ${constraint}`,
      'DB_CONSTRAINT_VIOLATION',
      { constraint, value },
      cause,
    );
  }
}

/**
 * AI integration errors
 */
export class AIError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, any>,
    cause?: Error,
  ) {
    super(message, code, 'ai', details, cause);
  }

  static providerError(
    provider: string,
    operation: string,
    cause?: Error,
  ): AIError {
    return new AIError(
      `AI provider '${provider}' failed during ${operation}`,
      'AI_PROVIDER_ERROR',
      { provider, operation },
      cause,
    );
  }

  static rateLimitExceeded(provider: string, retryAfter?: number): AIError {
    return new AIError(
      `AI provider '${provider}' rate limit exceeded`,
      'AI_RATE_LIMIT',
      { provider, retryAfter },
    );
  }

  static invalidResponse(provider: string, response: any): AIError {
    return new AIError(
      `AI provider '${provider}' returned invalid response`,
      'AI_INVALID_RESPONSE',
      { provider, response },
    );
  }

  static authenticationFailed(provider: string): AIError {
    return new AIError(
      `AI provider '${provider}' authentication failed`,
      'AI_AUTH_FAILED',
      { provider },
    );
  }
}

/**
 * Filesystem operation errors
 */
export class FilesystemError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, any>,
    cause?: Error,
  ) {
    super(message, code, 'filesystem', details, cause);
  }

  static fileNotFound(path: string): FilesystemError {
    return new FilesystemError(`File not found: ${path}`, 'FS_FILE_NOT_FOUND', {
      path,
    });
  }

  static permissionDenied(path: string, operation: string): FilesystemError {
    return new FilesystemError(
      `Permission denied for ${operation} on: ${path}`,
      'FS_PERMISSION_DENIED',
      { path, operation },
    );
  }

  static diskSpaceExceeded(
    path: string,
    requiredBytes: number,
  ): FilesystemError {
    return new FilesystemError(
      `Insufficient disk space for operation on: ${path}`,
      'FS_DISK_SPACE_EXCEEDED',
      { path, requiredBytes },
    );
  }
}

/**
 * Data validation errors
 */
export class ValidationError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, any>,
    cause?: Error,
  ) {
    super(message, code, 'validation', details, cause);
  }

  static requiredField(fieldName: string, objectType: string): ValidationError {
    return new ValidationError(
      `Required field '${fieldName}' is missing for ${objectType}`,
      'VALIDATION_REQUIRED_FIELD',
      { fieldName, objectType },
    );
  }

  static invalidValue(
    fieldName: string,
    value: any,
    expectedType: string,
  ): ValidationError {
    return new ValidationError(
      `Invalid value for field '${fieldName}': expected ${expectedType}, got ${typeof value}`,
      'VALIDATION_INVALID_VALUE',
      { fieldName, value, expectedType },
    );
  }

  static uniqueConstraint(fieldName: string, value: any): ValidationError {
    return new ValidationError(
      `Unique constraint violation for field '${fieldName}' with value: ${value}`,
      'VALIDATION_UNIQUE_CONSTRAINT',
      { fieldName, value },
    );
  }

  static rangeError(
    fieldName: string,
    value: number,
    min?: number,
    max?: number,
  ): ValidationError {
    const range =
      min !== undefined && max !== undefined
        ? `between ${min} and ${max}`
        : min !== undefined
          ? `>= ${min}`
          : `<= ${max}`;

    return new ValidationError(
      `Value for field '${fieldName}' must be ${range}, got: ${value}`,
      'VALIDATION_RANGE_ERROR',
      { fieldName, value, min, max },
    );
  }
}

/**
 * Network and external service errors
 */
export class NetworkError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, any>,
    cause?: Error,
  ) {
    super(message, code, 'network', details, cause);
  }

  static requestFailed(
    url: string,
    status?: number,
    responseBody?: string | Error,
  ): NetworkError {
    const cause = responseBody instanceof Error ? responseBody : undefined;
    const body = typeof responseBody === 'string' ? responseBody : undefined;
    return new NetworkError(
      `Network request failed: ${url}${status ? ` (Status: ${status})` : ''}${body ? ` - ${body.substring(0, 200)}` : ''}`,
      'NETWORK_REQUEST_FAILED',
      { url, status, responseBody: body },
      cause,
    );
  }

  static timeout(url: string, timeoutMs: number): NetworkError {
    return new NetworkError(
      `Network request timed out after ${timeoutMs}ms: ${url}`,
      'NETWORK_TIMEOUT',
      { url, timeoutMs },
    );
  }

  static serviceUnavailable(service: string, reason?: string): NetworkError {
    return new NetworkError(
      reason
        ? `External service unavailable: ${service} - ${reason}`
        : `External service unavailable: ${service}`,
      'NETWORK_SERVICE_UNAVAILABLE',
      { service, reason },
    );
  }
}

/**
 * Configuration and setup errors
 */
export class ConfigurationError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, any>,
    cause?: Error,
  ) {
    super(message, code, 'configuration', details, cause);
  }

  static missingConfiguration(
    configKey: string,
    context?: string,
  ): ConfigurationError {
    return new ConfigurationError(
      `Missing required configuration: ${configKey}${context ? ` in ${context}` : ''}`,
      'CONFIG_MISSING',
      { configKey, context },
    );
  }

  static invalidConfiguration(
    configKey: string,
    value: any,
    expected: string,
  ): ConfigurationError {
    return new ConfigurationError(
      `Invalid configuration for ${configKey}: expected ${expected}, got ${typeof value}`,
      'CONFIG_INVALID',
      { configKey, value, expected },
    );
  }

  static initializationFailed(
    component: string,
    cause?: Error,
  ): ConfigurationError {
    return new ConfigurationError(
      `Failed to initialize component: ${component}`,
      'CONFIG_INIT_FAILED',
      { component },
      cause,
    );
  }
}

/**
 * Runtime execution errors
 */
export class RuntimeError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, any>,
    cause?: Error,
  ) {
    super(message, code, 'runtime', details, cause);
  }

  static operationFailed(
    operation: string,
    context?: string,
    cause?: Error,
  ): RuntimeError {
    return new RuntimeError(
      `Operation failed: ${operation}${context ? ` in ${context}` : ''}`,
      'RUNTIME_OPERATION_FAILED',
      { operation, context },
      cause,
    );
  }

  static invalidState(
    message: string,
    context?: Record<string, any>,
  ): RuntimeError {
    return new RuntimeError(message, 'RUNTIME_INVALID_STATE', context);
  }

  static resourceExhausted(resource: string, limit: number): RuntimeError {
    return new RuntimeError(
      `Resource exhausted: ${resource} exceeded limit of ${limit}`,
      'RUNTIME_RESOURCE_EXHAUSTED',
      { resource, limit },
    );
  }
}

/**
 * Utility functions for error handling
 */
export class ErrorUtils {
  /**
   * Wraps a function with error handling and automatic retry logic
   */
  static async withRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
    delay = 1000,
    backoffMultiplier = 2,
  ): Promise<T> {
    let lastError: Error = new Error('Operation failed without error details');

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (attempt === maxRetries) {
          throw lastError;
        }

        // Skip retry for certain error types
        if (
          error instanceof ValidationError ||
          error instanceof ConfigurationError
        ) {
          throw error;
        }

        // Wait before retrying with exponential backoff
        await new Promise((resolve) =>
          setTimeout(resolve, delay * backoffMultiplier ** attempt),
        );
      }
    }

    throw lastError;
  }

  /**
   * Checks if an error is retryable
   */
  static isRetryable(error: Error): boolean {
    if (error instanceof SmrtError) {
      return error.category === 'network' || error.category === 'ai';
    }

    // Check for common retryable error patterns
    const retryablePatterns = [
      /ECONNRESET/,
      /ETIMEDOUT/,
      /ENOTFOUND/,
      /rate.?limit/i,
      /timeout/i,
      /503/,
      /502/,
      /500/,
    ];

    return retryablePatterns.some((pattern) => pattern.test(error.message));
  }

  /**
   * Sanitizes an error for safe logging (removes sensitive information)
   */
  static sanitizeError(error: Error): Record<string, any> {
    const sanitized: Record<string, any> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    if (error instanceof SmrtError) {
      sanitized.code = error.code;
      sanitized.category = error.category;

      // Sanitize details to remove potential sensitive information
      if (error.details) {
        sanitized.details = { ...error.details };

        // Remove common sensitive fields
        const sensitiveFields = [
          'password',
          'token',
          'key',
          'secret',
          'apiKey',
        ];
        for (const field of sensitiveFields) {
          if (sanitized.details[field]) {
            sanitized.details[field] = '[REDACTED]';
          }
        }
      }
    }

    return sanitized;
  }
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
export class ValidationReport {
  private errors: ValidationError[] = [];
  private objectType: string;

  constructor(objectType: string) {
    this.objectType = objectType;
  }

  /**
   * Add a validation error to the report
   */
  addError(error: ValidationError): void {
    this.errors.push(error);
  }

  /**
   * Check if there are any validation errors
   */
  hasErrors(): boolean {
    return this.errors.length > 0;
  }

  /**
   * Get all validation errors
   */
  getErrors(): ValidationError[] {
    return [...this.errors];
  }

  /**
   * Get the number of validation errors
   */
  getErrorCount(): number {
    return this.errors.length;
  }

  /**
   * Convert to a human-readable string
   */
  toString(): string {
    if (this.errors.length === 0) {
      return `Validation passed for ${this.objectType}`;
    }

    const errorList = this.errors
      .map((err, idx) => `  ${idx + 1}. ${err.message}`)
      .join('\n');

    return `Validation failed for ${this.objectType} with ${this.errors.length} error(s):\n${errorList}`;
  }

  /**
   * Convert to JSON format
   */
  toJSON(): object {
    return {
      objectType: this.objectType,
      errorCount: this.errors.length,
      errors: this.errors.map((err) => err.toJSON()),
    };
  }

  /**
   * Throw the first error if there are any errors
   */
  throwIfErrors(): void {
    if (this.errors.length > 0) {
      throw this.errors[0];
    }
  }

  /**
   * Clear all errors
   */
  clear(): void {
    this.errors = [];
  }
}

/**
 * Validation utility functions
 */
export class ValidationUtils {
  /**
   * Validate a single field value
   *
   * @param fieldName - Name of the field
   * @param value - Value to validate
   * @param options - Validation options (required, min, max, etc.)
   * @returns ValidationError if validation fails, null otherwise
   */
  static async validateField(
    fieldName: string,
    value: any,
    options: {
      required?: boolean;
      min?: number;
      max?: number;
      minLength?: number;
      maxLength?: number;
      pattern?: string | RegExp;
      type?: string;
      customValidator?: (value: any) => boolean | Promise<boolean>;
      customMessage?: string;
    },
    objectType: string = 'Object',
  ): Promise<ValidationError | null> {
    // Required check
    if (
      options.required &&
      (value === null || value === undefined || value === '')
    ) {
      return ValidationError.requiredField(fieldName, objectType);
    }

    // Skip further validation if value is null/undefined and not required
    if (value === null || value === undefined) {
      return null;
    }

    // Numeric range validation
    if (typeof value === 'number') {
      if (options.min !== undefined && value < options.min) {
        return ValidationError.rangeError(
          fieldName,
          value,
          options.min,
          options.max,
        );
      }
      if (options.max !== undefined && value > options.max) {
        return ValidationError.rangeError(
          fieldName,
          value,
          options.min,
          options.max,
        );
      }
    }

    // String length validation
    if (typeof value === 'string') {
      if (options.minLength !== undefined && value.length < options.minLength) {
        return ValidationError.invalidValue(
          fieldName,
          value,
          `string with minimum length ${options.minLength}`,
        );
      }
      if (options.maxLength !== undefined && value.length > options.maxLength) {
        return ValidationError.invalidValue(
          fieldName,
          value,
          `string with maximum length ${options.maxLength}`,
        );
      }

      // Pattern validation
      if (options.pattern) {
        const regex =
          typeof options.pattern === 'string'
            ? new RegExp(options.pattern)
            : options.pattern;
        if (!regex.test(value)) {
          return ValidationError.invalidValue(
            fieldName,
            value,
            `string matching pattern ${options.pattern}`,
          );
        }
      }
    }

    // Custom validator
    if (options.customValidator) {
      try {
        const isValid = await options.customValidator(value);
        if (!isValid) {
          return ValidationError.invalidValue(
            fieldName,
            value,
            options.customMessage || 'custom validation failed',
          );
        }
      } catch (error) {
        return ValidationError.invalidValue(
          fieldName,
          value,
          `custom validation error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return null;
  }

  /**
   * Validate required field
   */
  static validateRequired(
    fieldName: string,
    value: any,
    objectType: string = 'Object',
  ): ValidationError | null {
    if (value === null || value === undefined || value === '') {
      return ValidationError.requiredField(fieldName, objectType);
    }
    return null;
  }

  /**
   * Validate numeric range
   */
  static validateRange(
    fieldName: string,
    value: number,
    min?: number,
    max?: number,
  ): ValidationError | null {
    if (min !== undefined && value < min) {
      return ValidationError.rangeError(fieldName, value, min, max);
    }
    if (max !== undefined && value > max) {
      return ValidationError.rangeError(fieldName, value, min, max);
    }
    return null;
  }

  /**
   * Validate string length
   */
  static validateLength(
    fieldName: string,
    value: string,
    minLength?: number,
    maxLength?: number,
  ): ValidationError | null {
    if (minLength !== undefined && value.length < minLength) {
      return ValidationError.invalidValue(
        fieldName,
        value,
        `string with minimum length ${minLength}`,
      );
    }
    if (maxLength !== undefined && value.length > maxLength) {
      return ValidationError.invalidValue(
        fieldName,
        value,
        `string with maximum length ${maxLength}`,
      );
    }
    return null;
  }

  /**
   * Validate string pattern
   */
  static validatePattern(
    fieldName: string,
    value: string,
    pattern: string | RegExp,
  ): ValidationError | null {
    const regex = typeof pattern === 'string' ? new RegExp(pattern) : pattern;
    if (!regex.test(value)) {
      return ValidationError.invalidValue(
        fieldName,
        value,
        `string matching pattern ${pattern}`,
      );
    }
    return null;
  }
}
