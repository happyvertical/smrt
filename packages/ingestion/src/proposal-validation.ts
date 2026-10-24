import Ajv, { type ErrorObject } from 'ajv';
import { schemaOwnedPath } from './argument-issues.js';
import { intakeBindingDigest } from './execution.js';
import type { IntakeValues } from './execution-dto.js';
import { proposeDocumentSplits, SplitGroupError } from './extraction.js';
import type { ExtractionResult } from './extraction-types.js';
import type { GenerationLimits } from './proposal-contracts.js';
import type {
  GeneratedSuggestion,
  GenerationOutput,
  MissingFieldsCorrection,
  ProposalEvidenceReference,
  UnofferedTargetsDropped,
} from './proposal-dto.js';

export { schemaOwnedPath } from './argument-issues.js';

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
/** Most missing required arguments one suggestion may carry (#4284); the reply schema's `missingFields` cap. */
export const PROPOSAL_MISSING_FIELDS_LIMIT = 30;
/** Longest missing-field name or path kept; the reply schema's string cap. */
const MISSING_FIELD_LENGTH = 512;
/**
 * The missing required arguments when the handler schema refused *only* on
 * `required` (#4284). A miss at the argument root is the bare property name,
 * as the existing `missingFields` contract has it; a miss inside a present
 * nested object or array item is an RFC 6901 JSON Pointer relative to the
 * arguments (`/vendor/name`, `/lines/0/sku`). Returns `undefined`, so the
 * caller rejects as before, when any other keyword failed (type, enum,
 * bounds, additionalProperties, anyOf/oneOf, if/then/else, not, array-form
 * dependencies — which also carries `missingProperty`...), when a
 * path crosses a segment the schema does not own (a model-chosen key), or
 * when the work or result exceeds its bound. Every name comes from the
 * handler schema's own `required` list; argument values are never read.
 */
export function missingRequiredFields(
  errors: ErrorObject[] | null | undefined,
  schema: unknown,
  instance: unknown,
): string[] | undefined {
  const all = errors ?? [];
  if (!all.length || all.length > PROPOSAL_REASON_MAX_ERRORS) return undefined;
  const missing = new Set<string>();
  for (const error of all) {
    const property = (error.params as Record<string, unknown>).missingProperty;
    if (error.keyword !== 'required' || typeof property !== 'string')
      return undefined;
    let field = property;
    if (error.instancePath) {
      if (
        schemaOwnedPath(error.instancePath, schema, instance)
          .split('/')
          .includes('?')
      )
        return undefined;
      field = `${error.instancePath}/${property.replace(/~/g, '~0').replace(/\//g, '~1')}`;
    }
    if (!field || field.length > MISSING_FIELD_LENGTH) return undefined;
    missing.add(field);
    if (missing.size > PROPOSAL_MISSING_FIELDS_LIMIT) return undefined;
  }
  return [...missing];
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
/**
 * Drop repeated `alternatives` and `missingFields` entries (by canonical JSON,
 * keeping the first) from fresh generator output before validation (#4286).
 * The provider grammar no longer carries `uniqueItems` (#4260), so a model can
 * repeat an entry; the validator still enforces `uniqueItems` on the result.
 * Only these two suggestion-level lists are touched; anything malformed or
 * non-JSON is left for the validator to reject. The input is not mutated.
 */
export function dedupeGeneratedLists(raw: unknown): {
  output: unknown;
  removed: number;
} {
  const suggestions = (raw as { suggestions?: unknown } | null)?.suggestions;
  if (!raw || typeof raw !== 'object' || !Array.isArray(suggestions))
    return { output: raw, removed: 0 };
  let removed = 0;
  const unique = (list: unknown[]) => {
    const seen = new Set<string>();
    const kept = list.filter((item) => {
      let key: string;
      try {
        key = intakeBindingDigest(item);
      } catch {
        return true;
      }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    removed += list.length - kept.length;
    return kept;
  };
  const output = {
    ...raw,
    suggestions: suggestions.map((suggestion: unknown) => {
      if (
        !suggestion ||
        typeof suggestion !== 'object' ||
        Array.isArray(suggestion)
      )
        return suggestion;
      const entry = { ...(suggestion as Record<string, unknown>) };
      for (const field of ['alternatives', 'missingFields'])
        if (Array.isArray(entry[field]))
          entry[field] = unique(entry[field] as unknown[]);
      return entry;
    }),
  };
  return { output, removed };
}
export function validateSuggestions(
  raw: unknown,
  offered: GenerationOutput['offered'],
  extraction: ExtractionResult[],
  limits: GenerationLimits,
  revision: number,
): Pick<GenerationOutput, 'outcome' | 'suggestions' | 'splits'> & {
  missingFieldsCorrection?: MissingFieldsCorrection;
  splitsDropped?: NonNullable<GenerationOutput['provenance']['splitsDropped']>;
  unofferedTargetsDropped?: UnofferedTargetsDropped;
} {
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
  const correction: MissingFieldsCorrection = {
    suggestions: 0,
    added: 0,
    removed: 0,
  };
  const unoffered: UnofferedTargetsDropped = { suggestions: 0, fields: 0 };
  const droppedValues: Array<{ value: string; path: string }> = [];
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
      // Required-only refusals keep the suggestion for a person to complete
      // (#4284); any other refusal still rejects the attempt.
      let missing = valid
        ? []
        : missingRequiredFields(
            schema.errors,
            entry.handler.argsSchema,
            suggestion.args,
          );
      if (!missing)
        throw new ProposalValidationError(
          'Invalid handler arguments',
          `${path}/args ${describeSchemaErrors(schema.errors, entry.handler.argsSchema, suggestion.args)}`,
        );
      // An invented target in a declared candidate field is dropped, never
      // kept, and the field is left for the reviewer to choose (#4289).
      const declaredProperties = (
        entry.handler.argsSchema as { properties?: unknown }
      ).properties;
      const dropped: string[] = [];
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
          ) {
            if (
              typeof value !== 'string' ||
              !declaredProperties ||
              typeof declaredProperties !== 'object' ||
              !Object.hasOwn(declaredProperties, field)
            )
              throw new ProposalValidationError(
                'Unoffered target',
                `${path}/args/${field}`,
              );
            dropped.push(field);
          }
        } else if (!extraction.some((result) => result.evidence.id === value))
          throw new ProposalValidationError(
            'Unknown evidence',
            `${path}/args/${field}`,
          );
      }
      let args = suggestion.args;
      if (dropped.length) {
        args = Object.fromEntries(
          Object.entries(suggestion.args).filter(
            ([field]) => !dropped.includes(field),
          ),
        );
        // The remaining arguments must still fail only on `required`; a drop
        // that exposes any other refusal rejects as it did before.
        missing = schema(args)
          ? []
          : missingRequiredFields(
              schema.errors,
              entry.handler.argsSchema,
              args,
            );
        if (!missing)
          throw new ProposalValidationError(
            'Unoffered target',
            `${path}/args/${dropped[0]}`,
          );
        for (const field of dropped)
          droppedValues.push({
            value: suggestion.args[field] as string,
            path: `${path}/args/${field}`,
          });
        unoffered.suggestions += 1;
        unoffered.fields += dropped.length;
      }
      // The schema, not the model, decides what is missing. A matching
      // declaration keeps the model's order, so output that was already valid
      // is byte-identical; a mismatch is replaced by the sorted computed set
      // and always needs review.
      const declared = suggestion.missingFields;
      const added = missing.filter((field) => !declared.includes(field));
      const removed = declared.filter((field) => !missing.includes(field));
      const corrected = added.length > 0 || removed.length > 0;
      const missingFields = corrected ? [...missing].sort() : [...declared];
      if (corrected) {
        correction.suggestions += 1;
        correction.added += added.length;
        correction.removed += removed.length;
      }
      for (const [position, reference] of suggestion.evidence.entries())
        assertEvidenceReference(
          reference,
          extraction,
          `${path}/evidence/${position}`,
        );
      return {
        ...structuredClone(suggestion),
        args: structuredClone(args),
        missingFields,
        disposition:
          corrected ||
          dropped.length ||
          missingFields.length ||
          input.outcome !== 'proposals'
            ? 'needs_review'
            : 'ready_for_review',
      };
    },
  );
  const seen = new Set<string>();
  let dropped = 0;
  const splits = input.splits.flatMap((split, index) => {
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
    } catch (error) {
      // Drop only a split that fails the group check; suggestions and other
      // splits stand (#4288). An empty group cannot reach here (the schema's
      // minItems rejects it first). Anything else, such as an invalid
      // revision, is not the model's and still fails the attempt.
      if (!(error instanceof SplitGroupError))
        throw new ProposalValidationError('Invalid split', `/splits/${index}`);
      dropped++;
      return [];
    }
    return [
      {
        evidenceId: split.evidenceId,
        groups: structuredClone(split.groups),
        digest: result.digest,
      },
    ];
  });
  // A dropped value echoed anywhere else in the kept output (another
  // argument, an explanation, another suggestion) would survive as a usable
  // copy, so the attempt rejects as it did before #4289.
  if (droppedValues.length) {
    const kept = JSON.stringify({ suggestions, splits });
    const echoed = droppedValues.find(({ value }) =>
      kept.includes(JSON.stringify(value).slice(1, -1)),
    );
    if (echoed)
      throw new ProposalValidationError('Unoffered target', echoed.path);
  }
  return {
    outcome: input.outcome,
    suggestions,
    splits,
    ...(correction.suggestions ? { missingFieldsCorrection: correction } : {}),
    ...(dropped
      ? { splitsDropped: { count: dropped, checks: ['split_groups'] } }
      : {}),
    ...(unoffered.suggestions ? { unofferedTargetsDropped: unoffered } : {}),
  };
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
