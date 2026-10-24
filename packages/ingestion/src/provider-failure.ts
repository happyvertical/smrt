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
 * - for the SDK adapter's own response checks, a `ProposalResponseError` with a
 *   fixed problem from a closed list (and a closed-list finish reason);
 * - for any other error (#4285), only transport facts that cannot echo the
 *   document: the code-defined constructor name, an `AbortError`/`TimeoutError`
 *   name, a network `code` from a closed list (read from the error and up to
 *   three `cause` levels, where Node's fetch puts it), and a structured status;
 * - for an SDK `AIError` with no status, the OpenAI SDK's exact fixed
 *   transport messages (`Connection error.`, `Request timed out.`, ...).
 * Everything else in a message is dropped.
 */
import { AIError } from '@happyvertical/ai';

export const PROVIDER_FAILURE_REASON_LIMIT = 500;

/**
 * Why the SDK proposal adapter refused a response it did receive (#4285).
 * Previously these were plain `Error`s, which the reason deliberately reads
 * nothing from, so they all surfaced as a bare `provider call failed`.
 */
export type ProposalResponseProblem =
  | 'finish_reason'
  | 'truncated'
  | 'tool_calls'
  | 'unexpected_model'
  | 'no_text_content'
  | 'empty_content'
  | 'output_limit'
  | 'invalid_json';
/** Finish reasons the SDK reports; any other value is recorded as `other`. */
const FINISH_REASONS = new Set([
  'stop',
  'length',
  'tool_calls',
  'content_filter',
]);
const RESPONSE_PROBLEMS: Record<ProposalResponseProblem, string> = {
  finish_reason: 'provider response incomplete',
  truncated: 'provider response incomplete (truncated)',
  tool_calls: 'provider response contained tool calls',
  unexpected_model: 'provider response came from an unexpected model',
  no_text_content: 'provider response had no text content',
  empty_content: 'provider response was empty',
  output_limit: 'provider response exceeded the output limit',
  invalid_json: 'provider response was not valid JSON',
};
/** The SDK adapter's refusal of a received response; its message is fixed. */
export class ProposalResponseError extends Error {
  override readonly name = 'ProposalResponseError';
  readonly finishReason?: string;
  constructor(
    readonly problem: ProposalResponseProblem,
    message: string,
    finishReason?: unknown,
  ) {
    super(message);
    if (problem === 'finish_reason')
      this.finishReason =
        typeof finishReason === 'string' && FINISH_REASONS.has(finishReason)
          ? finishReason
          : 'other';
  }
}

/**
 * Raw provider text that came with a failure, held off the error object so a
 * host that logs or serializes the error never prints it. Read only by the
 * opt-in failed-attempt capture (#4285).
 */
const rawOutputs = new WeakMap<object, string>();
export function attachRawProviderOutput<T extends object>(
  error: T,
  text: unknown,
): T {
  if (typeof text === 'string') rawOutputs.set(error, text);
  return error;
}
export function rawProviderOutput(error: unknown): string | undefined {
  return error && typeof error === 'object' ? rawOutputs.get(error) : undefined;
}

/** Network error codes from Node, undici and the OS; nothing else is echoed. */
const NETWORK_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EAI_AGAIN',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETRESET',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'EPROTO',
  'ETIMEDOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UND_ERR_ABORTED',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CLOSED',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_DESTROYED',
  'UND_ERR_HEADERS_OVERFLOW',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_INFO',
  'UND_ERR_INVALID_ARG',
  'UND_ERR_INVALID_RETURN_VALUE',
  'UND_ERR_NOT_SUPPORTED',
  'UND_ERR_REQ_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
  'UND_ERR_RES_EXCEEDED_MAX_SIZE',
  'UND_ERR_RESPONSE_STATUS_CODE',
  'UND_ERR_SOCKET',
]);
const NETWORK_TIMEOUT_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
]);
const ABORT_NAMES = new Set(['AbortError', 'TimeoutError']);
/**
 * The OpenAI SDK's fixed transport messages. `mapError` turns its
 * `APIConnectionError` family into `AIError(message, 'API_ERROR')` without the
 * cause, so the exact message is the only remaining signal. Only an exact,
 * whole-message match counts.
 */
const SDK_TRANSPORT_MESSAGES: Record<string, string> = {
  'Connection error.': 'connection error',
  'Request timed out.': 'timeout',
  'Request was aborted.': 'aborted',
  '(no status code or body)': 'no status or body',
};

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

/** A code-defined class name; never the settable `name` or the message. */
function className(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const ctor = Object.getPrototypeOf(error)?.constructor;
  const name =
    typeof ctor === 'function' &&
    Object.getOwnPropertyDescriptor(ctor, 'name')?.value;
  return typeof name === 'string' &&
    /^[A-Z][A-Za-z0-9]{0,63}$/.test(name) &&
    /(?:Error|Exception)$/.test(name)
    ? name
    : undefined;
}

/** The first closed-list network code on the error or its `cause` chain. */
function networkCode(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const code = field(current, 'code');
    if (typeof code === 'string' && NETWORK_CODES.has(code)) return code;
    // AggregateError (happy-eyeballs connect) carries per-address errors.
    const errors = field(current, 'errors');
    if (Array.isArray(errors))
      for (const entry of errors.slice(0, 4)) {
        const nested = field(entry, 'code');
        if (typeof nested === 'string' && NETWORK_CODES.has(nested))
          return nested;
      }
    current = field(current, 'cause');
  }
  return undefined;
}

function abortName(error: unknown): string | undefined {
  let current = error;
  for (let depth = 0; depth < 4 && current; depth++) {
    const name = field(current, 'name');
    if (typeof name === 'string' && ABORT_NAMES.has(name)) return name;
    current = field(current, 'cause');
  }
  return undefined;
}

function responseReason(error: ProposalResponseError): string {
  const phrase = RESPONSE_PROBLEMS[error.problem];
  return error.problem === 'finish_reason'
    ? `${phrase} (finish reason ${error.finishReason ?? 'other'})`
    : phrase;
}

export function providerFailureReason(error: unknown): string {
  if (
    error instanceof ProposalResponseError &&
    Object.hasOwn(RESPONSE_PROBLEMS, error.problem)
  )
    return responseReason(error);
  // Only an SDK error's message and code are read at all; any other error
  // contributes at most a structured status and the transport facts below.
  const sdk =
    error instanceof AIError &&
    typeof error.code === 'string' &&
    SDK_ERROR_CODES.has(error.code)
      ? error
      : undefined;
  const message = sdk && typeof sdk.message === 'string' ? sdk.message : '';
  const transport =
    sdk && Object.hasOwn(SDK_TRANSPORT_MESSAGES, message)
      ? SDK_TRANSPORT_MESSAGES[message]
      : undefined;
  // Transport facts for errors outside the SDK's own vocabulary (#4285).
  const foreign = !sdk;
  const cls = foreign ? className(error) : undefined;
  const network = networkCode(error);
  // An SDK error names its own abort/timeout by code; a cause-chain abort name
  // is read only for errors outside the SDK vocabulary.
  const aborted = foreign ? abortName(error) : undefined;
  const facts = [
    ...(cls ? [`class ${cls}`] : []),
    ...(aborted ? [`name ${aborted}`] : []),
    ...(network ? [`network ${network}`] : []),
    ...(transport ? [`transport ${transport}`] : []),
  ];
  const status =
    structuredStatus(error) ??
    structuredStatus(field(error, 'cause')) ??
    (sdk ? sdkMessageStatus(sdk.code, message) : undefined);
  // An HTTP status is a response the provider gave: an abort or timeout seen
  // only in the cause chain never hides it.
  if (
    (sdk && SDK_ABORT_CODES.has(sdk.code)) ||
    transport === 'timeout' ||
    transport === 'aborted' ||
    (status === undefined &&
      (aborted !== undefined ||
        (network !== undefined && NETWORK_TIMEOUT_CODES.has(network))))
  ) {
    const details = [...(sdk ? [`code ${sdk.code}`] : []), ...facts];
    return `provider call aborted or timed out${details.length ? ` (${details.join(', ')})` : ''}`.slice(
      0,
      PROVIDER_FAILURE_REASON_LIMIT,
    );
  }
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
    ...facts,
  ];
  let reason = `provider ${category}${details.length ? ` (${details.join(', ')})` : ''}`;
  if (keywords.length)
    reason += `; unsupported response-schema keywords: ${keywords.join(', ')}`;
  return reason.slice(0, PROVIDER_FAILURE_REASON_LIMIT);
}
