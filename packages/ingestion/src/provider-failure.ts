/**
 * A bounded, value-free reason for a failed proposal generator call (#4260).
 *
 * A provider's error text cannot be trusted to be value-free: some servers
 * quote the invalid input back, which here is the prompt and the document
 * text. So no free text is ever copied. The reason is assembled only from:
 * - a fixed category phrase;
 * - the HTTP status, read from a numeric `status`/`statusCode` field or from a
 *   three-digit status at the start of the message (`400 ...`) or in
 *   parentheses (`failed (400): ...`);
 * - the SDK error `code`, only when it is an upper-case identifier;
 * - for a response-schema rejection, only quoted tokens that are members of a
 *   closed list of JSON Schema keywords (e.g. vLLM/xgrammar's
 *   `Unimplemented keys: ["uniqueItems"]`).
 * Anything else in the message is dropped.
 */
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

function field(value: unknown, key: string): unknown {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function httpStatus(error: unknown, message: string): number | undefined {
  for (const key of ['status', 'statusCode']) {
    const value = field(error, key);
    if (
      Number.isInteger(value) &&
      (value as number) >= 100 &&
      (value as number) <= 599
    )
      return value as number;
  }
  const match = /^(\d{3})\b/.exec(message) ?? /\((\d{3})\)/.exec(message);
  const value = match ? Number(match[1]) : undefined;
  return value && value >= 100 && value <= 599 ? value : undefined;
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
  if (name === 'AbortError' || name === 'TimeoutError')
    return 'provider call aborted or timed out';
  const cause = field(error, 'cause');
  const messageOf = (value: unknown) => {
    const message = field(value, 'message');
    return typeof message === 'string' ? message : '';
  };
  const message = messageOf(error);
  const status =
    httpStatus(error, message) ?? httpStatus(cause, messageOf(cause));
  const rawCode = field(error, 'code');
  const code =
    typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(rawCode)
      ? rawCode
      : undefined;
  const keywords = rejectedKeywords(message);
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
