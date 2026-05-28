/**
 * Tests for the JSONSchema → flag parser.
 *
 * Pins behavior for the supported subset (primitives + enums + arrays of
 * primitives + nullable + required + defaults + additionalProperties) and
 * the positional-JSON fallback for unsupported schemas.
 */

import { describe, expect, it } from 'vitest';
import { buildFlagParser, classifySchema } from '../parser.js';

describe('classifySchema', () => {
  it('reports missing for empty / undefined', () => {
    expect(classifySchema(undefined).kind).toBe('missing');
    expect(classifySchema({}).kind).toBe('missing');
  });

  it('accepts a simple primitive-only object', () => {
    expect(
      classifySchema({
        type: 'object',
        properties: { name: { type: 'string' }, n: { type: 'integer' } },
      }).kind,
    ).toBe('ok');
  });

  it('rejects nested objects', () => {
    expect(
      classifySchema({
        type: 'object',
        properties: { sub: { type: 'object', properties: {} } },
      }).kind,
    ).toBe('unsupported');
  });

  it('rejects oneOf/anyOf/allOf/$ref', () => {
    for (const variant of ['oneOf', 'anyOf', 'allOf']) {
      expect(
        classifySchema({
          type: 'object',
          properties: { x: { type: 'string', [variant]: [{}] } },
        }).kind,
      ).toBe('unsupported');
    }
    expect(
      classifySchema({
        type: 'object',
        properties: { x: { type: 'string', $ref: '#/defs/x' } },
      }).kind,
    ).toBe('unsupported');
  });

  it('accepts arrays of primitives, rejects arrays of objects', () => {
    expect(
      classifySchema({
        type: 'object',
        properties: { tags: { type: 'array', items: { type: 'string' } } },
      }).kind,
    ).toBe('ok');
    expect(
      classifySchema({
        type: 'object',
        properties: {
          xs: { type: 'array', items: { type: 'object', properties: {} } },
        },
      }).kind,
    ).toBe('unsupported');
  });
});

describe('rich flag parser', () => {
  const schema = {
    type: 'object',
    required: ['url'],
    properties: {
      url: { type: 'string' },
      limit: { type: 'integer', default: 10 },
      ratio: { type: 'number' },
      skipFetch: { type: 'boolean' },
      mode: { type: 'string', enum: ['fast', 'slow'] },
      tags: { type: 'array', items: { type: 'string' } },
      counts: { type: 'array', items: { type: 'integer' } },
      note: { type: ['string', 'null'] },
    },
    additionalProperties: false,
  };

  function parse(argv: string[], httpMethod = 'POST') {
    const parser = buildFlagParser(schema);
    return parser.parse(argv, httpMethod);
  }

  it('parses required string', () => {
    const r = parse(['--url', 'https://example.com']);
    expect(r.body).toEqual({ url: 'https://example.com', limit: 10 });
  });

  it('errors on missing required', () => {
    expect(() => parse([])).toThrow(/--url/);
  });

  it('coerces integers and rejects non-integers', () => {
    expect(parse(['--url=x', '--limit=42']).body).toEqual({
      url: 'x',
      limit: 42,
    });
    expect(() => parse(['--url=x', '--limit=4.5'])).toThrow(/integer/);
  });

  it('handles boolean toggle and --no- form', () => {
    expect(parse(['--url=x', '--skipFetch']).body.skipFetch).toBe(true);
    expect(parse(['--url=x', '--no-skipFetch']).body.skipFetch).toBe(false);
  });

  it('validates enums', () => {
    expect(parse(['--url=x', '--mode=fast']).body.mode).toBe('fast');
    expect(() => parse(['--url=x', '--mode=warp'])).toThrow(/fast|slow/);
  });

  it('parses arrays with repeated flag and comma form', () => {
    expect(parse(['--url=x', '--tags=a', '--tags=b']).body.tags).toEqual([
      'a',
      'b',
    ]);
    expect(parse(['--url=x', '--tags=a,b,c']).body.tags).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(parse(['--url=x', '--counts=1,2,3']).body.counts).toEqual([1, 2, 3]);
  });

  it('treats omitted nullable as absent, not null', () => {
    const r = parse(['--url=x']);
    expect('note' in r.body).toBe(false);
  });

  it('accepts explicit --note=null for nullable types', () => {
    expect(parse(['--url=x', '--note=null']).body.note).toBeNull();
  });

  it('rejects unknown flags when additionalProperties is false', () => {
    expect(() => parse(['--url=x', '--bogus=1'])).toThrow(/Unknown flag/);
  });

  it('routes GET params to query string, body empty', () => {
    const r = parse(['--url=x', '--limit=5'], 'GET');
    expect(r.body).toEqual({});
    expect(r.query).toEqual({ url: 'x', limit: '5' });
  });

  it('accepts positional JSON as escape hatch and lets explicit flags win', () => {
    const r = parse(['--url=cli', '{"limit": 99, "extra": "fromJson"}']);
    expect(r.body.url).toBe('cli'); // explicit flag wins
    expect(r.body.limit).toBe(99); // from positional JSON
  });
});

describe('positional fallback parser', () => {
  it('accepts JSON payload when schema is missing', () => {
    const parser = buildFlagParser(undefined);
    const r = parser.parse(['{"a":1,"b":"x"}'], 'POST');
    expect(r.body).toEqual({ a: 1, b: 'x' });
    expect(r.fromPositional).toBe(true);
  });

  it('translates JSON to query string for GET', () => {
    const parser = buildFlagParser({});
    const r = parser.parse(['{"limit":5}'], 'GET');
    expect(r.body).toEqual({});
    expect(r.query).toEqual({ limit: '5' });
  });

  it('falls through to positional when schema has unsupported constructs', () => {
    const parser = buildFlagParser({
      type: 'object',
      properties: { x: { oneOf: [{ type: 'string' }, { type: 'number' }] } },
    });
    expect(parser.status.kind).toBe('unsupported');
    const r = parser.parse(['{"x":"hi"}'], 'POST');
    expect(r.body).toEqual({ x: 'hi' });
  });
});

describe('boolean form variants — #1311 copilot C2 + reviewer B test gap', () => {
  const schema = {
    type: 'object',
    properties: { skipFetch: { type: 'boolean' } },
    additionalProperties: false,
  };
  const parse = (argv: string[]) => buildFlagParser(schema).parse(argv, 'POST');

  it('--flag false (spaced form) sets boolean to false', () => {
    expect(parse(['--skipFetch', 'false']).body.skipFetch).toBe(false);
  });

  it('--flag true (spaced form) sets boolean to true', () => {
    expect(parse(['--skipFetch', 'true']).body.skipFetch).toBe(true);
  });

  it('--flag=false (equals form) sets boolean to false', () => {
    expect(parse(['--skipFetch=false']).body.skipFetch).toBe(false);
  });

  it('--flag=true (equals form) sets boolean to true', () => {
    expect(parse(['--skipFetch=true']).body.skipFetch).toBe(true);
  });

  it('--flag without value still defaults to true (toggle form)', () => {
    expect(parse(['--skipFetch']).body.skipFetch).toBe(true);
  });

  it('non-boolean-literal next token leaves boolean toggled to true', () => {
    // `--skipFetch xyz` — xyz is not true/false so the boolean is just
    // toggled and xyz is left to be parsed as the next argv.
    // additionalProperties is false so xyz becomes a positional (and the
    // parser tries to JSON-parse it).
    expect(() => parse(['--skipFetch', 'xyz'])).toThrow();
  });
});

describe('additionalProperties: true', () => {
  it('passes through unknown flags as strings', () => {
    const parser = buildFlagParser({
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: true,
    });
    const r = parser.parse(['--name=praeco', '--extra=meta'], 'POST');
    expect(r.body).toEqual({ name: 'praeco', extra: 'meta' });
  });
});
