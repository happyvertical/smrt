import Ajv, { type ErrorObject } from 'ajv';
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

/** Longest persisted reason; the rest is cut so the publication envelope stays bounded. */
export const PROPOSAL_REASON_LIMIT = 1000;
/**
 * Validator failure with a bounded, value-free reason. The reason names JSON
 * paths, schema keywords and schema constants only: never document text,
 * argument values or evidence content.
 */
export class ProposalValidationError extends Error {
  readonly reason: string;
  constructor(message: string, detail?: string) {
    super(message);
    this.reason = (detail ? `${message}: ${detail}` : message).slice(
      0,
      PROPOSAL_REASON_LIMIT,
    );
  }
}
type SchemaNode = Record<string, unknown>;
/** Every object node an instance at this position may be validated against. */
function schemaNodes(node: unknown): SchemaNode[] {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return [];
  const current = node as SchemaNode;
  const nested = ['oneOf', 'anyOf', 'allOf'].flatMap((keyword) =>
    Array.isArray(current[keyword])
      ? (current[keyword] as unknown[]).flatMap(schemaNodes)
      : [],
  );
  return [current, ...nested];
}
/**
 * Keep only path segments the schema itself names: indexes into an actual
 * array in the instance, and keys declared under `properties`. Anything else
 * (keys under `additionalProperties`/`patternProperties`, numeric keys of an
 * object, or an unknown key) is data and becomes `?`.
 */
export function schemaOwnedPath(
  instancePath: string,
  schema: unknown,
  instance?: unknown,
): string {
  if (!instancePath) return '/';
  let nodes = schemaNodes(schema);
  let value: unknown = instance;
  const segments = instancePath.split('/').slice(1);
  const kept: string[] = [];
  for (const raw of segments) {
    const segment = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    // An index is schema-owned only when the parent value really is an array;
    // the schema alone cannot tell an index from a numeric data key when a
    // union allows both shapes.
    if (/^\d+$/.test(segment) && Array.isArray(value)) {
      kept.push(segment);
      value = value[Number(segment)];
      nodes = nodes.flatMap((node) =>
        node.type === 'array' || node.items !== undefined
          ? schemaNodes(node.items)
          : [],
      );
      continue;
    }
    value =
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)[segment]
        : undefined;
    const owners = nodes.filter((node) => {
      const properties = node.properties;
      return (
        !!properties &&
        typeof properties === 'object' &&
        Object.hasOwn(properties as object, segment)
      );
    });
    if (owners.length) {
      kept.push(segment);
      nodes = owners.flatMap((node) =>
        schemaNodes((node.properties as SchemaNode)[segment]),
      );
    } else {
      kept.push('?');
      nodes = nodes.flatMap((node) =>
        typeof node.additionalProperties === 'object'
          ? schemaNodes(node.additionalProperties)
          : [],
      );
    }
  }
  return `/${kept.join('/')}`;
}
/**
 * Summarize Ajv errors by schema-owned path, keyword and schema-owned params.
 * Data never appears: an extra property's name is model output and is omitted.
 */
/** Ajv errors examined per summary, duplicates included. */
export const PROPOSAL_REASON_MAX_ERRORS = 200;
/** Longest single path rendered; deeper paths keep their prefix. */
const PATH_LIMIT = 160;
export function describeSchemaErrors(
  errors: ErrorObject[] | null | undefined,
  schema: unknown,
  instance?: unknown,
  limit = 20,
  maxChars = PROPOSAL_REASON_LIMIT - 100,
): string {
  // Bounded work: a huge or deeply recursive reply can carry hundreds of
  // thousands of (often identical) errors, so examine at most a fixed number
  // of errors in total, walk each distinct instance path once, and stop as
  // soon as enough distinct parts are collected.
  const parts = new Set<string>();
  const paths = new Map<string, string>();
  const all = errors ?? [];
  let consumed = 0;
  while (
    consumed < all.length &&
    consumed < PROPOSAL_REASON_MAX_ERRORS &&
    parts.size < limit
  ) {
    const error = all[consumed++];
    const params = error.params as Record<string, unknown>;
    const detail: string[] = [];
    if (typeof params.missingProperty === 'string')
      detail.push(`missingProperty=${params.missingProperty}`);
    if (Array.isArray(params.allowedValues))
      detail.push(
        `allowedValues=${params.allowedValues.map(String).join('|')}`,
      );
    if (params.allowedValue !== undefined)
      detail.push(`allowedValue=${String(params.allowedValue)}`);
    if (typeof params.type === 'string') detail.push(`type=${params.type}`);
    if (typeof params.limit === 'number' || typeof params.limit === 'string')
      detail.push(`limit=${String(params.limit)}`);
    if (typeof params.passingSchemas !== 'undefined')
      detail.push('oneOf=none|multiple');
    let path = paths.get(error.instancePath);
    if (path === undefined) {
      path = schemaOwnedPath(error.instancePath, schema, instance);
      if (path.length > PATH_LIMIT) path = `${path.slice(0, PATH_LIMIT)}…`;
      paths.set(error.instancePath, path);
    }
    parts.add(
      `${path} ${error.keyword}${detail.length ? ` (${detail.join(', ')})` : ''}`,
    );
  }
  const shown: string[] = [];
  let length = 0;
  for (const part of parts) {
    if (length + part.length + 2 > maxChars) break;
    shown.push(part);
    length += part.length + 2;
  }
  const omitted = parts.size - shown.length + (all.length - consumed);
  if (omitted > 0) shown.push(`+${omitted} more`);
  return shown.join('; ');
}
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
  const shape = suggestionSchema(limits);
  if (!ajv.validate(shape, raw))
    throw new ProposalValidationError(
      'Invalid generated proposals',
      describeSchemaErrors(ajv.errors, shape, raw),
    );
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
    throw new ProposalValidationError(
      'Inconsistent proposal outcome',
      `outcome=${input.outcome}, suggestions=${input.suggestions.length}`,
    );
  const offeredKeys = new Set(
    offered.flatMap(({ handler, candidates }) => [
      `${handler.id}@${handler.version}`,
      ...candidates.map((candidate) => candidate.key),
    ]),
  );
  const suggestions = input.suggestions.map(
    (suggestion, index): GeneratedSuggestion => {
      const path = `/suggestions/${index}`;
      const entry = offered.find(
        ({ handler }) =>
          handler.id === suggestion.handlerId &&
          handler.version === suggestion.handlerVersion,
      );
      if (
        !entry ||
        suggestion.alternatives.some((key) => !offeredKeys.has(key))
      )
        throw new ProposalValidationError('Unoffered handler', path);
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
        throw new ProposalValidationError(
          'Invalid handler arguments',
          `${path}/args ${describeSchemaErrors(schema.errors, entry.handler.argsSchema, suggestion.args) || 'missingFields do not match the schema'}`,
        );
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
            throw new ProposalValidationError(
              'Unoffered target',
              `${path}/args/${field}`,
            );
        } else if (!extraction.some((result) => result.evidence.id === value))
          throw new ProposalValidationError(
            'Unknown evidence',
            `${path}/args/${field}`,
          );
      }
      for (const [position, reference] of suggestion.evidence.entries())
        assertEvidenceReference(
          reference,
          extraction,
          `${path}/evidence/${position}`,
        );
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
  const splits = input.splits.map((split, index) => {
    const source = extraction.find(
      (entry) => entry.evidence.id === split.evidenceId,
    );
    if (!source || seen.has(split.evidenceId))
      throw new ProposalValidationError(
        'Invalid split source',
        `/splits/${index}`,
      );
    seen.add(split.evidenceId);
    let result: ReturnType<typeof proposeDocumentSplits>;
    try {
      result = proposeDocumentSplits(source, revision, split.groups);
    } catch {
      throw new ProposalValidationError(
        'Invalid split groups',
        `/splits/${index}/groups`,
      );
    }
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
  path: string,
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
    throw new ProposalValidationError('Unknown evidence location', path);
}
