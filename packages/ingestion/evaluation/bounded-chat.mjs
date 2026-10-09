import { runReservedCall, tokenChargeBound } from './budget.mjs';
import { sha256 } from './corpus.mjs';

export const PROPOSAL_BOUND = Object.freeze({
  model: 'gpt-5.4-mini-2026-03-17',
  maxSerializedBytes: 8192,
  framingTokens: 512,
  maxOutputTokens: 1024,
  inputNanoUSD: 750,
  outputNanoUSD: 4500,
});
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
    !Number.isSafeInteger(options.maxTokens) ||
    options.maxTokens < 1 ||
    options.maxTokens > PROPOSAL_BOUND.maxOutputTokens ||
    options.toolChoice !== 'none' ||
    options.continueOnLength !== false ||
    JSON.stringify(options.responseFormat) !== '{"type":"json_object"}' ||
    Object.keys(options).some(
      (key) =>
        ![
          'model',
          'maxTokens',
          'toolChoice',
          'continueOnLength',
          'responseFormat',
          'signal',
          'timeout',
        ].includes(key),
    )
  )
    throw new Error('Unsupported bounded proposal options');
  // JSON spelling follows the inspected owning SDK wire. The complete envelope
  // includes roles/content and provider framing allowance, not just evidence text.
  const envelope = JSON.stringify({
    messages,
    model: options.model,
    ...JSON.parse(
      '{"tool_choice":"none","response_format":{"type":"json_object"}}',
    ),
    ...JSON.parse(`{"max_completion_tokens":${options.maxTokens}}`),
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
      const bound = proposalRequestBound(messages, options);
      const capturedMessages = messages.map(({ role, content }) => ({
        role,
        content,
      }));
      const capturedOptions = {
        ...options,
        responseFormat: { ...options.responseFormat },
      };
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
