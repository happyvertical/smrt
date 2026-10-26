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
import {
  attachRawProviderOutput,
  ProposalResponseError,
  type ProposalResponseProblem,
} from './provider-failure.js';

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
 * JSON Schema keywords removed from the provider-facing response schema
 * (#4260), because common OpenAI-compatible structured-output backends reject
 * them and fail the whole request:
 * - `uniqueItems`, `contains`, `minContains`, `maxContains`: vLLM's xgrammar
 *   feature check (`has_xgrammar_unsupported_json_features`) flags them on
 *   arrays, so vLLM's auto mode routes the request to llguidance, which
 *   answers `400 Grammar error: Unimplemented keys: ["uniqueItems"]` (#4260).
 * - `multipleOf`, `minProperties`, `maxProperties`, `propertyNames`,
 *   `patternProperties`, `format`: also flagged by that feature check
 *   (`format` additionally has only partial support in llama.cpp's
 *   json-schema-to-grammar, used by Ollama).
 * - `not`, `if`/`then`/`else`, `dependentRequired`, `dependentSchemas`,
 *   `dependencies`, `unevaluatedItems`, `unevaluatedProperties`: implemented
 *   by neither xgrammar nor llama.cpp's grammar converter.
 * - `default`, `examples`, `contentSchema`: annotations, not constraints, but
 *   backend feature checks walk their values, including nested schemas/data.
 * Kept, because those backends implement them: `type`, `enum`, `const`,
 * `anyOf`/`allOf` (`oneOf` is weakened below), `items`/`prefixItems`,
 * `minItems`/`maxItems`,
 * `minLength`/`maxLength`, `pattern`, numeric ranges, `required`,
 * `additionalProperties`, `$defs`. Reference constraints are dropped below.
 * OpenAI's own non-strict mode
 * (`strict: false` below) accepts any of them.
 *
 * Dropping a keyword only loosens the grammar: the Ajv validator
 * (`suggestionSchema` and each handler's original `argsSchema` in
 * proposal-validation.ts) still enforces the constraints, including
 * uniqueness of `alternatives` and `missingFields`. The exception is
 * `format`: Ajv runs with `validateFormats: false`, so `format` is advisory
 * and enforced nowhere.
 */
export const UNPORTABLE_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  'uniqueItems',
  'contains',
  'minContains',
  'maxContains',
  'multipleOf',
  'minProperties',
  'maxProperties',
  'propertyNames',
  'patternProperties',
  'format',
  'not',
  'if',
  'then',
  'else',
  'dependentRequired',
  'dependentSchemas',
  'dependencies',
  'unevaluatedItems',
  'unevaluatedProperties',
  'default',
  'examples',
  'contentSchema',
]);
/** Backends may inspect typed keyword objects even inside enum/const data. */
function hasProviderVisibleConstraint(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasProviderVisibleConstraint);
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  // Conservatively remove a containing data constraint, never rewrite its
  // literal value. Harmless property names without a schema type stay data.
  if (
    typeof object.type === 'string' &&
    Object.keys(object).some((key) => UNPORTABLE_SCHEMA_KEYWORDS.has(key))
  )
    return true;
  return Object.values(object).some(hasProviderVisibleConstraint);
}

/** Keywords whose value is a map from names to subschemas. */
const SCHEMA_MAP_KEYWORDS = new Set(['properties', '$defs', 'definitions']);
/** Keywords whose value is a list of subschemas. */
const SCHEMA_LIST_KEYWORDS = new Set([
  'anyOf',
  'oneOf',
  'allOf',
  'prefixItems',
]);
/** Keywords whose value is one subschema (or, for `items`, possibly a list). */
const SCHEMA_SINGLE_KEYWORDS = new Set([
  'items',
  'additionalItems',
  'additionalProperties',
]);

/**
 * Copy a response schema without {@link UNPORTABLE_SCHEMA_KEYWORDS}, walking
 * only schema positions. Property names (a handler argument may be called
 * `format`) and required lists stay data. Kept enum/const values are copied
 * unchanged; a containing enum/const constraint is omitted when its typed
 * data would trigger a backend's recursive unsupported-feature check.
 *
 * Invariant: the provider copy only ever accepts a superset of what the
 * original accepts. Every removed keyword is a conjunct whose removal widens
 * (`not`, `if`/`then`/`else`, `contains`, `dependent*`, `propertyNames`,
 * `multipleOf`, `unevaluated*`, ...), and the two places where removal
 * would narrow are rewritten: `oneOf` becomes `anyOf`, and an object that
 * loses `patternProperties` also loses `additionalProperties`. `enum`/`const`
 * with a removed sibling stay a superset, as the sibling was another
 * conjunct. Omitting a whole enum/const constraint also widens. The validator
 * still checks the original.
 */
export function portableResponseSchema<T>(schema: T): T {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    return structuredClone(schema);
  const portable: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(
    schema as Record<string, unknown>,
  )) {
    // Rewriting/removing subschemas can invalidate JSON Pointer and anchor
    // targets, including targets under nested $id resources. Dropping the
    // provider-only reference constraint avoids dangling or misbound targets
    // without dereferencing untrusted schemas. The original Ajv schema remains
    // authoritative, including recursive and dynamically scoped references.
    if (key === '$ref' || key === '$dynamicRef' || key === '$recursiveRef')
      continue;
    if (UNPORTABLE_SCHEMA_KEYWORDS.has(key)) continue;
    if (
      (key === 'enum' || key === 'const') &&
      hasProviderVisibleConstraint(value)
    )
      continue;
    if (
      SCHEMA_MAP_KEYWORDS.has(key) &&
      value &&
      typeof value === 'object' &&
      !Array.isArray(value)
    )
      portable[key] = Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(
          ([name, subschema]) => [name, portableResponseSchema(subschema)],
        ),
      );
    else if (SCHEMA_LIST_KEYWORDS.has(key) && Array.isArray(value))
      portable[key] = value.map((subschema) =>
        portableResponseSchema(subschema),
      );
    else if (SCHEMA_SINGLE_KEYWORDS.has(key))
      portable[key] = Array.isArray(value)
        ? value.map((subschema) => portableResponseSchema(subschema))
        : portableResponseSchema(value);
    else portable[key] = structuredClone(value);
  }
  // `oneOf` means "exactly one branch matches". Loosening its branches can
  // make a value match two, so an originally valid value would be rejected
  // (#4261 review: `oneOf` of `multipleOf: 2` / `multipleOf: 3` integers
  // rejects `2` once both become `{type: 'integer'}`). Every `oneOf` becomes
  // `anyOf`, which only ever loosens; the validator keeps the original
  // `oneOf`, so exclusivity is still enforced after decoding. If the object
  // already has an `anyOf`, the rewritten branches go into `allOf`.
  if (Array.isArray(portable.oneOf)) {
    const branches = portable.oneOf;
    delete portable.oneOf;
    if (portable.anyOf === undefined) portable.anyOf = branches;
    else
      portable.allOf = [
        ...(Array.isArray(portable.allOf) ? portable.allOf : []),
        { anyOf: branches },
      ];
  }
  // Removing `patternProperties` would narrow the grammar: keys it allowed
  // would then fall to `additionalProperties`, so with `false` the model could
  // only emit declared properties (or `{}`). Drop `additionalProperties` too;
  // the validator still enforces the handler's real rule. (Removing
  // `propertyNames` or `dependentRequired` only ever widens what is accepted,
  // so it needs no such adjustment.)
  if (
    'patternProperties' in (schema as Record<string, unknown>) &&
    'additionalProperties' in portable
  )
    delete portable.additionalProperties;
  return portable as T;
}

function locationSchema(location: unknown): Record<string, unknown> {
  const value = location as Record<string, unknown>;
  switch (value.kind) {
    case 'source':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['kind'],
        properties: { kind: { type: 'string', enum: ['source'] } },
      };
    case 'page':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'page'],
        properties: {
          kind: { type: 'string', enum: ['page'] },
          page: { type: 'integer', enum: [value.page] },
        },
      };
    case 'pages':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'startPage', 'endPage'],
        properties: {
          kind: { type: 'string', enum: ['pages'] },
          startPage: { type: 'integer', enum: [value.startPage] },
          endPage: { type: 'integer', enum: [value.endPage] },
        },
      };
    case 'time':
      return {
        type: 'object',
        additionalProperties: false,
        required: ['kind', 'startMs', 'endMs'],
        properties: {
          kind: { type: 'string', enum: ['time'] },
          startMs: { type: 'number', enum: [value.startMs] },
          endMs: { type: 'number', enum: [value.endMs] },
        },
      };
    default:
      throw new Error('Unsupported evidence location');
  }
}

/**
 * The provider receives the same catalog as the validator, but JSON mode alone
 * does not distinguish an opaque candidate key from the record id an operation
 * accepts. Give providers a closed response schema as well as the catalog.
 * Validation remains the authority because non-grammar providers may ignore it,
 * and the schema is made portable (see {@link portableResponseSchema}) so a
 * grammar backend that lacks a keyword does not reject the request (#4260).
 */
export function proposalResponseSchema(input: GenerativeProposalInput) {
  return portableResponseSchema(closedResponseSchema(input));
}

function closedResponseSchema(input: GenerativeProposalInput) {
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
          locationSchema(location),
        ]),
    ).values(),
  ];
  const splitVariants = input.evidence.flatMap(({ evidenceId, segments }) => {
    const pages = [
      ...new Set(
        segments.flatMap(({ location }) =>
          location.kind === 'page' ? [location.page] : [],
        ),
      ),
    ];
    return pages.length
      ? [
          {
            type: 'object',
            additionalProperties: false,
            required: ['evidenceId', 'groups'],
            properties: {
              evidenceId: { type: 'string', enum: [evidenceId] },
              groups: {
                type: 'array',
                minItems: 1,
                items: {
                  type: 'array',
                  minItems: 1,
                  items: { type: 'integer', enum: pages },
                },
              },
            },
          },
        ]
      : [];
  });
  const suggestionVariants = input.offered.map(({ handler, candidates }) => {
    // Alternatives are competing choices, never this variant's selected handler.
    const competingKeys = alternativeKeys.filter(
      (key) => key !== `${handler.id}@${handler.version}`,
    );
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
      // An empty candidate page cannot offer a valid value. Keep the original
      // schema so the model sees the field, while the prompt and validator fail
      // closed if it attempts to supply one.
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
        handlerId: { type: 'string', enum: [handler.id] },
        handlerVersion: { type: 'string', enum: [handler.version] },
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
              evidenceId: { type: 'string', enum: evidenceIds },
              location: { anyOf: evidenceLocations },
            },
          },
        },
        alternatives: competingKeys.length
          ? {
              type: 'array',
              // Not portable; dropped for providers, enforced by the validator.
              uniqueItems: true,
              maxItems: 20,
              items: { type: 'string', enum: competingKeys },
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
        type: 'string',
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
        ...(suggestionVariants.length
          ? { items: { anyOf: suggestionVariants } }
          : { maxItems: 0 }),
      },
      splits: {
        type: 'array',
        ...(splitVariants.length
          ? { items: { anyOf: splitVariants } }
          : { maxItems: 0 }),
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
      // Each refusal names a fixed problem so the recorded reason is not a
      // bare "provider call failed" (#4285). The raw reply travels beside the
      // error, off the object, for the opt-in failed-attempt capture only.
      const refusal = (
        problem: ProposalResponseProblem,
        message: string,
        finishReason?: unknown,
      ) =>
        attachRawProviderOutput(
          new ProposalResponseError(problem, message, finishReason),
          response.content,
        );
      const incomplete = 'Incomplete or unexpected proposal response';
      if (response.finishReason !== 'stop')
        throw refusal('finish_reason', incomplete, response.finishReason);
      if (response.truncated) throw refusal('truncated', incomplete);
      if (response.toolCalls?.length) throw refusal('tool_calls', incomplete);
      if (!acceptsResponseModel(identity, response.model))
        throw refusal('unexpected_model', incomplete);
      if (typeof response.content !== 'string')
        throw refusal('no_text_content', 'Proposal output limit');
      if (Buffer.byteLength(response.content) > options.maxOutputBytes)
        throw refusal('output_limit', 'Proposal output limit');
      if (!response.content.trim())
        throw refusal('empty_content', 'Proposal response was empty');
      let output: unknown;
      try {
        output = JSON.parse(response.content);
      } catch {
        throw refusal('invalid_json', 'Proposal response was not valid JSON');
      }
      return {
        output,
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
