import type {
  AIInterface,
  DecisionOptions,
  DecisionRequest,
} from '@happyvertical/ai';
import type { DecisionClient } from '@happyvertical/smrt-core';
import { type ProviderIdentity, providerIdentity } from './extraction-types.js';
import type {
  GenerativeProposalInput,
  ProposalGenerator,
} from './proposal-contracts.js';
import { safeUsage } from './proposal-validation.js';

function escapesRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** OpenAI reports dated revisions for configured stable aliases. */
function acceptsResponseModel(
  identity: ProviderIdentity,
  model?: string,
): boolean {
  if (!model || model === identity.model) return true;
  return (
    identity.provider === 'openai' &&
    new RegExp(`^${escapesRegExp(identity.model)}-\\d{4}-\\d{2}-\\d{2}$`).test(
      model,
    )
  );
}

const string = { type: 'string', minLength: 1, maxLength: 512 };

/**
 * The provider receives the same catalog as the validator, but JSON mode alone
 * does not distinguish an opaque candidate key from the record id an operation
 * accepts. Give providers a closed response schema as well as the catalog.
 * Validation remains the authority because non-grammar providers may ignore it.
 */
export function proposalResponseSchema(input: GenerativeProposalInput) {
  const alternativeKeys = [
    ...new Set(
      input.offered.flatMap(({ handler, candidates }) => [
        `${handler.id}@${handler.version}`,
        ...candidates.map((candidate) => candidate.key),
      ]),
    ),
  ];
  const evidenceIds = [
    ...new Set(input.evidence.map(({ evidenceId }) => evidenceId)),
  ];
  const evidenceLocations = [
    ...new Map(
      input.evidence
        .flatMap(({ segments }) => segments.map(({ location }) => location))
        .map((location) => [
          JSON.stringify(location),
          structuredClone(location),
        ]),
    ).values(),
  ];
  const suggestionVariants = input.offered.map(({ handler, candidates }) => {
    const args = structuredClone(handler.argsSchema) as Record<string, unknown>;
    if (!args.properties) args.properties = {};
    const properties = args.properties as Record<string, unknown>;
    // Missing required fields are intentionally represented by missingFields.
    // Keep each offered handler's other closed-schema constraints intact.
    delete args.required;
    for (const [field, reference] of Object.entries(handler.references)) {
      if (reference.kind !== 'candidate') continue;
      const ids = [
        ...new Set(
          candidates
            .filter((candidate) => candidate.model === reference.model)
            .map((candidate) => candidate.id),
        ),
      ];
      const property = properties[field];
      if (!property) continue;
      if (ids.length)
        properties[field] = {
          ...(property as Record<string, unknown>),
          enum: ids,
        };
      else properties[field] = false;
    }
    return {
      type: 'object',
      additionalProperties: false,
      required: [
        'handlerId',
        'handlerVersion',
        'args',
        'evidence',
        'alternatives',
        'missingFields',
        'explanation',
      ],
      properties: {
        handlerId: { const: handler.id },
        handlerVersion: { const: handler.version },
        args,
        evidence: {
          type: 'array',
          minItems: 1,
          maxItems: 100,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['evidenceId', 'location'],
            properties: {
              evidenceId: { enum: evidenceIds },
              location: { enum: evidenceLocations },
            },
          },
        },
        alternatives: alternativeKeys.length
          ? {
              type: 'array',
              uniqueItems: true,
              maxItems: 20,
              items: { enum: alternativeKeys },
            }
          : { type: 'array', maxItems: 0 },
        missingFields: {
          type: 'array',
          uniqueItems: true,
          maxItems: 30,
          items: string,
        },
        explanation: { type: 'string', maxLength: 2000 },
      },
    };
  });
  return {
    type: 'object',
    additionalProperties: false,
    required: ['outcome', 'suggestions', 'splits'],
    properties: {
      outcome: {
        enum: [
          'proposals',
          'unknown',
          'ambiguous',
          'no_action',
          'needs_review',
        ],
      },
      suggestions: {
        type: 'array',
        items: suggestionVariants.length
          ? { oneOf: suggestionVariants }
          : false,
      },
      splits: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['evidenceId', 'groups'],
          properties: {
            evidenceId: { enum: evidenceIds },
            groups: {
              type: 'array',
              items: { type: 'array', items: { type: 'integer', minimum: 1 } },
            },
          },
        },
      },
    },
  };
}

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
      const responseSchema = proposalResponseSchema(input);
      const response = await client.chat(
        [
          { role: 'system', content: input.instructions },
          {
            role: 'user',
            content: JSON.stringify({
              evidence: input.evidence,
              offered: input.offered,
              ...(input.examples ? { examples: input.examples } : {}),
            }),
          },
        ],
        {
          model: identity.model,
          maxTokens: limits.maxTokens,
          timeout: limits.timeoutMs,
          signal: options.signal,
          toolChoice: 'none',
          responseFormat: {
            type: 'json_schema',
            json_schema: {
              name: 'ingestion_proposal',
              description:
                'A bounded proposal over the supplied handler catalog.',
              schema: responseSchema,
              // Handler arguments can omit required values only when they are
              // named in missingFields, which OpenAI strict schemas cannot model.
              strict: false,
            },
          },
          responseSchema,
          continueOnLength: false,
        },
      );
      if (
        response.finishReason !== 'stop' ||
        response.truncated ||
        response.toolCalls?.length ||
        !acceptsResponseModel(identity, response.model)
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
        ...(response.model && response.model !== identity.model
          ? { responseModel: response.model }
          : {}),
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
