import Ajv from 'ajv';
import { describe, expect, it } from 'vitest';
import type { ExtractionResult } from './extraction-types.js';
import type { GenerationLimits } from './proposal-contracts.js';
import type { GenerationOutput } from './proposal-dto.js';
import {
  describeSchemaErrors,
  missingRequiredFields,
  PROPOSAL_MISSING_FIELDS_LIMIT,
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
