/**
 * Comprehensive error handling system for SMRT framework
 *
 * Provides specialized error types for different failure scenarios
 * with proper error codes, messages, and debugging information.
 */

/**
 * Abstract base class for all SMRT framework errors.
 *
 * Adds a structured `code` (machine-readable string constant), a `category`
 * (coarse error domain), optional structured `details`, and an optional
 * causal `Error` chain on top of the standard `Error` class.
 *
 * Never throw `SmrtError` directly — use one of the concrete subclasses
 * (`DatabaseError`, `AIError`, `ValidationError`, etc.) or their static
 * factory methods for consistent error codes and messages.
 *
 * @example
 * ```typescript
 * try {
 *   await product.save();
 * } catch (err) {
 *   if (err instanceof ValidationError) {
 *     console.error(err.code, err.details); // 'VALIDATION_REQUIRED_FIELD', { fieldName, objectType }
 *   }
 *   if (err instanceof SmrtError) {
 *     logger.error(ErrorUtils.sanitizeError(err));
 *   }
 * }
 * ```
 */

import { createLogger } from '@happyvertical/logger';

const logger = createLogger({ level: 'info' });

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
  public readonly details?: Record<string, unknown>;
  public readonly cause?: Error;

  constructor(
    message: string,
    code: string,
    category: SmrtError['category'],
    details?: Record<string, unknown>,
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

type ErrorLikeWithContext = Error & {
  cause?: unknown;
  context?: {
    originalError?: unknown;
  };
};

function collectErrorMessages(
  value: unknown,
  messages: string[],
  visited: Set<unknown>,
  depth = 0,
): void {
  if (!value || visited.has(value) || depth > 10) {
    return;
  }

  visited.add(value);

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed) {
      messages.push(trimmed);
    }
    return;
  }

  if (!(value instanceof Error)) {
    return;
  }

  const message = value.message?.trim();
  if (message) {
    messages.push(message);
  }

  const errorWithContext = value as ErrorLikeWithContext;
  collectErrorMessages(
    errorWithContext.context?.originalError,
    messages,
    visited,
    depth + 1,
  );
  collectErrorMessages(errorWithContext.cause, messages, visited, depth + 1);
}

function getPrimaryCauseMessage(cause?: Error): {
  message?: string;
  messages?: string[];
} {
  if (!cause) {
    return {};
  }

  const collected: string[] = [];
  collectErrorMessages(cause, collected, new Set<unknown>());

  const uniqueMessages = [...new Set(collected.filter(Boolean))];
  if (uniqueMessages.length === 0) {
    return {};
  }

  return {
    message: uniqueMessages[uniqueMessages.length - 1],
    messages: uniqueMessages,
  };
}

/**
 * Errors originating from database operations.
 *
 * Use the static factory methods rather than the constructor directly:
 * - `DatabaseError.connectionFailed(url, cause)` — DB connection failure
 * - `DatabaseError.queryFailed(query, cause)` — SQL execution error
 * - `DatabaseError.schemaError(table, op, cause)` — DDL/migration error
 * - `DatabaseError.constraintViolation(constraint, value, cause)` — FK/CHECK/UNIQUE
 * - `DatabaseError.corruptedData(field, class, cause)` — unparse-able column data
 * - `DatabaseError.missingDiscriminator(class, rowId)` — STI row missing `_meta_type`
 * - `DatabaseError.stiDiscriminatorConflict(...)` — legacy STI discriminator collides during qualification
 * - `DatabaseError.schemaMissing(table, class)` — table not yet migrated
 *
 * All errors have `category: 'database'` and codes prefixed with `DB_`.
 */
export class DatabaseError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>,
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
    // Include the deepest actionable cause message for better debugging.
    const causeInfo = getPrimaryCauseMessage(cause);
    const causeMsg = causeInfo.message ? `\nCause: ${causeInfo.message}` : '';
    return new DatabaseError(
      `Database query failed: ${query.substring(0, 100)}${query.length > 100 ? '...' : ''}${causeMsg}`,
      'DB_QUERY_FAILED',
      {
        query,
        causeMessage: causeInfo.message,
        causeMessages: causeInfo.messages,
      },
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
    value: unknown,
    cause?: Error,
  ): DatabaseError {
    return new DatabaseError(
      `Database constraint violation: ${constraint}`,
      'DB_CONSTRAINT_VIOLATION',
      { constraint, value },
      cause,
    );
  }

  static corruptedData(
    fieldName: string,
    className: string,
    cause?: Error,
  ): DatabaseError {
    return new DatabaseError(
      `Corrupted data in field '${fieldName}' for ${className}. ` +
        `The data cannot be parsed or is malformed. ` +
        `This may indicate database corruption or incompatible schema changes.`,
      'DB_CORRUPTED_DATA',
      { fieldName, className },
      cause,
    );
  }

  static missingDiscriminator(
    className: string,
    rowId?: string,
  ): DatabaseError {
    return new DatabaseError(
      `Missing discriminator (_meta_type) for STI class ${className}${rowId ? ` (row id: ${rowId})` : ''}. ` +
        `STI classes require a discriminator column to determine the correct subclass. ` +
        `This may indicate a schema mismatch or manual database modification.`,
      'DB_MISSING_DISCRIMINATOR',
      { className, rowId },
    );
  }

  static stiDiscriminatorConflict(details: {
    className: string;
    tableName: string;
    id: string;
    slug: string;
    context: string;
    conflictIdentity: Record<string, unknown>;
    legacyMetaType: string;
    qualifiedMetaType: string;
    duplicateId: string;
  }): DatabaseError {
    const identityText = Object.entries(details.conflictIdentity)
      .map(([key, value]) => `${key} '${String(value)}'`)
      .join(', ');

    return new DatabaseError(
      `Legacy STI discriminator collision for ${details.className} (${details.tableName}). ` +
        `Row '${details.id}' would upgrade _meta_type from '${details.legacyMetaType}' to '${details.qualifiedMetaType}', ` +
        `but row '${details.duplicateId}' already uses the qualified discriminator for ${identityText || 'the same conflict identity'}. ` +
        `Merge or remove the duplicate legacy/qualified rows before saving.`,
      'DB_STI_DISCRIMINATOR_CONFLICT',
      details,
    );
  }

  static schemaMissing(tableName: string, className: string): DatabaseError {
    return new DatabaseError(
      `Table '${tableName}' does not exist for class '${className}'. ` +
        `Run 'smrt db:migrate' to create database schema.`,
      'DB_SCHEMA_MISSING',
      { tableName, className },
    );
  }
}

/**
 * Errors from AI provider integrations.
 *
 * Use the static factory methods:
 * - `AIError.providerError(provider, operation, cause)` — generic provider failure
 * - `AIError.rateLimitExceeded(provider, retryAfter)` — rate limit hit
 * - `AIError.invalidResponse(provider, response)` — unexpected response shape
 * - `AIError.authenticationFailed(provider)` — bad API key / credentials
 *
 * All errors have `category: 'ai'` and codes prefixed with `AI_`.
 * AI errors are considered retryable by `ErrorUtils.isRetryable()`.
 */
export class AIError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>,
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

  static invalidResponse(provider: string, response: unknown): AIError {
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
 * Errors from filesystem operations.
 *
 * Use the static factory methods:
 * - `FilesystemError.fileNotFound(path)` — file does not exist
 * - `FilesystemError.permissionDenied(path, operation)` — access denied
 * - `FilesystemError.diskSpaceExceeded(path, requiredBytes)` — insufficient space
 *
 * All errors have `category: 'filesystem'` and codes prefixed with `FS_`.
 */
export class FilesystemError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>,
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
 * Input/data validation errors thrown before or during a database operation.
 *
 * `save()` throws `ValidationError` when field validation fails. The collection's
 * `convertWhereKeys()` throws it for invalid WHERE clause operators or field names.
 * `ValidationError` is **not** retried by `ErrorUtils.withRetry()`.
 *
 * Use the static factory methods:
 * - `ValidationError.requiredField(field, objectType)` — missing required field
 * - `ValidationError.invalidValue(field, value, expected)` — wrong type/format
 * - `ValidationError.uniqueConstraint(field, value)` — duplicate unique value
 * - `ValidationError.rangeError(field, value, min?, max?)` — out of allowed range
 *
 * All errors have `category: 'validation'` and codes prefixed with `VALIDATION_`.
 */
export class ValidationError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>,
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
    value: unknown,
    expectedType: string,
  ): ValidationError {
    return new ValidationError(
      `Invalid value for field '${fieldName}': expected ${expectedType}, got ${typeof value}`,
      'VALIDATION_INVALID_VALUE',
      { fieldName, value, expectedType },
    );
  }

  static uniqueConstraint(fieldName: string, value: unknown): ValidationError {
    return new ValidationError(
      `Unique constraint violation for field '${fieldName}' with value: ${String(value)}`,
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
 * Errors from HTTP and external network operations.
 *
 * Use the static factory methods:
 * - `NetworkError.requestFailed(url, status?, body?)` — non-2xx response or connection failure
 * - `NetworkError.timeout(url, timeoutMs)` — request exceeded timeout
 * - `NetworkError.serviceUnavailable(service, reason?)` — external service down
 *
 * All errors have `category: 'network'` and codes prefixed with `NETWORK_`.
 * Network errors are considered retryable by `ErrorUtils.isRetryable()`.
 */
export class NetworkError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>,
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
 * Errors from misconfigured or incompatible class/framework setup.
 *
 * These are typically thrown during class registration (i.e. at module load time),
 * not during normal request handling.
 *
 * Use the static factory methods:
 * - `ConfigurationError.missingConfiguration(key, context?)` — missing required config
 * - `ConfigurationError.invalidConfiguration(key, value, expected)` — wrong config type/value
 * - `ConfigurationError.initializationFailed(component, cause?)` — component failed to start
 * - `ConfigurationError.circularInheritance(class, chain)` — circular class inheritance
 * - `ConfigurationError.incompatibleStrategy(class, strategy, parent, parentStrategy)` — STI mismatch
 * - `ConfigurationError.unregisteredBaseClass(child, base)` — STI base not yet registered
 *
 * All errors have `category: 'configuration'` and codes prefixed with `CONFIG_`.
 * Configuration errors are **not** retried by `ErrorUtils.withRetry()`.
 */
export class ConfigurationError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>,
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
    value: unknown,
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

  static circularInheritance(
    className: string,
    inheritanceChain: string[],
  ): ConfigurationError {
    return new ConfigurationError(
      `Circular inheritance detected for class '${className}'. ` +
        `Inheritance chain: ${inheritanceChain.join(' → ')} → ${className}. ` +
        `Classes cannot inherit from themselves directly or indirectly.`,
      'CONFIG_CIRCULAR_INHERITANCE',
      { className, inheritanceChain },
    );
  }

  static incompatibleStrategy(
    className: string,
    classStrategy: string,
    parentClass: string,
    parentStrategy: string,
  ): ConfigurationError {
    return new ConfigurationError(
      `Incompatible table strategy for class '${className}' (${classStrategy}). ` +
        `Parent class '${parentClass}' uses ${parentStrategy} strategy. ` +
        `Child classes must use the same table strategy as their parent. ` +
        `Either change ${className} to use ${parentStrategy}, or remove the inheritance.`,
      'CONFIG_INCOMPATIBLE_STRATEGY',
      { className, classStrategy, parentClass, parentStrategy },
    );
  }

  static unregisteredBaseClass(
    childClass: string,
    baseClass: string,
  ): ConfigurationError {
    return new ConfigurationError(
      `STI base class '${baseClass}' is not registered for child class '${childClass}'. ` +
        `When using Single Table Inheritance, the base class must be registered before any child classes. ` +
        `Ensure ${baseClass} is decorated with @smrt({ tableStrategy: 'sti' }) and imported before ${childClass}.`,
      'CONFIG_UNREGISTERED_BASE',
      { childClass, baseClass },
    );
  }
}

/**
 * Errors representing unexpected runtime failures not covered by other categories.
 *
 * `RuntimeError` is the catch-all for internal framework errors — invalid object
 * state, exhausted resources, or failures in operations like `save()` and `loadFromId()`
 * that propagate from an unknown cause.
 *
 * Use the static factory methods:
 * - `RuntimeError.operationFailed(operation, context?, cause?)` — generic operation failure
 * - `RuntimeError.invalidState(message, context?)` — unexpected object/system state
 * - `RuntimeError.resourceExhausted(resource, limit)` — limit exceeded (e.g. connections)
 *
 * All errors have `category: 'runtime'` and codes prefixed with `RUNTIME_`.
 */
export class RuntimeError extends SmrtError {
  constructor(
    message: string,
    code: string,
    details?: Record<string, unknown>,
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
    context?: Record<string, unknown>,
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
 * Error thrown when a tenant isolation boundary is crossed while resolving a
 * relationship.
 *
 * Raised by {@link SmrtObject.loadRelated} / {@link SmrtObject.loadRelatedMany}
 * (and {@link SmrtObject.getRelated}, which delegates to them) when a
 * tenant-scoped object resolves a relationship to an object belonging to a
 * *different*, non-null tenant — the genuine cross-tenant data leak. The guard
 * is a no-op when either side has a `null` tenant (global / non-tenant-scoped
 * models) and when both sides share the same tenant, so it only fires on real
 * leaks. Pass `{ allowCrossTenant: true }` to the loader to deliberately opt out.
 *
 * The `code` is always `'TENANT_ISOLATION_VIOLATION'` and the category is
 * `'validation'`. It is never retried — `ErrorUtils.withRetry()` rethrows it
 * immediately and `ErrorUtils.isRetryable()` returns `false` — because a tenant
 * boundary violation is deterministic. `tenantId` is the owning object's tenant
 * and `attemptedTenantId` is the tenant of the object that was reached.
 *
 * This shares its stable `code`, `name`, `tenantId`, and `attemptedTenantId`
 * shape with the interceptor-level `TenantIsolationError` in
 * `@happyvertical/smrt-tenancy`, so cross-cutting handlers can match either via
 * `err.code === 'TENANT_ISOLATION_VIOLATION'`. They are intentionally distinct
 * classes because `@happyvertical/smrt-core` cannot depend on the tenancy
 * package (the dependency runs the other way).
 *
 * @example
 * ```typescript
 * try {
 *   await order.loadRelated('customerId');
 * } catch (err) {
 *   if (err instanceof TenantIsolationError) {
 *     // err.tenantId          — the order's tenant
 *     // err.attemptedTenantId — the customer's tenant
 *   }
 * }
 * ```
 *
 * @see SmrtObject.loadRelated
 * @see SmrtObject.loadRelatedMany
 */
export class TenantIsolationError extends SmrtError {
  /** The tenant ID of the object that owns the relationship. */
  public readonly tenantId?: string;
  /** The tenant ID of the related object that was reached (and rejected). */
  public readonly attemptedTenantId?: string;

  constructor(
    message: string,
    details?: {
      tenantId?: string;
      attemptedTenantId?: string;
      [key: string]: unknown;
    },
    cause?: Error,
  ) {
    super(message, 'TENANT_ISOLATION_VIOLATION', 'validation', details, cause);
    this.tenantId = details?.tenantId;
    this.attemptedTenantId = details?.attemptedTenantId;
  }

  /**
   * Builds a {@link TenantIsolationError} for a blocked cross-tenant
   * relationship resolution, with a descriptive message and structured details.
   */
  static crossTenantReference(details: {
    sourceClass: string;
    fieldName: string;
    sourceTenantId: string;
    targetClass?: string;
    targetTenantId: string;
  }): TenantIsolationError {
    const target = details.targetClass
      ? `${details.targetClass} (tenant '${details.targetTenantId}')`
      : `tenant '${details.targetTenantId}'`;
    return new TenantIsolationError(
      `Cross-tenant relationship access blocked on ${details.sourceClass}.${details.fieldName}: ` +
        `owning tenant '${details.sourceTenantId}' does not match ${target}. ` +
        `Pass { allowCrossTenant: true } to loadRelated()/loadRelatedMany()/getRelated() to override.`,
      {
        tenantId: details.sourceTenantId,
        attemptedTenantId: details.targetTenantId,
        sourceClass: details.sourceClass,
        fieldName: details.fieldName,
        targetClass: details.targetClass,
      },
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

        // Skip retry for certain error types. A tenant isolation violation is
        // deterministic — retrying re-fetches the same cross-tenant target — and
        // is a security boundary, so it must never be retried.
        if (
          error instanceof ValidationError ||
          error instanceof ConfigurationError ||
          error instanceof TenantIsolationError
        ) {
          throw error;
        }

        // Wait before retrying with exponential backoff
        // Wrap in try-catch to handle any potential timer errors
        try {
          await new Promise<void>((resolve) => {
            setTimeout(() => resolve(), delay * backoffMultiplier ** attempt);
          });
        } catch (timerError) {
          // Log timer error but don't fail the retry
          logger.error('Timer error during retry', { error: timerError });
        }
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
  static sanitizeError(error: Error): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    if (error instanceof SmrtError) {
      sanitized.code = error.code;
      sanitized.category = error.category;

      // Sanitize details to remove potential sensitive information
      if (error.details) {
        const details: Record<string, unknown> = { ...error.details };
        sanitized.details = details;

        // Remove common sensitive fields
        const sensitiveFields = [
          'password',
          'token',
          'key',
          'secret',
          'apiKey',
        ];
        for (const field of sensitiveFields) {
          if (details[field]) {
            details[field] = '[REDACTED]';
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
    value: unknown,
    options: {
      required?: boolean;
      min?: number;
      max?: number;
      minLength?: number;
      maxLength?: number;
      pattern?: string | RegExp;
      type?: string;
      customValidator?: (value: unknown) => boolean | Promise<boolean>;
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
    value: unknown,
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
