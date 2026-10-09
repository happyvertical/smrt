import Ajv from 'ajv';
import { intakeBindingDigest } from './execution.js';
import type { IntakeValues } from './execution-dto.js';
import { proposeDocumentSplits } from './extraction.js';
import type { ExtractionResult } from './extraction-types.js';
import type { GenerationLimits } from './proposal-contracts.js';
import type {
  GeneratedSuggestion,
  GenerationOutput,
  ProposalEvidenceReference,
} from './proposal-dto.js';

export function record(value: unknown): IntakeValues {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid proposal object');
  return value as IntakeValues;
}
export function text(value: unknown, max = 512): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Invalid proposal string');
  return value;
}
export function safeUsage(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, number> = {};
  for (const key of [
    'promptTokens',
    'completionTokens',
    'totalTokens',
    'inputTokens',
    'outputTokens',
  ]) {
    const count = (value as IntakeValues)[key];
    if (typeof count === 'number' && Number.isSafeInteger(count) && count >= 0)
      result[key] = count;
  }
  return result;
}
const locationSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind'],
      properties: { kind: { const: 'source' } },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'page'],
      properties: {
        kind: { const: 'page' },
        page: { type: 'integer', minimum: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'startPage', 'endPage'],
      properties: {
        kind: { const: 'pages' },
        startPage: { type: 'integer', minimum: 1 },
        endPage: { type: 'integer', minimum: 1 },
      },
    },
    {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'startMs', 'endMs'],
      properties: {
        kind: { const: 'time' },
        startMs: { type: 'number', minimum: 0 },
        endMs: { type: 'number', minimum: 0 },
      },
    },
  ],
};
export function suggestionSchema(limits: GenerationLimits) {
  const string = { type: 'string', minLength: 1, maxLength: 512 };
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
        maxItems: limits.maxSuggestions,
        items: {
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
            handlerId: string,
            handlerVersion: string,
            args: { type: 'object' },
            evidence: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['evidenceId', 'location'],
                properties: { evidenceId: string, location: locationSchema },
              },
            },
            alternatives: {
              type: 'array',
              uniqueItems: true,
              maxItems: 20,
              items: string,
            },
            missingFields: {
              type: 'array',
              uniqueItems: true,
              maxItems: 30,
              items: string,
            },
            explanation: { type: 'string', maxLength: 2000 },
          },
        },
      },
      splits: {
        type: 'array',
        maxItems: limits.maxSuggestions,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['evidenceId', 'groups'],
          properties: {
            evidenceId: string,
            groups: {
              type: 'array',
              minItems: 1,
              maxItems: 100,
              items: {
                type: 'array',
                minItems: 1,
                maxItems: 1000,
                items: { type: 'integer', minimum: 1 },
              },
            },
          },
        },
      },
    },
  };
}
export function validateSuggestions(
  raw: unknown,
  offered: GenerationOutput['offered'],
  extraction: ExtractionResult[],
  limits: GenerationLimits,
  revision: number,
): Pick<GenerationOutput, 'outcome' | 'suggestions' | 'splits'> {
  const ajv = new Ajv({
    strict: true,
    allErrors: true,
    validateFormats: false,
  });
  if (!ajv.validate(suggestionSchema(limits), raw))
    throw new Error('Invalid generated proposals');
  const input = raw as {
    outcome: GenerationOutput['outcome'];
    suggestions: Omit<GeneratedSuggestion, 'disposition'>[];
    splits: Array<{ evidenceId: string; groups: number[][] }>;
  };
  if (
    (input.outcome === 'proposals' && !input.suggestions.length) ||
    (['unknown', 'no_action'].includes(input.outcome) &&
      input.suggestions.length)
  )
    throw new Error('Inconsistent proposal outcome');
  const offeredKeys = new Set(
    offered.flatMap(({ handler, candidates }) => [
      `${handler.id}@${handler.version}`,
      ...candidates.map((candidate) => candidate.key),
    ]),
  );
  const suggestions = input.suggestions.map(
    (suggestion): GeneratedSuggestion => {
      const entry = offered.find(
        ({ handler }) =>
          handler.id === suggestion.handlerId &&
          handler.version === suggestion.handlerVersion,
      );
      if (
        !entry ||
        suggestion.alternatives.some((key) => !offeredKeys.has(key))
      )
        throw new Error('Unoffered handler');
      const schema = ajv.compile(entry.handler.argsSchema);
      const valid = schema(suggestion.args);
      const missing = (schema.errors ?? [])
        .filter(
          (error) => error.keyword === 'required' && error.instancePath === '',
        )
        .map((error) => String(error.params.missingProperty))
        .sort();
      if (
        (!valid &&
          schema.errors?.some(
            (error) =>
              error.keyword !== 'required' || error.instancePath !== '',
          )) ||
        JSON.stringify([...suggestion.missingFields].sort()) !==
          JSON.stringify(missing)
      )
        throw new Error('Invalid handler arguments');
      for (const [field, reference] of Object.entries(
        entry.handler.references,
      )) {
        if (!Object.hasOwn(suggestion.args, field)) continue;
        const value = suggestion.args[field];
        if (reference.kind === 'candidate') {
          if (
            !entry.candidates.some(
              (candidate) =>
                candidate.model === reference.model && candidate.id === value,
            )
          )
            throw new Error('Unoffered target');
        } else if (!extraction.some((result) => result.evidence.id === value))
          throw new Error('Unknown evidence');
      }
      for (const reference of suggestion.evidence)
        assertEvidenceReference(reference, extraction);
      return {
        ...structuredClone(suggestion),
        disposition:
          missing.length || input.outcome !== 'proposals'
            ? 'needs_review'
            : 'ready_for_review',
      };
    },
  );
  const seen = new Set<string>();
  const splits = input.splits.map((split) => {
    const source = extraction.find(
      (entry) => entry.evidence.id === split.evidenceId,
    );
    if (!source || seen.has(split.evidenceId))
      throw new Error('Invalid split source');
    seen.add(split.evidenceId);
    const result = proposeDocumentSplits(source, revision, split.groups);
    return {
      evidenceId: split.evidenceId,
      groups: structuredClone(split.groups),
      digest: result.digest,
    };
  });
  return { outcome: input.outcome, suggestions, splits };
}
function assertEvidenceReference(
  reference: ProposalEvidenceReference,
  extraction: ExtractionResult[],
) {
  const source = extraction.find(
    (entry) => entry.evidence.id === reference.evidenceId,
  );
  // Only observed source granularity is referenceable; invented page/time spans are rejected.
  if (
    !source?.segments.some(
      (segment) =>
        intakeBindingDigest(segment.location) ===
        intakeBindingDigest(reference.location),
    )
  )
    throw new Error('Unknown evidence location');
}
