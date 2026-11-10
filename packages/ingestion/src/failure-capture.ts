/**
 * Opt-in diagnostic capture of what the model sent on a failed interpretation
 * attempt (#4285).
 *
 * The recorded `provenance.failure` reason stays value-free (#4260/#4270).
 * This capture is the one place model output may be kept for diagnosis, so it
 * is off by default, bounded, passed through the host's redaction hook, kept
 * only on failed attempts, outside the digested result, and read back only
 * through the reviewer-authorized `getFailedAttemptCapture`.
 */
import type {
  FailedAttemptCaptureSource,
  FailedAttemptCaptureStatus,
} from './proposal-dto.js';

/** Default stored-text cap, in UTF-8 bytes. */
export const FAILURE_CAPTURE_DEFAULT_MAX_BYTES = 16_384;
/** Largest configurable stored-text cap, in UTF-8 bytes. */
export const FAILURE_CAPTURE_MAX_BYTES = 65_536;

/** Host configuration under `ProposalConfiguration.failureCapture`. */
export interface FailureCaptureConfiguration {
  /** Capture runs only when this is exactly `true`. Absent configuration is off. */
  enabled: boolean;
  /**
   * Cap on the stored text in UTF-8 bytes, applied after redaction.
   * Default 16384, at most 65536. A longer text is cut and marked `truncated`.
   */
  maxBytes?: number;
  /**
   * Host redaction is required to retain text. A missing hook stores only
   * `status: 'redaction_failed'`, without materializing the candidate text.
   * The hook receives text cut to the larger of `maxOutputBytes` and `maxBytes`.
   * Throwing, returning a non-string or exceeding the asynchronous wait budget
   * also stores only that marker; the attempt's real failure is preserved.
   * The wait budget is at most half the remaining lease and `timeoutMs`.
   * It cannot preempt synchronous work or cancel the hook: hosts must provide
   * bounded, nonblocking redaction and own its semantic redaction policy.
   */
  redact?(input: {
    text: string;
    source: FailedAttemptCaptureSource;
  }): string | Promise<string>;
}

/** Persisted beside the result in the attempt's `data`, never inside it. */
export interface StoredFailureCapture {
  version: 1;
  source: FailedAttemptCaptureSource;
  status: FailedAttemptCaptureStatus;
  /** Present only for `captured`. */
  text?: string;
  truncated: boolean;
  redacted: boolean;
  maxBytes: number;
  capturedAt: string;
}

/** Validate at service construction, like the other proposal settings. */
export function assertFailureCapture(
  config: FailureCaptureConfiguration | undefined,
): void {
  if (config === undefined) return;
  if (
    !config ||
    typeof config !== 'object' ||
    typeof config.enabled !== 'boolean' ||
    (config.maxBytes !== undefined &&
      (!Number.isSafeInteger(config.maxBytes) ||
        config.maxBytes < 1 ||
        config.maxBytes > FAILURE_CAPTURE_MAX_BYTES)) ||
    (config.redact !== undefined && typeof config.redact !== 'function')
  )
    throw new Error('Invalid failure capture configuration');
}

/** Cut to at most `maxBytes` UTF-8 bytes without splitting a character. */
export function truncateUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(0, end).toString('utf8'), truncated: true };
}

/** PostgreSQL JSON cannot hold NUL or unpaired surrogates; never fail the write. */
function storable(text: string): string {
  return text
    .replaceAll(String.fromCharCode(0), '\uFFFD')
    .replace(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g,
      '\uFFFD',
    );
}

/**
 * Build the record to store. Never throws and never rejects: a capture
 * problem must not replace the attempt's real failure.
 */
export async function prepareFailureCapture(
  config: FailureCaptureConfiguration | undefined,
  candidate: { source: FailedAttemptCaptureSource; text: () => string },
  bounds: { inputBytes: number; timeoutMs: number; now: Date },
): Promise<StoredFailureCapture | undefined> {
  if (config?.enabled !== true) return undefined;
  const maxBytes = config.maxBytes ?? FAILURE_CAPTURE_DEFAULT_MAX_BYTES;
  const hook = config.redact;
  const base = {
    version: 1 as const,
    source: candidate.source,
    redacted: !!hook,
    maxBytes,
    capturedAt: bounds.now.toISOString(),
  };
  // A hook is a prerequisite for retaining text, not a built-in sanitizer.
  // Do not even materialize raw output without it or an asynchronous budget.
  if (!hook || bounds.timeoutMs < 1)
    return { ...base, status: 'redaction_failed', truncated: false };
  let raw: string;
  try {
    raw = candidate.text();
  } catch {
    return undefined;
  }
  if (typeof raw !== 'string' || !raw.length) return undefined;
  const input = truncateUtf8(raw, Math.max(bounds.inputBytes, maxBytes));
  let text = input.text;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const redacted = await Promise.race([
      Promise.resolve().then(() =>
        hook.call(config, { text: input.text, source: candidate.source }),
      ),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('timeout')),
          bounds.timeoutMs,
        );
      }),
    ]);
    if (typeof redacted !== 'string') throw new Error('invalid');
    text = redacted;
  } catch {
    // The hook's error may itself quote the text: it is never kept.
    return { ...base, status: 'redaction_failed', truncated: false };
  } finally {
    clearTimeout(timer);
  }
  const stored = truncateUtf8(storable(text), maxBytes);
  return {
    ...base,
    status: 'captured',
    text: stored.text,
    truncated: input.truncated || stored.truncated,
  };
}

/** Parse a persisted record; anything malformed is treated as absent. */
export function storedFailureCapture(
  value: unknown,
): StoredFailureCapture | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !['raw_response', 'generated_output'].includes(String(record.source)) ||
    !['captured', 'redaction_failed'].includes(String(record.status)) ||
    typeof record.truncated !== 'boolean' ||
    typeof record.redacted !== 'boolean' ||
    typeof record.maxBytes !== 'number' ||
    !Number.isSafeInteger(record.maxBytes) ||
    record.maxBytes < 1 ||
    record.maxBytes > FAILURE_CAPTURE_MAX_BYTES ||
    typeof record.capturedAt !== 'string' ||
    (record.status === 'captured'
      ? typeof record.text !== 'string' ||
        record.redacted !== true ||
        Buffer.byteLength(record.text, 'utf8') > record.maxBytes
      : record.text !== undefined)
  )
    return undefined;
  return record as unknown as StoredFailureCapture;
}
