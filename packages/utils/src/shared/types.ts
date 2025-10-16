/**
 * Shared type definitions and interfaces for universal use
 *
 * This module provides standardized error classes and logging interfaces
 * used throughout the HAVE SDK. All error classes extend BaseError to
 * provide consistent error handling with context and timestamps.
 */

/**
 * Standardized error codes used across the HAVE SDK
 *
 * These codes provide consistent error categorization for better error handling
 * and monitoring across all packages in the SDK.
 */
export enum ErrorCode {
  /** Input validation failed */
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  /** API request/response error */
  API_ERROR = 'API_ERROR',
  /** File system operation error */
  FILE_ERROR = 'FILE_ERROR',
  /** Network connectivity or HTTP error */
  NETWORK_ERROR = 'NETWORK_ERROR',
  /** Database operation error */
  DATABASE_ERROR = 'DATABASE_ERROR',
  /** Data parsing or format error */
  PARSING_ERROR = 'PARSING_ERROR',
  /** Operation timeout error */
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  /** Unspecified or unexpected error */
  UNKNOWN_ERROR = 'UNKNOWN_ERROR',
}

/**
 * Base error class providing standardized error handling across the HAVE SDK
 *
 * All custom errors extend this class to ensure consistent error structure,
 * context preservation, and debugging capabilities.
 *
 * @example
 * ```typescript
 * throw new BaseError('Something went wrong', ErrorCode.UNKNOWN_ERROR, {
 *   userId: 123,
 *   operation: 'processData'
 * });
 * ```
 */
export class BaseError extends Error {
  /** Error classification code */
  public readonly code: ErrorCode;
  /** Additional context data for debugging */
  public readonly context?: Record<string, unknown>;
  /** When the error occurred */
  public readonly timestamp: Date;

  constructor(
    message: string,
    code: ErrorCode = ErrorCode.UNKNOWN_ERROR,
    context?: Record<string, unknown>,
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.context = context;
    this.timestamp = new Date();
    Error.captureStackTrace?.(this, this.constructor);
  }

  /**
   * Serializes the error to a JSON-compatible object
   * @returns Object containing all error properties
   */
  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      context: this.context,
      timestamp: this.timestamp.toISOString(),
      stack: this.stack,
    };
  }
}

/**
 * Error thrown when input validation fails
 *
 * @example
 * ```typescript
 * throw new ValidationError('Email format invalid', {
 *   email: 'invalid-email',
 *   field: 'userEmail'
 * });
 * ```
 */
export class ValidationError extends BaseError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, ErrorCode.VALIDATION_ERROR, context);
  }
}

/**
 * Error thrown for API-related failures
 *
 * @example
 * ```typescript
 * throw new ApiError('HTTP 404 Not Found', {
 *   url: 'https://api.example.com/users/123',
 *   status: 404
 * });
 * ```
 */
export class ApiError extends BaseError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, ErrorCode.API_ERROR, context);
  }
}

/**
 * Error thrown for file system operation failures
 *
 * @example
 * ```typescript
 * throw new FileError('File not found', {
 *   path: '/path/to/missing/file.txt',
 *   operation: 'read'
 * });
 * ```
 */
export class FileError extends BaseError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, ErrorCode.FILE_ERROR, context);
  }
}

/**
 * Error thrown for network connectivity or HTTP failures
 *
 * @example
 * ```typescript
 * throw new NetworkError('Connection timeout', {
 *   host: 'example.com',
 *   timeout: 5000,
 *   attempt: 3
 * });
 * ```
 */
export class NetworkError extends BaseError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, ErrorCode.NETWORK_ERROR, context);
  }
}

/**
 * Error thrown for database operation failures
 *
 * @example
 * ```typescript
 * throw new DatabaseError('Connection failed', {
 *   database: 'production',
 *   query: 'SELECT * FROM users',
 *   errorCode: 'ECONNREFUSED'
 * });
 * ```
 */
export class DatabaseError extends BaseError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, ErrorCode.DATABASE_ERROR, context);
  }
}

/**
 * Error thrown for data parsing or format failures
 *
 * @example
 * ```typescript
 * throw new ParsingError('Invalid JSON format', {
 *   input: '{invalid json}',
 *   parser: 'JSON.parse',
 *   position: 1
 * });
 * ```
 */
export class ParsingError extends BaseError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, ErrorCode.PARSING_ERROR, context);
  }
}

/**
 * Error thrown when operations exceed their timeout duration
 *
 * @example
 * ```typescript
 * throw new TimeoutError('Operation timed out', {
 *   timeout: 5000,
 *   operation: 'fetchData',
 *   elapsedTime: 5234
 * });
 * ```
 */
export class TimeoutError extends BaseError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, ErrorCode.TIMEOUT_ERROR, context);
  }
}

/**
 * Logging interface for consistent logging across the HAVE SDK
 *
 * All logging implementations should follow this interface to ensure
 * consistent behavior and easy swapping of logging backends.
 *
 * @example
 * ```typescript
 * class CustomLogger implements Logger {
 *   info(message: string, context?: Record<string, unknown>) {
 *     console.log(`INFO: ${message}`, context);
 *   }
 *   // ... implement other methods
 * }
 * ```
 */
export interface Logger {
  /** Log debug information (lowest priority) */
  debug(message: string, context?: Record<string, unknown>): void;
  /** Log informational messages */
  info(message: string, context?: Record<string, unknown>): void;
  /** Log warning messages */
  warn(message: string, context?: Record<string, unknown>): void;
  /** Log error messages (highest priority) */
  error(message: string, context?: Record<string, unknown>): void;
}
