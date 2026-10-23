/**
 * A bounded, value-free reason for a failed proposal generator call (#4260).
 *
 * A provider's error text cannot be trusted to be value-free: some servers
 * quote the invalid input back, which here is the prompt and the document
 * text. So no free text is ever copied. The reason is assembled only from:
 * - a fixed category phrase;
 * - the HTTP status, from a numeric `status`/`statusCode` field (100-599) on
 *   any error, or parsed from the message only of an SDK `AIError`, in the two
 *   exact shapes the SDK produces (see `sdkMessageStatus`);
 * - the SDK error `code`, only for an `AIError` and only from the closed list
 *   of codes the SDK raises;
 * - for a response-schema rejection reported through an `AIError`, only
 *   quoted tokens that are members of a closed list of JSON Schema keywords
 *   (e.g. llguidance's `Grammar error: Unimplemented keys: ["uniqueItems"]`).
 * Any other error contributes at most a structured status; everything else in
 * a message is dropped.
 */
import { AIError } from '@happyvertical/ai';

export const PROVIDER_FAILURE_REASON_LIMIT = 500;

/** JSON Schema (2020-12 and draft-07) keywords: the only words ever echoed. */
const SCHEMA_KEYWORDS = new Set([
  '$anchor',
  '$comment',
  '$defs',
  '$dynamicAnchor',
  '$dynamicRef',
  '$id',
  '$ref',
  '$schema',
  '$vocabulary',
  'additionalItems',
  'additionalProperties',
  'allOf',
  'anyOf',
  'const',
  'contains',
  'contentEncoding',
  'contentMediaType',
  'contentSchema',
  'default',
  'definitions',
  'dependencies',
  'dependentRequired',
  'dependentSchemas',
  'deprecated',
  'description',
  'else',
  'enum',
  'examples',
  'exclusiveMaximum',
  'exclusiveMinimum',
  'format',
  'if',
  'items',
  'maxContains',
  'maxItems',
  'maxLength',
  'maxProperties',
  'maximum',
  'minContains',
  'minItems',
  'minLength',
  'minProperties',
  'minimum',
  'multipleOf',
  'not',
  'oneOf',
  'pattern',
  'patternProperties',
  'prefixItems',
  'properties',
  'propertyNames',
  'readOnly',
  'required',
  'then',
  'title',
  'type',
  'unevaluatedItems',
  'unevaluatedProperties',
  'uniqueItems',
  'writeOnly',
]);

/** Phrases a structured-output backend uses when it rejects schema keywords. */
const SCHEMA_REJECTION =
  /unimplemented keys|unsupported (?:json[ -]?schema )?(?:keyword|key|feature)s?|not supported in (?:json[ -]?schema|grammar)/i;

/**
 * Error codes the `@happyvertical/ai` SDK raises on its chat path, collected
 * from its error classes and providers. Only these are ever echoed: a code
 * from anywhere else could be a document identifier (e.g. `INV5521`).
 */
const SDK_ERROR_CODES = new Set([
  'AI_ABORTED',
  'AI_TIMEOUT',
  'API_ERROR',
  'AUTH_ERROR',
  'CONTENT_FILTERED',
  'CONTEXT_LENGTH_EXCEEDED',
  'INITIALIZATION_ERROR',
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'MODEL_NOT_FOUND',
  'NETWORK_ERROR',
  'NO_CHOICES',
  'NOT_IMPLEMENTED',
  'NOT_SUPPORTED',
  'RATE_LIMIT',
  'REQUEST_ABORTED',
  'REQUEST_TIMEOUT',
  'TIMEOUT',
  'UNKNOWN_ERROR',
]);
/** SDK codes that mean the call was cancelled or ran out of time. */
const SDK_ABORT_CODES = new Set([
  'AI_ABORTED',
  'AI_TIMEOUT',
  'REQUEST_ABORTED',
  'REQUEST_TIMEOUT',
  'TIMEOUT',
]);

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** A status from a structured numeric field, on any error. */
function structuredStatus(error: unknown): number | undefined {
  for (const key of ['status', 'statusCode']) {
    const value = field(error, key);
    if (
      Number.isInteger(value) &&
      (value as number) >= 100 &&
      (value as number) <= 599
    )
      return value as number;
  }
  return undefined;
}

/**
 * A status parsed from an SDK error's message, only in the two exact shapes
 * the SDK itself produces:
 * - the OpenAI SDK's `APIError`, mapped to `API_ERROR` with the message
 *   `<status> <provider text>`, for error statuses only (400-599), so a
 *   document line such as `150 items on invoice` is never a status;
 * - the TypeSafe and Laya adapters: `TypeSafe request failed (<status>): ...`.
 */
function sdkMessageStatus(code: string, message: string): number | undefined {
  const match =
    (code === 'API_ERROR' ? /^([45]\d{2}) /.exec(message) : null) ??
    /^(?:TypeSafe|Laya) request failed \(([1-5]\d{2})\): /.exec(message);
  return match ? Number(match[1]) : undefined;
}

function rejectedKeywords(message: string): string[] {
  if (!SCHEMA_REJECTION.test(message)) return [];
  const found = new Set<string>();
  for (const [, token] of message.matchAll(/["'`]([$A-Za-z]{2,40})["'`]/g))
    if (SCHEMA_KEYWORDS.has(token)) found.add(token);
  return [...found].sort();
}

export function providerFailureReason(error: unknown): string {
  const name = field(error, 'name');
  // Only an SDK error's message and code are read at all; any other error
  // contributes at most a structured status.
  const sdk =
    error instanceof AIError &&
    typeof error.code === 'string' &&
    SDK_ERROR_CODES.has(error.code)
      ? error
      : undefined;
  if (
    name === 'AbortError' ||
    name === 'TimeoutError' ||
    (sdk && SDK_ABORT_CODES.has(sdk.code))
  )
    return 'provider call aborted or timed out';
  const message = sdk && typeof sdk.message === 'string' ? sdk.message : '';
  const status =
    structuredStatus(error) ??
    structuredStatus(field(error, 'cause')) ??
    (sdk ? sdkMessageStatus(sdk.code, message) : undefined);
  const code = sdk?.code;
  const keywords = sdk ? rejectedKeywords(message) : [];
  const category = keywords.length
    ? 'rejected the response schema'
    : status !== undefined && status >= 400 && status < 500
      ? 'rejected the request'
      : status !== undefined && status >= 500
        ? 'returned a server error'
        : 'call failed';
  const details = [
    ...(status !== undefined ? [`HTTP ${status}`] : []),
    ...(code ? [`code ${code}`] : []),
  ];
  let reason = `provider ${category}${details.length ? ` (${details.join(', ')})` : ''}`;
  if (keywords.length)
    reason += `; unsupported response-schema keywords: ${keywords.join(', ')}`;
  return reason.slice(0, PROVIDER_FAILURE_REASON_LIMIT);
}
