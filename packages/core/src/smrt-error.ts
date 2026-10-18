/**
 * `SmrtError`, the base of every SMRT framework error, on its own module
 * (#4100). It imports nothing, so browser-safe code (smrt-reports' `./spec`
 * grammar) can extend it through `@happyvertical/smrt-core/smrt-error` without
 * reaching the root entry's registry and manifest loader. `errors.ts`
 * re-exports this same class, so `instanceof SmrtError` holds across both.
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
