import { runReservedCall, tokenChargeBound } from './budget.mjs';
import { sha256 } from './corpus.mjs';

export const PROPOSAL_BOUND = Object.freeze({
  model: 'gpt-6-luna',
  maxSerializedBytes: 8192,
  framingTokens: 512,
  maxOutputTokens: 1024,
  // Cache-write price is the highest applicable input rate; no cache discount.
  inputNanoUSD: 125,
  outputNanoUSD: 500,
});
// No published GPT-6 Luna image multiplier: reserve the entire context at
// long-context cache-write pricing, plus the enforced output ceiling.
export const VISION_BOUND = Object.freeze({
  maximumInputTokens: 1050000,
  maxOutputTokens: 4096,
  inputNanoUSD: 250,
  outputNanoUSD: 750,
});
/** Only the priced standard global endpoint or local nonbillable transport tests. */
export function assertProviderEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== '/v1'
  )
    throw Error('Unpriced provider endpoint');
  if (url.href === 'https://api.openai.com/v1') return;
  if (url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port)
    return;
  throw Error('Unpriced provider endpoint');
}
/** Only the two proposal SDK output formats; schemas are part of the wire bound. */
function supportedResponseFormat(options) {
  const format = options.responseFormat;
  if (JSON.stringify(format) === '{"type":"json_object"}')
    return options.responseSchema === undefined;
  const schema = format?.json_schema;
  return (
    format?.type === 'json_schema' &&
    Object.keys(format).every((key) => ['type', 'json_schema'].includes(key)) &&
    schema &&
    typeof schema === 'object' &&
    !Array.isArray(schema) &&
    Object.keys(schema).every((key) =>
      ['name', 'description', 'schema', 'strict'].includes(key),
    ) &&
    schema.name === 'ingestion_proposal' &&
    schema.strict === false &&
    (schema.description === undefined ||
      typeof schema.description === 'string') &&
    schema.schema &&
    typeof schema.schema === 'object' &&
    !Array.isArray(schema.schema) &&
    schema.schema.type === 'object' &&
    schema.schema.additionalProperties === false &&
    schema.schema.properties &&
    typeof schema.schema.properties === 'object' &&
    !Array.isArray(schema.schema.properties) &&
    JSON.stringify(schema.schema) === JSON.stringify(options.responseSchema)
  );
}
/** Complete text-only chat envelope guard. No decision/vision/tools/continuation route. */
export function proposalRequestBound(messages, options) {
  if (
    !Array.isArray(messages) ||
    messages.length !== 2 ||
    messages[0]?.role !== 'system' ||
    messages[1]?.role !== 'user' ||
    messages.some(
      (message) =>
        typeof message.content !== 'string' ||
        Object.keys(message).some((key) => !['role', 'content'].includes(key)),
    )
  )
    throw new Error('Unsupported bounded proposal messages');
  if (
    options.model !== PROPOSAL_BOUND.model ||
    (options.reasoning !== undefined &&
      JSON.stringify(options.reasoning) !== '{"effort":"none"}') ||
    !Number.isSafeInteger(options.maxTokens) ||
    options.maxTokens < 1 ||
    options.maxTokens > PROPOSAL_BOUND.maxOutputTokens ||
    options.toolChoice !== 'none' ||
    options.continueOnLength !== false ||
    !supportedResponseFormat(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          'model',
          'reasoning',
          'maxTokens',
          'toolChoice',
          'continueOnLength',
          'responseFormat',
          'responseSchema',
          'signal',
          'timeout',
        ].includes(key),
    )
  )
    throw new Error('Unsupported bounded proposal options');
  // JSON spelling follows the inspected owning SDK wire. The complete envelope
  // includes roles/content and provider framing allowance, not just evidence text.
  const envelope = JSON.stringify({
    model: options.model,
    messages,
    ...JSON.parse(`{"max_completion_tokens":${options.maxTokens}}`),
    ...JSON.parse(
      `{"response_format":${JSON.stringify(options.responseFormat)}}`,
    ),
    // The owning OpenAI SDK sends no tool_choice without tools, and sets stream=false.
    stream: false,
    ...JSON.parse('{"reasoning_effort":"none"}'),
  });
  const bytes = Buffer.byteLength(envelope);
  if (bytes > PROPOSAL_BOUND.maxSerializedBytes)
    throw new Error('Full proposal request byte ceiling');
  return {
    requestHash: sha256(envelope),
    serializedBytes: bytes,
    maximumCharge: tokenChargeBound({
      inputTokens:
        PROPOSAL_BOUND.maxSerializedBytes + PROPOSAL_BOUND.framingTokens,
      outputTokens: PROPOSAL_BOUND.maxOutputTokens,
      inputNanoUSD: PROPOSAL_BOUND.inputNanoUSD,
      outputNanoUSD: PROPOSAL_BOUND.outputNanoUSD,
    }),
  };
}

/** Trusted host supplies an already verified zero-retry SDK client and immutable call identity.
 * This is a budget boundary around the owning SDK, not another provider transport.
 * Missing/raw-normalized usage is never used to refund; keep the full reserve.
 */
export function createBudgetedProposalChat(ledger, identity, client) {
  return {
    async chat(messages, options) {
      // Validate caller options before normalization can replace or omit fields.
      proposalRequestBound(messages, options);
      const capturedMessages = messages.map(({ role, content }) => ({
        role,
        content,
      }));
      const capturedOptions = {
        ...options,
        reasoning: { effort: 'none' },
        responseFormat: structuredClone(options.responseFormat),
        ...(options.responseSchema === undefined
          ? {}
          : { responseSchema: structuredClone(options.responseSchema) }),
      };
      const bound = proposalRequestBound(capturedMessages, capturedOptions);
      const result = await runReservedCall(
        ledger,
        {
          id: identity.callId,
          runHash: identity.runHash,
          stage: 'proposal',
          requestHash: bound.requestHash,
          maximumCharge: bound.maximumCharge,
        },
        async () => ({
          response: await client.chat(capturedMessages, capturedOptions),
          charge: { kind: 'unknown' },
        }),
      );
      return result.response;
    },
  };
}
