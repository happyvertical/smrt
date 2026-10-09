import type {
  AIInterface,
  DecisionOptions,
  DecisionRequest,
} from '@happyvertical/ai';
import type { DecisionClient } from '@happyvertical/smrt-core';
import { type ProviderIdentity, providerIdentity } from './extraction-types.js';
import type { ProposalGenerator } from './proposal-contracts.js';
import { safeUsage } from './proposal-validation.js';

/** Use an existing SDK client; credentials/configuration never enter persisted provenance. */
export function createSDKProposalGenerator(
  client: Pick<AIInterface, 'chat'>,
  configuredIdentity: ProviderIdentity,
  limits: { maxTokens: number; timeoutMs: number },
): ProposalGenerator {
  const identity = Object.freeze(providerIdentity(configuredIdentity));
  if (
    ![limits.maxTokens, limits.timeoutMs].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    throw new Error('Invalid proposal SDK limits');
  return {
    identity,
    async generate(input, options) {
      const response = await client.chat(
        [
          { role: 'system', content: input.instructions },
          {
            role: 'user',
            content: JSON.stringify({
              evidence: input.evidence,
              offered: input.offered,
            }),
          },
        ],
        {
          model: identity.model,
          maxTokens: limits.maxTokens,
          timeout: limits.timeoutMs,
          signal: options.signal,
          toolChoice: 'none',
          responseFormat: { type: 'json_object' },
          continueOnLength: false,
        },
      );
      if (
        response.finishReason !== 'stop' ||
        response.truncated ||
        response.toolCalls?.length ||
        (response.model && response.model !== identity.model)
      )
        throw new Error('Incomplete or unexpected proposal response');
      if (
        typeof response.content !== 'string' ||
        Buffer.byteLength(response.content) > options.maxOutputBytes
      )
        throw new Error('Proposal output limit');
      return {
        output: JSON.parse(response.content),
        // The SDK normalizes absent/unknown finish reasons to stop.
        completion: 'unknown',
        usage: safeUsage(response.usage),
      };
    },
  };
}

/** Adapt the SDK's optional capability to core's injected decision boundary. */
export function createSDKProposalDecisionClient(
  client: Pick<AIInterface, 'getCapabilities' | 'decide'>,
): DecisionClient {
  return {
    getCapabilities: () => client.getCapabilities(),
    decide: (request, options) => {
      if (!client.decide)
        throw new Error('Configured SDK client has no decision capability');
      return client.decide(
        request as DecisionRequest,
        options as DecisionOptions | undefined,
      );
    },
  };
}
