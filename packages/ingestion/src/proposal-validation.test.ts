import { describe, expect, it } from 'vitest';
import type { ExtractionResult } from './extraction-types.js';
import type { GenerationLimits } from './proposal-contracts.js';
import type { GenerationOutput } from './proposal-dto.js';
import {
  describeSchemaErrors,
  PROPOSAL_REASON_LIMIT,
  PROPOSAL_REASON_MAX_ERRORS,
  ProposalValidationError,
  schemaOwnedPath,
  validateSuggestions,
} from './proposal-validation.js';

const limits: GenerationLimits = {
  maxHandlers: 5,
  maxCandidates: 5,
  maxSuggestions: 5,
  maxInputBytes: 10000,
  maxOutputBytes: 10000,
  maxQueryLength: 1000,
  timeoutMs: 1000,
};
function failure(
  raw: unknown,
  offered: GenerationOutput['offered'] = [],
): ProposalValidationError {
  try {
    validateSuggestions(raw, offered, [], limits, 1);
  } catch (error) {
    if (error instanceof ProposalValidationError) return error;
    throw error;
  }
  throw new Error('Expected validation to fail');
}

describe('proposal validator reasons', () => {
  it.each([
    { groups: [[1, 1]] },
    { groups: [[9]] },
    { groups: [[2, 1]] },
  ])('reports invalid split groups without echoing generated data ($groups)', ({
    groups,
  }) => {
    const extraction = [
      {
        evidence: { id: 'e', contentHash: 'hash' },
        configurationRevision: 'test',
        segments: [1, 2].map((page) => ({ location: { kind: 'page', page } })),
      },
    ] as ExtractionResult[];
    try {
      validateSuggestions(
        {
          outcome: 'needs_review',
          suggestions: [],
          splits: [{ evidenceId: 'e', groups }],
        },
        [],
        extraction,
        limits,
        1,
      );
      throw new Error('Expected invalid split');
    } catch (error) {
      expect(error).toBeInstanceOf(ProposalValidationError);
      expect((error as ProposalValidationError).reason).toBe(
        'Invalid split groups: /splits/0/groups',
      );
    }
  });

  it('names schema violations by path and keyword without quoting values (#4207)', () => {
    const reply = JSON.parse(
      '{"outcome":"accept","suggestions":[{"handlerId":"h","handlerVersion":"1","args":{},"explanation":"x"}]}',
    );
    const error = failure(reply);
    expect(error.message).toBe('Invalid generated proposals');
    expect(error.reason).toContain(
      '/outcome enum (allowedValues=proposals|unknown|ambiguous|no_action|needs_review)',
    );
    for (const property of ['evidence', 'alternatives', 'missingFields'])
      expect(error.reason).toContain(
        `/suggestions/0 required (missingProperty=${property})`,
      );
    expect(error.reason).toContain('/ required (missingProperty=splits)');
    expect(error.reason).not.toContain('accept');
    expect(error.reason).not.toMatch(/"x"|explanation=|"h"/);
    expect(error.reason.length).toBeLessThanOrEqual(PROPOSAL_REASON_LIMIT);
  });
  it('describes a string location and extra keys without document text', () => {
    const error = failure({
      outcome: 'proposals',
      suggestions: [
        {
          handlerId: 'h',
          handlerVersion: '1',
          args: {},
          evidence: [{ evidenceId: 'e', location: 'page 3 of the invoice' }],
          alternatives: [],
          missingFields: [],
          explanation: 'Vendor ACME invoice 1234',
          'vendor name': 'ACME',
        },
      ],
      splits: [],
    });
    expect(error.reason).toContain('/suggestions/0/evidence/0/location type');
    expect(error.reason).toContain('/suggestions/0 additionalProperties');
    expect(error.reason).not.toMatch(/ACME|invoice|additionalProperty=/);
  });
  it('never echoes an extra property name, even an identifier-like one', () => {
    const error = failure({
      outcome: 'proposals',
      suggestions: [
        {
          handlerId: 'h',
          handlerVersion: '1',
          args: {},
          evidence: [{ evidenceId: 'e', location: { kind: 'source' } }],
          alternatives: [],
          missingFields: [],
          explanation: 'x',
          AcmeCorp: true,
        },
      ],
      splits: [],
    });
    expect(error.reason).toContain('/suggestions/0 additionalProperties');
    expect(error.reason).not.toContain('AcmeCorp');
  });
  it('replaces data keys under open argument sub-schemas with ? (#4207 review)', () => {
    const argsSchema = {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string' },
        lines: { type: 'object', additionalProperties: { type: 'integer' } },
      },
    };
    const error = failure(
      {
        outcome: 'proposals',
        suggestions: [
          {
            handlerId: 'h',
            handlerVersion: '1',
            args: { title: 'x', lines: { 'Invoice 1234': 'twelve' } },
            evidence: [{ evidenceId: 'e', location: { kind: 'source' } }],
            alternatives: [],
            missingFields: [],
            explanation: 'x',
          },
        ],
        splits: [],
      },
      [
        {
          handler: {
            id: 'h',
            version: '1',
            description: 'handler',
            kind: 'operation',
            capability: null,
            argsSchema,
            references: {},
            operation: { model: 'M', action: 'a', version: '1' },
          },
          candidates: [],
        },
      ],
    );
    expect(error.reason).toBe(
      'Invalid handler arguments: /suggestions/0/args /lines/? type (type=integer)',
    );
    expect(error.reason).not.toMatch(/Invoice|1234|twelve/);
    expect(schemaOwnedPath('/lines/Invoice 1234', argsSchema)).toBe('/lines/?');
    expect(schemaOwnedPath('/title', argsSchema)).toBe('/title');
    // Numeric keys are indexes only under an array schema; under an object
    // (or an unknown node) they are data too.
    expect(
      schemaOwnedPath('/lines/4417002231', argsSchema, {
        lines: { '4417002231': 'x' },
      }),
    ).toBe('/lines/?');
    expect(schemaOwnedPath('/Acme/0/x', argsSchema, { Acme: [{ x: 1 }] })).toBe(
      '/?/0/?',
    );
    expect(schemaOwnedPath('/Acme/0/x', argsSchema, { Acme: { '0': 1 } })).toBe(
      '/?/?/?',
    );
    const union = {
      type: 'object',
      properties: {
        items: {
          anyOf: [
            { type: 'array', items: { properties: { sku: {} } } },
            { type: 'object', additionalProperties: { type: 'string' } },
          ],
        },
      },
    };
    expect(
      schemaOwnedPath('/items/3/sku', union, { items: [{}, {}, {}, {}] }),
    ).toBe('/items/3/sku');
    // The same path under the object branch is a numeric data key.
    expect(
      schemaOwnedPath('/items/4417002231', union, {
        items: { '4417002231': 1 },
      }),
    ).toBe('/items/?');
    const numericKeyError = failure(
      {
        outcome: 'proposals',
        suggestions: [
          {
            handlerId: 'h',
            handlerVersion: '1',
            args: { title: 'x', lines: { '4417002231': 'twelve' } },
            evidence: [{ evidenceId: 'e', location: { kind: 'source' } }],
            alternatives: [],
            missingFields: [],
            explanation: 'x',
          },
        ],
        splits: [],
      },
      [
        {
          handler: {
            id: 'h',
            version: '1',
            description: 'handler',
            kind: 'operation',
            capability: null,
            argsSchema,
            references: {},
            operation: { model: 'M', action: 'a', version: '1' },
          },
          candidates: [],
        },
      ],
    );
    expect(numericKeyError.reason).toContain('/lines/? type (type=integer)');
    expect(numericKeyError.reason).not.toContain('4417002231');
  });
  it('bounds the recorded reason', () => {
    const error = failure({
      outcome: 'proposals',
      suggestions: Array.from({ length: 5 }, () => ({ bogus: true })),
      splits: [],
    });
    expect(error.reason).toMatch(/\+\d+ more$/);
    expect(error.reason.length).toBeLessThanOrEqual(PROPOSAL_REASON_LIMIT);
  });
  it('bounds work for repeated deep paths from a recursive schema (#4207 review)', () => {
    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: { child: { $ref: '#' } },
    };
    let instance: Record<string, unknown> = { extra: 'x' };
    for (let depth = 0; depth < 3000; depth++) instance = { child: instance };
    const error = {
      instancePath: `${'/child'.repeat(3000)}`,
      keyword: 'additionalProperties',
      schemaPath: '#/additionalProperties',
      params: { additionalProperty: 'extra' },
      message: 'must NOT have additional properties',
    };
    const errors = new Array(100000).fill(error);
    let walked = 0;
    const tracked = new Proxy(errors, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^\d+$/.test(key)) walked++;
        return Reflect.get(target, key, receiver);
      },
    });
    const started = performance.now();
    const reason = describeSchemaErrors(tracked, schema, instance);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(walked).toBeLessThanOrEqual(PROPOSAL_REASON_MAX_ERRORS);
    // `$ref` is not resolved, so only the first declared key is kept and the
    // rest of the deep path is reported conservatively as `?`.
    expect(reason).toMatch(/^\/child\/\?\/\?\/\?/);
    expect(reason).toContain('… additionalProperties');
    expect(reason).toMatch(/\+\d+ more$/);
    expect(reason).not.toContain('extra');
    expect(reason.length).toBeLessThanOrEqual(PROPOSAL_REASON_LIMIT);
  });
  it('summarizes a very large error list in bounded time', () => {
    const errors = Array.from({ length: 400000 }, (_, index) => ({
      instancePath: `/splits/0/groups/${index}`,
      keyword: 'type',
      schemaPath: '#/x',
      params: { type: 'array' },
      message: 'must be array',
    }));
    const started = performance.now();
    const reason = describeSchemaErrors(
      errors,
      {
        type: 'object',
        properties: {
          splits: {
            type: 'array',
            items: { properties: { groups: { type: 'array', items: {} } } },
          },
        },
      },
      { splits: [{ groups: new Array(400000).fill(1) }] },
    );
    expect(performance.now() - started).toBeLessThan(2000);
    expect(reason).toContain('/splits/0/groups/0 type (type=array)');
    expect(reason).toMatch(/\+399980 more$/);
    expect(reason.length).toBeLessThanOrEqual(PROPOSAL_REASON_LIMIT);
  });
  it('reports internal checks by path only', () => {
    const error = failure({
      outcome: 'proposals',
      suggestions: [
        {
          handlerId: 'h',
          handlerVersion: '1',
          args: { secret: 'document text' },
          evidence: [{ evidenceId: 'e', location: { kind: 'source' } }],
          alternatives: [],
          missingFields: [],
          explanation: 'x',
        },
      ],
      splits: [],
    });
    expect(error.reason).toBe('Unoffered handler: /suggestions/0');
  });
});
