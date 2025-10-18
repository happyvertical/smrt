class SmrtError extends Error {
  code;
  category;
  details;
  cause;
  constructor(message, code, category, details, cause) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.category = category;
    this.details = details;
    this.cause = cause;
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
      cause: this.cause ? {
        name: this.cause.name,
        message: this.cause.message,
        stack: this.cause.stack
      } : void 0
    };
  }
}
class DatabaseError extends SmrtError {
  constructor(message, code, details, cause) {
    super(message, code, "database", details, cause);
  }
  static connectionFailed(dbUrl, cause) {
    return new DatabaseError(
      `Failed to connect to database: ${dbUrl}`,
      "DB_CONNECTION_FAILED",
      { dbUrl },
      cause
    );
  }
  static queryFailed(query, cause) {
    return new DatabaseError(
      `Database query failed: ${query.substring(0, 100)}${query.length > 100 ? "..." : ""}`,
      "DB_QUERY_FAILED",
      { query },
      cause
    );
  }
  static schemaError(tableName, operation, cause) {
    return new DatabaseError(
      `Schema operation failed for table '${tableName}': ${operation}`,
      "DB_SCHEMA_ERROR",
      { tableName, operation },
      cause
    );
  }
  static constraintViolation(constraint, value, cause) {
    return new DatabaseError(
      `Database constraint violation: ${constraint}`,
      "DB_CONSTRAINT_VIOLATION",
      { constraint, value },
      cause
    );
  }
}
class AIError extends SmrtError {
  constructor(message, code, details, cause) {
    super(message, code, "ai", details, cause);
  }
  static providerError(provider, operation, cause) {
    return new AIError(
      `AI provider '${provider}' failed during ${operation}`,
      "AI_PROVIDER_ERROR",
      { provider, operation },
      cause
    );
  }
  static rateLimitExceeded(provider, retryAfter) {
    return new AIError(
      `AI provider '${provider}' rate limit exceeded`,
      "AI_RATE_LIMIT",
      { provider, retryAfter }
    );
  }
  static invalidResponse(provider, response) {
    return new AIError(
      `AI provider '${provider}' returned invalid response`,
      "AI_INVALID_RESPONSE",
      { provider, response }
    );
  }
  static authenticationFailed(provider) {
    return new AIError(
      `AI provider '${provider}' authentication failed`,
      "AI_AUTH_FAILED",
      { provider }
    );
  }
}
class FilesystemError extends SmrtError {
  constructor(message, code, details, cause) {
    super(message, code, "filesystem", details, cause);
  }
  static fileNotFound(path) {
    return new FilesystemError(`File not found: ${path}`, "FS_FILE_NOT_FOUND", {
      path
    });
  }
  static permissionDenied(path, operation) {
    return new FilesystemError(
      `Permission denied for ${operation} on: ${path}`,
      "FS_PERMISSION_DENIED",
      { path, operation }
    );
  }
  static diskSpaceExceeded(path, requiredBytes) {
    return new FilesystemError(
      `Insufficient disk space for operation on: ${path}`,
      "FS_DISK_SPACE_EXCEEDED",
      { path, requiredBytes }
    );
  }
}
class ValidationError extends SmrtError {
  constructor(message, code, details, cause) {
    super(message, code, "validation", details, cause);
  }
  static requiredField(fieldName, objectType) {
    return new ValidationError(
      `Required field '${fieldName}' is missing for ${objectType}`,
      "VALIDATION_REQUIRED_FIELD",
      { fieldName, objectType }
    );
  }
  static invalidValue(fieldName, value, expectedType) {
    return new ValidationError(
      `Invalid value for field '${fieldName}': expected ${expectedType}, got ${typeof value}`,
      "VALIDATION_INVALID_VALUE",
      { fieldName, value, expectedType }
    );
  }
  static uniqueConstraint(fieldName, value) {
    return new ValidationError(
      `Unique constraint violation for field '${fieldName}' with value: ${value}`,
      "VALIDATION_UNIQUE_CONSTRAINT",
      { fieldName, value }
    );
  }
  static rangeError(fieldName, value, min, max) {
    const range = min !== void 0 && max !== void 0 ? `between ${min} and ${max}` : min !== void 0 ? `>= ${min}` : `<= ${max}`;
    return new ValidationError(
      `Value for field '${fieldName}' must be ${range}, got: ${value}`,
      "VALIDATION_RANGE_ERROR",
      { fieldName, value, min, max }
    );
  }
}
class NetworkError extends SmrtError {
  constructor(message, code, details, cause) {
    super(message, code, "network", details, cause);
  }
  static requestFailed(url, status, responseBody) {
    const cause = responseBody instanceof Error ? responseBody : void 0;
    const body = typeof responseBody === "string" ? responseBody : void 0;
    return new NetworkError(
      `Network request failed: ${url}${status ? ` (Status: ${status})` : ""}${body ? ` - ${body.substring(0, 200)}` : ""}`,
      "NETWORK_REQUEST_FAILED",
      { url, status, responseBody: body },
      cause
    );
  }
  static timeout(url, timeoutMs) {
    return new NetworkError(
      `Network request timed out after ${timeoutMs}ms: ${url}`,
      "NETWORK_TIMEOUT",
      { url, timeoutMs }
    );
  }
  static serviceUnavailable(service, reason) {
    return new NetworkError(
      reason ? `External service unavailable: ${service} - ${reason}` : `External service unavailable: ${service}`,
      "NETWORK_SERVICE_UNAVAILABLE",
      { service, reason }
    );
  }
}
class ConfigurationError extends SmrtError {
  constructor(message, code, details, cause) {
    super(message, code, "configuration", details, cause);
  }
  static missingConfiguration(configKey, context) {
    return new ConfigurationError(
      `Missing required configuration: ${configKey}${context ? ` in ${context}` : ""}`,
      "CONFIG_MISSING",
      { configKey, context }
    );
  }
  static invalidConfiguration(configKey, value, expected) {
    return new ConfigurationError(
      `Invalid configuration for ${configKey}: expected ${expected}, got ${typeof value}`,
      "CONFIG_INVALID",
      { configKey, value, expected }
    );
  }
  static initializationFailed(component, cause) {
    return new ConfigurationError(
      `Failed to initialize component: ${component}`,
      "CONFIG_INIT_FAILED",
      { component },
      cause
    );
  }
}
class RuntimeError extends SmrtError {
  constructor(message, code, details, cause) {
    super(message, code, "runtime", details, cause);
  }
  static operationFailed(operation, context, cause) {
    return new RuntimeError(
      `Operation failed: ${operation}${context ? ` in ${context}` : ""}`,
      "RUNTIME_OPERATION_FAILED",
      { operation, context },
      cause
    );
  }
  static invalidState(message, context) {
    return new RuntimeError(message, "RUNTIME_INVALID_STATE", context);
  }
  static resourceExhausted(resource, limit) {
    return new RuntimeError(
      `Resource exhausted: ${resource} exceeded limit of ${limit}`,
      "RUNTIME_RESOURCE_EXHAUSTED",
      { resource, limit }
    );
  }
}
class ErrorUtils {
  /**
   * Wraps a function with error handling and automatic retry logic
   */
  static async withRetry(operation, maxRetries = 3, delay = 1e3, backoffMultiplier = 2) {
    let lastError = new Error("Operation failed without error details");
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === maxRetries) {
          throw lastError;
        }
        if (error instanceof ValidationError || error instanceof ConfigurationError) {
          throw error;
        }
        await new Promise(
          (resolve) => setTimeout(resolve, delay * backoffMultiplier ** attempt)
        );
      }
    }
    throw lastError;
  }
  /**
   * Checks if an error is retryable
   */
  static isRetryable(error) {
    if (error instanceof SmrtError) {
      return error.category === "network" || error.category === "ai";
    }
    const retryablePatterns = [
      /ECONNRESET/,
      /ETIMEDOUT/,
      /ENOTFOUND/,
      /rate.?limit/i,
      /timeout/i,
      /503/,
      /502/,
      /500/
    ];
    return retryablePatterns.some((pattern) => pattern.test(error.message));
  }
  /**
   * Sanitizes an error for safe logging (removes sensitive information)
   */
  static sanitizeError(error) {
    const sanitized = {
      name: error.name,
      message: error.message,
      stack: error.stack
    };
    if (error instanceof SmrtError) {
      sanitized.code = error.code;
      sanitized.category = error.category;
      if (error.details) {
        sanitized.details = { ...error.details };
        const sensitiveFields = [
          "password",
          "token",
          "key",
          "secret",
          "apiKey"
        ];
        for (const field of sensitiveFields) {
          if (sanitized.details[field]) {
            sanitized.details[field] = "[REDACTED]";
          }
        }
      }
    }
    return sanitized;
  }
}
class ValidationReport {
  errors = [];
  objectType;
  constructor(objectType) {
    this.objectType = objectType;
  }
  /**
   * Add a validation error to the report
   */
  addError(error) {
    this.errors.push(error);
  }
  /**
   * Check if there are any validation errors
   */
  hasErrors() {
    return this.errors.length > 0;
  }
  /**
   * Get all validation errors
   */
  getErrors() {
    return [...this.errors];
  }
  /**
   * Get the number of validation errors
   */
  getErrorCount() {
    return this.errors.length;
  }
  /**
   * Convert to a human-readable string
   */
  toString() {
    if (this.errors.length === 0) {
      return `Validation passed for ${this.objectType}`;
    }
    const errorList = this.errors.map((err, idx) => `  ${idx + 1}. ${err.message}`).join("\n");
    return `Validation failed for ${this.objectType} with ${this.errors.length} error(s):
${errorList}`;
  }
  /**
   * Convert to JSON format
   */
  toJSON() {
    return {
      objectType: this.objectType,
      errorCount: this.errors.length,
      errors: this.errors.map((err) => err.toJSON())
    };
  }
  /**
   * Throw the first error if there are any errors
   */
  throwIfErrors() {
    if (this.errors.length > 0) {
      throw this.errors[0];
    }
  }
  /**
   * Clear all errors
   */
  clear() {
    this.errors = [];
  }
}
class ValidationUtils {
  /**
   * Validate a single field value
   *
   * @param fieldName - Name of the field
   * @param value - Value to validate
   * @param options - Validation options (required, min, max, etc.)
   * @returns ValidationError if validation fails, null otherwise
   */
  static async validateField(fieldName, value, options, objectType = "Object") {
    if (options.required && (value === null || value === void 0 || value === "")) {
      return ValidationError.requiredField(fieldName, objectType);
    }
    if (value === null || value === void 0) {
      return null;
    }
    if (typeof value === "number") {
      if (options.min !== void 0 && value < options.min) {
        return ValidationError.rangeError(
          fieldName,
          value,
          options.min,
          options.max
        );
      }
      if (options.max !== void 0 && value > options.max) {
        return ValidationError.rangeError(
          fieldName,
          value,
          options.min,
          options.max
        );
      }
    }
    if (typeof value === "string") {
      if (options.minLength !== void 0 && value.length < options.minLength) {
        return ValidationError.invalidValue(
          fieldName,
          value,
          `string with minimum length ${options.minLength}`
        );
      }
      if (options.maxLength !== void 0 && value.length > options.maxLength) {
        return ValidationError.invalidValue(
          fieldName,
          value,
          `string with maximum length ${options.maxLength}`
        );
      }
      if (options.pattern) {
        const regex = typeof options.pattern === "string" ? new RegExp(options.pattern) : options.pattern;
        if (!regex.test(value)) {
          return ValidationError.invalidValue(
            fieldName,
            value,
            `string matching pattern ${options.pattern}`
          );
        }
      }
    }
    if (options.customValidator) {
      try {
        const isValid = await options.customValidator(value);
        if (!isValid) {
          return ValidationError.invalidValue(
            fieldName,
            value,
            options.customMessage || "custom validation failed"
          );
        }
      } catch (error) {
        return ValidationError.invalidValue(
          fieldName,
          value,
          `custom validation error: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    return null;
  }
  /**
   * Validate required field
   */
  static validateRequired(fieldName, value, objectType = "Object") {
    if (value === null || value === void 0 || value === "") {
      return ValidationError.requiredField(fieldName, objectType);
    }
    return null;
  }
  /**
   * Validate numeric range
   */
  static validateRange(fieldName, value, min, max) {
    if (min !== void 0 && value < min) {
      return ValidationError.rangeError(fieldName, value, min, max);
    }
    if (max !== void 0 && value > max) {
      return ValidationError.rangeError(fieldName, value, min, max);
    }
    return null;
  }
  /**
   * Validate string length
   */
  static validateLength(fieldName, value, minLength, maxLength) {
    if (minLength !== void 0 && value.length < minLength) {
      return ValidationError.invalidValue(
        fieldName,
        value,
        `string with minimum length ${minLength}`
      );
    }
    if (maxLength !== void 0 && value.length > maxLength) {
      return ValidationError.invalidValue(
        fieldName,
        value,
        `string with maximum length ${maxLength}`
      );
    }
    return null;
  }
  /**
   * Validate string pattern
   */
  static validatePattern(fieldName, value, pattern) {
    const regex = typeof pattern === "string" ? new RegExp(pattern) : pattern;
    if (!regex.test(value)) {
      return ValidationError.invalidValue(
        fieldName,
        value,
        `string matching pattern ${pattern}`
      );
    }
    return null;
  }
}
export {
  AIError,
  ConfigurationError,
  DatabaseError,
  ErrorUtils,
  FilesystemError,
  NetworkError,
  RuntimeError,
  SmrtError,
  ValidationError,
  ValidationReport,
  ValidationUtils
};
//# sourceMappingURL=errors-D1u9UqLX.js.map
