/**
 * Error classes for browser AI capabilities
 */

/**
 * Base error class for browser AI operations
 */
export class BrowserAIError extends Error {
  constructor(
    message: string,
    public code: string,
    public adapter?: string,
  ) {
    super(message);
    this.name = 'BrowserAIError';
  }
}

/**
 * Thrown when an adapter fails to initialize
 */
export class InitializationError extends BrowserAIError {
  constructor(adapter: string, reason?: string) {
    super(
      `Failed to initialize ${adapter} adapter${reason ? `: ${reason}` : ''}`,
      'INITIALIZATION_ERROR',
      adapter,
    );
    this.name = 'InitializationError';
  }
}

/**
 * Thrown when a required capability is not available
 */
export class CapabilityNotAvailableError extends BrowserAIError {
  constructor(capability: string, adapter?: string) {
    super(
      `Required capability not available: ${capability}`,
      'CAPABILITY_NOT_AVAILABLE',
      adapter,
    );
    this.name = 'CapabilityNotAvailableError';
  }
}

/**
 * Thrown when a model download fails
 */
export class DownloadError extends BrowserAIError {
  constructor(
    public url: string,
    reason?: string,
    adapter?: string,
  ) {
    super(
      `Failed to download from ${url}${reason ? `: ${reason}` : ''}`,
      'DOWNLOAD_ERROR',
      adapter,
    );
    this.name = 'DownloadError';
  }
}

/**
 * Thrown when model loading fails
 */
export class ModelLoadError extends BrowserAIError {
  constructor(
    public model: string,
    reason?: string,
    adapter?: string,
  ) {
    super(
      `Failed to load model ${model}${reason ? `: ${reason}` : ''}`,
      'MODEL_LOAD_ERROR',
      adapter,
    );
    this.name = 'ModelLoadError';
  }
}

/**
 * Thrown when an operation times out
 */
export class TimeoutError extends BrowserAIError {
  constructor(operation: string, timeoutMs: number, adapter?: string) {
    super(
      `Operation timed out after ${timeoutMs}ms: ${operation}`,
      'TIMEOUT_ERROR',
      adapter,
    );
    this.name = 'TimeoutError';
  }
}

/**
 * Thrown when user denies permission (e.g., microphone access)
 */
export class PermissionDeniedError extends BrowserAIError {
  constructor(permission: string, adapter?: string) {
    super(`Permission denied: ${permission}`, 'PERMISSION_DENIED', adapter);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Thrown when an adapter is not in the correct state for an operation
 */
export class InvalidStateError extends BrowserAIError {
  constructor(expectedState: string, actualState: string, adapter?: string) {
    super(
      `Invalid state: expected ${expectedState}, got ${actualState}`,
      'INVALID_STATE',
      adapter,
    );
    this.name = 'InvalidStateError';
  }
}

/**
 * Thrown when an adapter type is not supported
 */
export class UnsupportedAdapterError extends BrowserAIError {
  constructor(adapterType: string, supportedTypes: string[]) {
    super(
      `Unsupported adapter type: ${adapterType}. Supported: ${supportedTypes.join(', ')}`,
      'UNSUPPORTED_ADAPTER',
    );
    this.name = 'UnsupportedAdapterError';
  }
}
