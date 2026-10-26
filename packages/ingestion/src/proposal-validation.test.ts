import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import { intakeBindingDigest } from './execution.js';
import type { ExtractionResult } from './extraction-types.js';
import type { GenerationLimits } from './proposal-contracts.js';
import type { GenerationOutput } from './proposal-dto.js';
import {
  boundGeneratedExplanations,
  dedupeGeneratedLists,
  describeSchemaErrors,
  missingRequiredFields,
  PROPOSAL_EXPLANATION_LIMIT,
  PROPOSAL_MISSING_FIELDS_LIMIT,
  PROPOSAL_REASON_LIMIT,
  PROPOSAL_REASON_MAX_ERRORS,
  ProposalValidationError,
  schemaOwnedPath,
  suggestionSchema,
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
  ])('drops an invalid split, keeps the rest and names only the check ($groups) (#4288)', ({
    groups,
  }) => {
    const pages = (id: string) => ({
      evidence: { id, contentHash: 'hash' },
      configurationRevision: 'test',
      segments: [1, 2].map((page) => ({ location: { kind: 'page', page } })),
    });
    const extraction = [pages('e'), pages('f')] as ExtractionResult[];
    const validate = (splits: unknown[]) =>
      validateSuggestions(
        { outcome: 'needs_review', suggestions: [], splits },
        [],
        extraction,
        limits,
        1,
      );
    const kept = validate([{ evidenceId: 'f', groups: [[1], [2]] }]);
    expect(kept).not.toHaveProperty('splitsDropped');
    const mixed = validate([
      { evidenceId: 'e', groups },
      { evidenceId: 'f', groups: [[1], [2]] },
    ]);
    // The valid split is untouched, digest included.
    expect(mixed.splits).toEqual(kept.splits);
    expect(mixed.splitsDropped).toEqual({ count: 1, checks: ['split_groups'] });
    const none = validate([{ evidenceId: 'e', groups }]);
    expect(none.splits).toEqual([]);
    expect(none.splitsDropped).toEqual({ count: 1, checks: ['split_groups'] });
    expect(JSON.stringify(none)).not.toMatch(/"e"|\[\[/);
  });

  it('still rejects a split for unknown or repeated evidence (#4288)', () => {
    expect(
      failure({
        outcome: 'needs_review',
        suggestions: [],
        splits: [{ evidenceId: 'missing', groups: [[1]] }],
      }).reason,
    ).toBe('Invalid split source: /splits/0');
    const extraction = [
      {
        evidence: { id: 'e', contentHash: 'hash' },
        configurationRevision: 'test',
        segments: [1, 2].map((page) => ({ location: { kind: 'page', page } })),
      },
    ] as ExtractionResult[];
    // The repeat rule holds even when the first split on that evidence was dropped.
    for (const first of [
      [[1], [2]],
      [[1], [1]],
    ])
      expect(() =>
        validateSuggestions(
          {
            outcome: 'needs_review',
            suggestions: [],
            splits: [
              { evidenceId: 'e', groups: first },
              { evidenceId: 'e', groups: [[1, 2]] },
            ],
          },
          [],
          extraction,
          limits,
          1,
        ),
      ).toThrow(
        expect.objectContaining({
          reason: 'Invalid split source: /splits/1',
        }),
      );
  });

  it('lets a non-group split error propagate instead of dropping the split (#4288 review)', () => {
    const extraction = [
      {
        evidence: { id: 'e', contentHash: 'hash' },
        configurationRevision: 'test',
        segments: [{ location: { kind: 'page', page: 1 } }],
      },
    ] as ExtractionResult[];
    expect(() =>
      validateSuggestions(
        {
          outcome: 'needs_review',
          suggestions: [],
          splits: [{ evidenceId: 'e', groups: [[1]] }],
        },
        [],
        extraction,
        limits,
        0,
      ),
    ).toThrow(expect.objectContaining({ reason: 'Invalid split: /splits/0' }));
  });

  it.each([
    'alternatives',
    'missingFields',
  ] as const)('still rejects duplicate %s although providers no longer receive uniqueItems (#4260)', (field) => {
    const suggestion = {
      handlerId: 'h',
      handlerVersion: '1',
      args: {},
      evidence: [{ evidenceId: 'e', location: { kind: 'source' } }],
      alternatives: [] as string[],
      missingFields: [] as string[],
      explanation: '',
      [field]: ['same', 'same'],
    };
    const error = failure({
      outcome: 'proposals',
      suggestions: [suggestion],
      splits: [],
    });
    expect(error.reason).toContain(`/suggestions/0/${field} uniqueItems`);
    expect(error.reason).not.toContain('same');
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

describe('generated list normalization (#4286)', () => {
  const suggestion = (alternatives: unknown[], missingFields: unknown[]) => ({
    handlerId: 'h',
    handlerVersion: '1',
    args: {},
    evidence: [{ evidenceId: 'e', location: { kind: 'source' } }],
    alternatives,
    missingFields,
    explanation: '',
  });

  it('drops repeats keeping the first occurrence and counts them', () => {
    const raw = {
      outcome: 'proposals',
      suggestions: [
        suggestion(['b', 'a', 'b', 'a', 'c'], ['x', 'x']),
        suggestion(['a'], ['y', 'z', 'y']),
      ],
      splits: [],
    };
    const before = structuredClone(raw);
    const { output, removed } = dedupeGeneratedLists(raw);
    expect(removed).toBe(4);
    expect(output).toEqual({
      ...raw,
      suggestions: [
        suggestion(['b', 'a', 'c'], ['x']),
        suggestion(['a'], ['y', 'z']),
      ],
    });
    // The generator's reply is not mutated.
    expect(raw).toEqual(before);
  });

  it('keeps non-identical entries and only exact canonical duplicates go', () => {
    const raw = {
      outcome: 'proposals',
      suggestions: [
        suggestion(
          ['a', 'A', 'a ', { k: 1, j: 2 }, { j: 2, k: 1 }, { j: 2, k: 2 }],
          ['title', 'Title'],
        ),
      ],
      splits: [],
    };
    const { output, removed } = dedupeGeneratedLists(raw);
    expect(removed).toBe(1);
    expect((output as typeof raw).suggestions[0].alternatives).toEqual([
      'a',
      'A',
      'a ',
      { k: 1, j: 2 },
      { j: 2, k: 2 },
    ]);
    expect((output as typeof raw).suggestions[0].missingFields).toEqual([
      'title',
      'Title',
    ]);
  });

  it('leaves only these two lists alone otherwise and passes malformed input through', () => {
    const raw = {
      outcome: 'proposals',
      suggestions: [
        {
          ...suggestion([], []),
          evidence: [
            { evidenceId: 'e', location: { kind: 'source' } },
            { evidenceId: 'e', location: { kind: 'source' } },
          ],
        },
        null,
        ['a', 'a'],
        { alternatives: 'a' },
      ],
      splits: [{ evidenceId: 'e', groups: [[1], [1]] }],
    };
    const { output, removed } = dedupeGeneratedLists(raw);
    expect(removed).toBe(0);
    expect(output).toEqual(raw);
    for (const value of [null, 'x', [], { suggestions: 'x' }])
      expect(dedupeGeneratedLists(value)).toEqual({
        output: value,
        removed: 0,
      });
  });

  it('normalizes deterministically, so the digest is stable', () => {
    const raw = () => ({
      outcome: 'proposals',
      suggestions: [suggestion(['b', 'a', 'b'], ['x', 'x'])],
      splits: [],
    });
    const first = intakeBindingDigest(dedupeGeneratedLists(raw()).output);
    expect(intakeBindingDigest(dedupeGeneratedLists(raw()).output)).toBe(first);
    expect(
      intakeBindingDigest(
        dedupeGeneratedLists(dedupeGeneratedLists(raw()).output).output,
      ),
    ).toBe(first);
    expect(first).toBe(
      intakeBindingDigest({
        outcome: 'proposals',
        suggestions: [suggestion(['b', 'a'], ['x'])],
        splits: [],
      }),
    );
  });

  it('yields output the validator accepts where the raw reply fails uniqueItems', () => {
    const raw = {
      outcome: 'needs_review',
      suggestions: [suggestion([], ['same', 'same'])],
      splits: [],
    };
    expect(failure(raw).reason).toContain(
      '/suggestions/0/missingFields uniqueItems',
    );
    const { output } = dedupeGeneratedLists(raw);
    expect(failure(output).reason).not.toContain('uniqueItems');
  });
});

describe('required-only argument refusals (#4284)', () => {
  const argsSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['vendorId', 'billNumber', 'total', 'vendor'],
    properties: {
      vendorId: { type: 'string' },
      billNumber: { type: 'string' },
      total: { type: 'integer' },
      vendor: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'a/b~c'],
        properties: { name: { type: 'string' }, 'a/b~c': { type: 'string' } },
      },
      lines: {
        type: 'array',
        items: {
          type: 'object',
          required: ['sku'],
          properties: { sku: { type: 'string' } },
        },
      },
      extra: {
        type: 'object',
        additionalProperties: {
          type: 'object',
          required: ['id'],
          properties: { id: { type: 'string' } },
        },
      },
      choice: {
        anyOf: [
          { type: 'object', required: ['x'], properties: { x: {} } },
          { type: 'string' },
        ],
      },
    },
  };
  const offered: GenerationOutput['offered'] = [
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
  ];
  const extraction = [
    {
      evidence: { id: 'e', contentHash: 'hash' },
      configurationRevision: 'test',
      segments: [{ location: { kind: 'source' } }],
    },
  ] as ExtractionResult[];
  const reply = (
    args: Record<string, unknown>,
    missingFields: string[] = [],
  ) => ({
    outcome: 'proposals',
    suggestions: [
      {
        handlerId: 'h',
        handlerVersion: '1',
        args,
        evidence: [{ evidenceId: 'e', location: { kind: 'source' } }],
        alternatives: [],
        missingFields,
        explanation: 'x',
      },
    ],
    splits: [],
  });
  const complete = {
    vendorId: 'V-1',
    billNumber: 'B-7',
    total: 1200,
    vendor: { name: 'Acme', 'a/b~c': 'z' },
  };
  const validate = (raw: unknown) =>
    validateSuggestions(raw, offered, extraction, limits, 1);
  const rejection = (raw: unknown) => {
    try {
      validate(raw);
    } catch (error) {
      if (error instanceof ProposalValidationError) return error;
      throw error;
    }
    throw new Error('Expected validation to fail');
  };

  it('keeps undeclared missing required arguments as needs_review without inventing values', () => {
    const { vendorId: _v, billNumber: _b, ...args } = complete;
    const result = validate(reply(args));
    expect(result.outcome).toBe('proposals');
    expect(result.suggestions[0]).toMatchObject({
      missingFields: ['billNumber', 'vendorId'],
      disposition: 'needs_review',
    });
    expect(result.suggestions[0].args).toEqual(args);
    expect(result.missingFieldsCorrection).toEqual({
      suggestions: 1,
      added: 2,
      removed: 0,
    });
    // A partial declaration is replaced by the sorted computed set.
    const partial = validate(reply(args, ['vendorId']));
    expect(partial.suggestions[0].missingFields).toEqual([
      'billNumber',
      'vendorId',
    ]);
    expect(partial.missingFieldsCorrection).toEqual({
      suggestions: 1,
      added: 1,
      removed: 0,
    });
  });
  it('names a miss inside a present object or array item by escaped JSON Pointer', () => {
    const result = validate(
      reply({
        ...complete,
        vendor: {},
        lines: [{ sku: 'a' }, {}],
      }),
    );
    expect(result.suggestions[0]).toMatchObject({
      missingFields: ['/lines/1/sku', '/vendor/a~1b~0c', '/vendor/name'],
      disposition: 'needs_review',
    });
  });
  it('is byte-identical for an already declared, exactly matching reply and deterministic otherwise', () => {
    const { vendorId: _v, billNumber: _b, ...args } = complete;
    const declared = reply(args, ['vendorId', 'billNumber']);
    const before = structuredClone(declared.suggestions[0]);
    const result = validate(declared);
    expect(JSON.stringify(result.suggestions[0])).toBe(
      JSON.stringify({ ...before, disposition: 'needs_review' }),
    );
    expect(result).not.toHaveProperty('missingFieldsCorrection');
    // Declared in a different order is still a match, kept as declared.
    expect(
      validate(reply(args, ['billNumber', 'vendorId'])).suggestions[0]
        .missingFields,
    ).toEqual(['billNumber', 'vendorId']);
    const valid = validate(reply(complete));
    expect(valid.suggestions[0].disposition).toBe('ready_for_review');
    expect(valid).not.toHaveProperty('missingFieldsCorrection');
    expect(JSON.stringify(validate(reply(args)))).toBe(
      JSON.stringify(validate(reply(args))),
    );
  });
  it.each([
    ['a type error beside a missing field', { vendorId: 'V', total: 'twelve' }],
    [
      'an extra property beside a missing field',
      { ...complete, billNumber: undefined, secret: 'Acme 4417' },
    ],
    [
      'a miss under a model-chosen key',
      { ...complete, extra: { 'Acme 4417': {} } },
    ],
    ['a miss inside a union branch', { ...complete, choice: {} }],
  ])('still rejects %s', (_name, args) => {
    const error = rejection(
      reply(JSON.parse(JSON.stringify(args)) as Record<string, unknown>),
    );
    expect(error.reason).toMatch(
      /^Invalid handler arguments: \/suggestions\/0\/args /,
    );
    expect(error.reason).not.toMatch(/Acme|4417|twelve/);
  });
  it('corrects a declared field that is not missing and keeps the suggestion for review', () => {
    const listed = validate(reply(complete, ['vendorId', 'memo']));
    expect(listed.suggestions[0]).toMatchObject({
      args: complete,
      missingFields: [],
      disposition: 'needs_review',
    });
    expect(listed.missingFieldsCorrection).toEqual({
      suggestions: 1,
      added: 0,
      removed: 2,
    });
    // Both directions at once, counted without names or values.
    const { billNumber: _b, ...args } = complete;
    const both = validate(reply(args, ['vendorId']));
    expect(both.suggestions[0].missingFields).toEqual(['billNumber']);
    expect(both.missingFieldsCorrection).toEqual({
      suggestions: 1,
      added: 1,
      removed: 1,
    });
    expect(JSON.stringify(both.missingFieldsCorrection)).not.toMatch(
      /vendor|bill/i,
    );
  });
  it.each([
    [
      'array-form dependencies',
      { dependencies: { billNumber: ['total'] } },
      { vendorId: 'V', billNumber: 'B', vendor: { name: 'n', 'a/b~c': 'z' } },
    ],
    [
      'an if/then branch',
      // Built from entries: a literal `then` key trips Biome's noThenProperty.
      Object.fromEntries([
        ['if', { properties: { total: {} }, required: ['total'] }],
        ['then', { properties: { vendorId: {} }, required: ['vendorId'] }],
      ]),
      {
        billNumber: 'B',
        total: 1,
        vendor: { name: 'n', 'a/b~c': 'z' },
      },
    ],
  ])('still rejects a required-like miss from %s', (_name, extra, args) => {
    const schema = { ...argsSchema, required: [], ...extra };
    const own: GenerationOutput['offered'] = [
      { ...offered[0], handler: { ...offered[0].handler, argsSchema: schema } },
    ];
    let error: unknown;
    try {
      validateSuggestions(reply(args), own, extraction, limits, 1);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProposalValidationError);
    expect((error as ProposalValidationError).reason).toMatch(
      /^Invalid handler arguments: \/suggestions\/0\/args /,
    );
  });
  it('treats required inside allOf as required', () => {
    const schema = {
      ...argsSchema,
      allOf: [{ properties: { memo: {} }, required: ['memo'] }],
      properties: { ...argsSchema.properties, memo: { type: 'string' } },
    };
    const own: GenerationOutput['offered'] = [
      { ...offered[0], handler: { ...offered[0].handler, argsSchema: schema } },
    ];
    expect(
      validateSuggestions(reply(complete), own, extraction, limits, 1)
        .suggestions[0].missingFields,
    ).toEqual(['memo']);
  });
  it('bounds the errors examined and the length of each missing field', () => {
    const required = (count: number, name = (index: number) => `f${index}`) =>
      Array.from({ length: count }, (_, index) => ({
        keyword: 'required',
        instancePath: '',
        schemaPath: '#/required',
        params: { missingProperty: name(index) },
      }));
    // Duplicates collapse to one field, but the examined count is still bounded.
    const repeated = Array.from({ length: PROPOSAL_REASON_MAX_ERRORS }, () => ({
      ...required(1)[0],
    }));
    expect(missingRequiredFields(repeated, {}, {})).toEqual(['f0']);
    expect(
      missingRequiredFields([...repeated, required(1)[0]], {}, {}),
    ).toBeUndefined();
    // A schema-declared name longer than the reply's string cap is refused,
    // at the root and once a nested pointer grows past it.
    expect(
      missingRequiredFields(
        required(1, () => 'x'.repeat(513)),
        {},
        {},
      ),
    ).toBeUndefined();
    expect(
      missingRequiredFields(
        required(1, () => 'x'.repeat(512)),
        {},
        {},
      ),
    ).toEqual(['x'.repeat(512)]);
    const long = 'y'.repeat(300);
    const nested = {
      type: 'object',
      properties: { [long]: { type: 'object', properties: {} } },
    };
    expect(
      missingRequiredFields(
        [
          {
            keyword: 'required',
            instancePath: `/${long}`,
            schemaPath: '#/properties/x/required',
            params: { missingProperty: 'z'.repeat(300) },
          },
        ],
        nested,
        { [long]: {} },
      ),
    ).toBeUndefined();
  });
  it('rejects more missing fields than the reply may declare', () => {
    const required = Array.from({ length: 31 }, (_, index) => `f${index}`);
    const wide = {
      type: 'object',
      required,
      properties: Object.fromEntries(
        required.map((name) => [name, { type: 'string' }]),
      ),
    };
    expect(
      missingRequiredFields(
        required.map((missingProperty) => ({
          keyword: 'required',
          instancePath: '',
          schemaPath: '#/required',
          params: { missingProperty },
        })),
        wide,
        {},
      ),
    ).toBeUndefined();
    expect(
      missingRequiredFields(
        required.slice(0, 30).map((missingProperty) => ({
          keyword: 'required',
          instancePath: '',
          schemaPath: '#/required',
          params: { missingProperty },
        })),
        wide,
        {},
      ),
    ).toHaveLength(PROPOSAL_MISSING_FIELDS_LIMIT);
  });
});

describe('mismatched missingFields regression (#4284 QA)', () => {
  // Synthetic equivalent of the QA attempts: a flat closed handler schema, all
  // three required references absent, and a declaration naming something that
  // is not missing. Before the correction this rejected the whole attempt.
  const argsSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['vendorId', 'evidenceId', 'billNumber'],
    properties: {
      vendorId: { type: 'string', minLength: 1, maxLength: 64 },
      evidenceId: { type: 'string', minLength: 1, maxLength: 64 },
      billNumber: { type: 'string', minLength: 1, maxLength: 128 },
      billDate: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      totalCents: { type: 'integer', minimum: 0 },
    },
  };
  const offered: GenerationOutput['offered'] = [
    {
      handler: {
        id: 'bill',
        version: '1',
        description: 'Record a vendor bill',
        kind: 'operation',
        capability: null,
        argsSchema,
        references: {},
        operation: { model: 'M', action: 'a', version: '1' },
      },
      candidates: [],
    },
  ];
  const extraction = [
    {
      evidence: { id: 'e', contentHash: 'hash' },
      configurationRevision: 'test',
      segments: [{ location: { kind: 'source' } }],
    },
  ] as ExtractionResult[];
  const args = { billDate: '2026-01-02', totalCents: 12345 };
  it.each([
    ['a present field', ['totalCents']],
    ['an optional absent field', ['currency']],
    ['an unknown name beside a real miss', ['vendorId', 'vendorName']],
  ])('keeps the suggestion when the declaration names %s', (_name, declared) => {
    const reply = {
      outcome: 'proposals',
      suggestions: [
        {
          handlerId: 'bill',
          handlerVersion: '1',
          args,
          evidence: [{ evidenceId: 'e', location: { kind: 'source' } }],
          alternatives: [],
          missingFields: declared,
          explanation: 'x',
        },
      ],
      splits: [],
    };
    // The exact value-free reason the earlier rule recorded for this shape.
    const ajv = new Ajv({ strict: true, allErrors: true });
    const check = ajv.compile(argsSchema);
    expect(check(args)).toBe(false);
    expect(
      `/suggestions/0/args ${describeSchemaErrors(check.errors, argsSchema, args)}`,
    ).toBe(
      '/suggestions/0/args / required (missingProperty=vendorId); / required (missingProperty=evidenceId); / required (missingProperty=billNumber)',
    );
    const result = validateSuggestions(reply, offered, extraction, limits, 1);
    expect(result.outcome).toBe('proposals');
    expect(result.suggestions[0]).toMatchObject({
      args,
      missingFields: ['billNumber', 'evidenceId', 'vendorId'],
      disposition: 'needs_review',
    });
    expect(result.missingFieldsCorrection).toEqual({
      suggestions: 1,
      added: 3 - declared.filter((field) => field === 'vendorId').length,
      removed: declared.filter((field) => field !== 'vendorId').length,
    });
  });
});

describe('invented candidate targets (#4289)', () => {
  // The QA shape: an offered handler whose candidate field holds an ID that
  // is not among the offered candidates.
  const INVENTED = 'V-INVENTED-0042';
  const argsSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['vendorId', 'evidenceId', 'billNumber'],
    properties: {
      vendorId: { type: 'string', minLength: 1, maxLength: 64 },
      projectId: { type: 'string', minLength: 1, maxLength: 64 },
      evidenceId: { type: 'string', minLength: 1, maxLength: 64 },
      billNumber: { type: 'string', minLength: 1, maxLength: 128 },
      totalCents: { type: 'integer', minimum: 0 },
    },
  };
  const handler = {
    id: 'bill',
    version: '1',
    description: 'Record a vendor bill',
    kind: 'operation' as const,
    capability: null,
    argsSchema,
    references: {
      vendorId: { kind: 'candidate' as const, model: 'Vendor' },
      projectId: { kind: 'candidate' as const, model: 'Project' },
      evidenceId: { kind: 'evidence' as const },
    },
    operation: { model: 'M', action: 'a', version: '1' },
  };
  const candidates = [
    {
      key: 'Vendor:v1@r1',
      model: 'Vendor',
      id: 'v1',
      revision: 'r1',
      label: 'Acme',
    },
    {
      key: 'Project:p1@r1',
      model: 'Project',
      id: 'p1',
      revision: 'r1',
      label: 'Roof',
    },
  ];
  const offered: GenerationOutput['offered'] = [{ handler, candidates }];
  const extraction = [
    {
      evidence: { id: 'e', contentHash: 'hash' },
      configurationRevision: 'test',
      segments: [{ location: { kind: 'source' } }],
    },
  ] as ExtractionResult[];
  const complete = {
    vendorId: 'v1',
    projectId: 'p1',
    evidenceId: 'e',
    billNumber: 'B-7',
    totalCents: 1200,
  };
  const suggestion = (
    args: Record<string, unknown>,
    missingFields: string[] = [],
    extra: Record<string, unknown> = {},
  ) => ({
    handlerId: 'bill',
    handlerVersion: '1',
    args,
    evidence: [{ evidenceId: 'e', location: { kind: 'source' } }],
    alternatives: [],
    missingFields,
    explanation: 'Bill from the retained text.',
    ...extra,
  });
  const reply = (...suggestions: ReturnType<typeof suggestion>[]) => ({
    outcome: 'proposals',
    suggestions,
    splits: [],
  });
  const validate = (raw: unknown, own = offered) =>
    validateSuggestions(raw, own, extraction, limits, 1);
  const rejection = (raw: unknown, own = offered) => {
    try {
      validate(raw, own);
    } catch (error) {
      if (error instanceof ProposalValidationError) return error;
      throw error;
    }
    throw new Error('Expected validation to fail');
  };

  it('drops an invented required target, marks it missing and keeps the suggestion for review', () => {
    const raw = reply(suggestion({ ...complete, vendorId: INVENTED }));
    const result = validate(raw);
    expect(result.outcome).toBe('proposals');
    expect(result.suggestions[0]).toMatchObject({
      missingFields: ['vendorId'],
      disposition: 'needs_review',
    });
    const { vendorId: _v, ...kept } = complete;
    expect(result.suggestions[0].args).toEqual(kept);
    expect(result.suggestions[0].args).not.toHaveProperty('vendorId');
    expect(result.unofferedTargetsDropped).toEqual({
      suggestions: 1,
      fields: 1,
    });
    expect(result.missingFieldsCorrection).toEqual({
      suggestions: 1,
      added: 1,
      removed: 0,
    });
    expect(JSON.stringify(result)).not.toContain(INVENTED);
    // The model's reply is not mutated.
    expect(raw.suggestions[0].args.vendorId).toBe(INVENTED);
  });
  it('drops an invented optional target and still keeps the suggestion for review', () => {
    const result = validate(
      reply(suggestion({ ...complete, projectId: INVENTED })),
    );
    expect(result.suggestions[0]).toMatchObject({
      missingFields: [],
      disposition: 'needs_review',
    });
    expect(result.suggestions[0].args).not.toHaveProperty('projectId');
    expect(result.unofferedTargetsDropped).toEqual({
      suggestions: 1,
      fields: 1,
    });
    // The declaration matched what is missing, so nothing was corrected.
    expect(result).not.toHaveProperty('missingFieldsCorrection');
    expect(JSON.stringify(result)).not.toContain(INVENTED);
  });
  it('combines an invented target with a required miss and counts across suggestions', () => {
    const { billNumber: _b, ...args } = complete;
    const result = validate(
      reply(
        suggestion(
          { ...args, vendorId: INVENTED, projectId: `${INVENTED}-P` },
          ['billNumber'],
        ),
        suggestion({ ...complete, vendorId: `${INVENTED}-2` }),
        suggestion(complete),
      ),
    );
    expect(result.suggestions[0]).toMatchObject({
      missingFields: ['billNumber', 'vendorId'],
      disposition: 'needs_review',
    });
    expect(result.suggestions[1]).toMatchObject({
      missingFields: ['vendorId'],
      disposition: 'needs_review',
    });
    expect(result.suggestions[2].disposition).toBe('ready_for_review');
    expect(result.unofferedTargetsDropped).toEqual({
      suggestions: 2,
      fields: 3,
    });
    expect(JSON.stringify(result.unofferedTargetsDropped)).not.toMatch(
      /vendor|project|V-|v1|p1/i,
    );
    expect(JSON.stringify(result)).not.toContain(INVENTED);
  });
  it('is byte-identical for offered targets and deterministic for dropped ones', () => {
    const valid = reply(suggestion(complete));
    const before = structuredClone(valid.suggestions[0]);
    const result = validate(valid);
    expect(JSON.stringify(result.suggestions[0])).toBe(
      JSON.stringify({ ...before, disposition: 'ready_for_review' }),
    );
    expect(result).not.toHaveProperty('unofferedTargetsDropped');
    const invented = reply(suggestion({ ...complete, vendorId: INVENTED }));
    expect(JSON.stringify(validate(invented))).toBe(
      JSON.stringify(validate(structuredClone(invented))),
    );
    // Key order of the kept arguments follows the reply.
    expect(Object.keys(validate(invented).suggestions[0].args)).toEqual([
      'projectId',
      'evidenceId',
      'billNumber',
      'totalCents',
    ]);
  });
  it('accepts a candidate of the wrong model as invented, never as the offered target', () => {
    const { projectId: _p, ...args } = complete;
    const result = validate(reply(suggestion({ ...args, vendorId: 'p1' })));
    expect(result.suggestions[0].args).not.toHaveProperty('vendorId');
    expect(result.suggestions[0].missingFields).toEqual(['vendorId']);
  });
  it.each([
    [
      'an unoffered handler',
      reply({
        ...suggestion({ ...complete, vendorId: INVENTED }),
        handlerId: 'evil',
      }),
      'Unoffered handler: /suggestions/0',
    ],
    [
      'an unoffered alternative',
      reply(
        suggestion({ ...complete, vendorId: INVENTED }, [], {
          alternatives: ['Vendor:invented@r1'],
        }),
      ),
      'Unoffered handler: /suggestions/0',
    ],
    [
      'unknown argument evidence',
      reply(
        suggestion({ ...complete, vendorId: INVENTED, evidenceId: 'nope' }),
      ),
      'Unknown evidence: /suggestions/0/args/evidenceId',
    ],
    [
      'an unknown evidence reference',
      reply(
        suggestion({ ...complete, vendorId: INVENTED }, [], {
          evidence: [{ evidenceId: 'nope', location: { kind: 'source' } }],
        }),
      ),
      'Unknown evidence location: /suggestions/0/evidence/0',
    ],
  ])('still rejects an invented target beside %s', (_name, raw, reason) => {
    expect(rejection(raw).reason).toBe(reason);
  });
  it.each([
    ['a type error', { ...complete, vendorId: INVENTED, totalCents: 'twelve' }],
    ['an extra property', { ...complete, vendorId: INVENTED, memo: 'x' }],
    ['a non-string target', { ...complete, vendorId: 4417 }],
  ])('still rejects an invented target beside %s', (_name, args) => {
    const error = rejection(reply(suggestion(args)));
    expect(error.reason).toMatch(
      /^(Invalid handler arguments|Unoffered target): \/suggestions\/0\/args/,
    );
    expect(error.reason).not.toMatch(/INVENTED|twelve|4417/);
  });
  it('still rejects a target field the schema does not declare', () => {
    const open = {
      ...argsSchema,
      additionalProperties: true,
    };
    const own: GenerationOutput['offered'] = [
      {
        handler: {
          ...handler,
          argsSchema: open,
          references: {
            ...handler.references,
            siteId: { kind: 'candidate', model: 'Site' },
          },
        },
        candidates,
      },
    ];
    expect(
      rejection(reply(suggestion({ ...complete, siteId: INVENTED })), own)
        .reason,
    ).toBe('Unoffered target: /suggestions/0/args/siteId');
  });
  it('still rejects a non-string target the schema accepts', () => {
    const own: GenerationOutput['offered'] = [
      {
        handler: {
          ...handler,
          argsSchema: {
            ...argsSchema,
            properties: { ...argsSchema.properties, vendorId: {} },
          },
        },
        candidates,
      },
    ];
    expect(
      rejection(reply(suggestion({ ...complete, vendorId: { id: 4417 } })), own)
        .reason,
    ).toBe('Unoffered target: /suggestions/0/args/vendorId');
  });
  it('still rejects when dropping the target exposes another refusal', () => {
    const own: GenerationOutput['offered'] = [
      {
        handler: {
          ...handler,
          argsSchema: { ...argsSchema, required: [], minProperties: 5 },
        },
        candidates,
      },
    ];
    expect(
      rejection(reply(suggestion({ ...complete, vendorId: INVENTED })), own)
        .reason,
    ).toBe('Unoffered target: /suggestions/0/args/vendorId');
  });
  it('still rejects when the invented target is echoed in the explanation', () => {
    const error = rejection(
      reply(
        suggestion({ ...complete, vendorId: INVENTED }, [], {
          explanation: `Pay ${INVENTED} now.`,
        }),
      ),
    );
    expect(error.reason).toBe('Unoffered target: /suggestions/0/args/vendorId');
  });
  it.each([
    '1',
    'a',
    'e',
  ])('fails closed on a short or common invented target (%s) that the kept output happens to contain', (value) => {
    // The guard matches the exact (JSON-escaped) value anywhere in the kept
    // suggestions and splits, keys included, so a value that is also ordinary
    // text there rejects the attempt rather than being dropped.
    expect(
      rejection(reply(suggestion({ ...complete, vendorId: value }))).reason,
    ).toBe('Unoffered target: /suggestions/0/args/vendorId');
  });
  it.each([
    'V"X-4289',
    'V\\X-4289',
  ])('still rejects an escapable invented target (%s) echoed in the explanation', (value) => {
    // The kept output is serialized JSON, so the guard must look for the
    // escaped form; a raw substring search would miss this echo.
    const error = rejection(
      reply(
        suggestion({ ...complete, vendorId: value }, [], {
          explanation: `Pay ${value} now.`,
        }),
      ),
    );
    expect(error.reason).toBe('Unoffered target: /suggestions/0/args/vendorId');
  });
  it('replaces a declaration that names the invented target with the computed set', () => {
    const result = validate(
      reply(suggestion({ ...complete, vendorId: INVENTED }, [INVENTED])),
    );
    expect(result.suggestions[0].missingFields).toEqual(['vendorId']);
    expect(result.missingFieldsCorrection).toEqual({
      suggestions: 1,
      added: 1,
      removed: 1,
    });
    expect(JSON.stringify(result)).not.toContain(INVENTED);
  });
  it('still rejects when the invented target is echoed in another argument or suggestion', () => {
    expect(
      rejection(
        reply(
          suggestion({
            ...complete,
            vendorId: INVENTED,
            billNumber: `#${INVENTED}`,
          }),
        ),
      ).reason,
    ).toBe('Unoffered target: /suggestions/0/args/vendorId');
    expect(
      rejection(
        reply(
          suggestion({ ...complete, vendorId: INVENTED }),
          suggestion({ ...complete, billNumber: INVENTED }),
        ),
      ).reason,
    ).toBe('Unoffered target: /suggestions/0/args/vendorId');
  });
});

describe('bounded generated explanations (#4331)', () => {
  const reply = (...explanations: unknown[]) => ({
    outcome: 'needs_review',
    suggestions: explanations.map((explanation) => ({
      handlerId: 'h',
      handlerVersion: '1',
      args: {},
      evidence: [{ evidenceId: 'e', location: { kind: 'source' } }],
      alternatives: [],
      missingFields: [],
      explanation,
    })),
    splits: [],
  });
  const points = (value: unknown) => Array.from(value as string).length;
  const explanations = (output: unknown) =>
    (
      output as { suggestions: Array<{ explanation: unknown }> }
    ).suggestions.map(({ explanation }) => explanation);

  it('bounds the validator at the shared limit', () => {
    expect(PROPOSAL_EXPLANATION_LIMIT).toBe(300);
    const items = suggestionSchema(limits).properties.suggestions.items;
    expect(items.properties.explanation).toEqual({
      type: 'string',
      maxLength: PROPOSAL_EXPLANATION_LIMIT,
    });
    const ajv = new Ajv({ strict: true, validateFormats: false });
    const check = ajv.compile(suggestionSchema(limits));
    expect(check(reply('x'.repeat(PROPOSAL_EXPLANATION_LIMIT)))).toBe(true);
    expect(check(reply('x'.repeat(PROPOSAL_EXPLANATION_LIMIT + 1)))).toBe(
      false,
    );
  });

  it('cuts only over-long explanations, on a code-point boundary, and counts them', () => {
    const atLimit = 'a'.repeat(PROPOSAL_EXPLANATION_LIMIT);
    // A surrogate pair straddles the cut: it must stay whole or go whole.
    const astral = `${'b'.repeat(PROPOSAL_EXPLANATION_LIMIT - 2)}\u{1F600}\u{1F600}\u{1F600}`;
    const long = `This document is a request. Wait, ${'the rules say '.repeat(60)}`;
    const raw = reply('Short.', atLimit, astral, long);
    const before = structuredClone(raw);
    const { output, truncated } = boundGeneratedExplanations(raw);
    expect(truncated).toBe(2);
    const [short, kept, cutAstral, cutLong] = explanations(output);
    expect(short).toBe('Short.');
    expect(kept).toBe(atLimit);
    expect(points(cutAstral)).toBe(PROPOSAL_EXPLANATION_LIMIT);
    expect(cutAstral).toBe(
      `${'b'.repeat(PROPOSAL_EXPLANATION_LIMIT - 2)}\u{1F600}\u2026`,
    );
    expect(cutAstral as string).not.toMatch(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/,
    );
    expect(points(cutLong)).toBeLessThanOrEqual(PROPOSAL_EXPLANATION_LIMIT);
    expect(cutLong as string).toMatch(
      /^This document is a request\. Wait, the rules say/,
    );
    expect(cutLong as string).toMatch(/\S\u2026$/);
    // Code point 299 is a space: trailing whitespace goes before the ellipsis.
    const spaced = `${'c'.repeat(PROPOSAL_EXPLANATION_LIMIT - 2)}   ${'d'.repeat(10)}`;
    expect(
      explanations(boundGeneratedExplanations(reply(spaced)).output),
    ).toEqual([`${'c'.repeat(PROPOSAL_EXPLANATION_LIMIT - 2)}\u2026`]);
    // The generator's reply is not mutated, and the result validates.
    expect(raw).toEqual(before);
    expect(
      new Ajv({ strict: true, validateFormats: false }).validate(
        suggestionSchema(limits),
        output,
      ),
    ).toBe(true);
    // Idempotent: a bounded reply is left alone.
    expect(boundGeneratedExplanations(output)).toEqual({
      output,
      truncated: 0,
    });
  });

  it('passes non-string explanations and malformed input through for the validator', () => {
    const raw = reply(42, null, undefined);
    const { output, truncated } = boundGeneratedExplanations(raw);
    expect(truncated).toBe(0);
    expect(output).toEqual(raw);
    for (const value of [null, 'x', [], { suggestions: 'x' }])
      expect(boundGeneratedExplanations(value)).toEqual({
        output: value,
        truncated: 0,
      });
  });
});
