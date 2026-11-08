import { describe, expect, it } from 'vitest';
import {
  hasClosedKeys,
  hasDuplicateKeys,
  isRecord,
  parseStrictJson,
} from './strict-json.js';

describe('hasDuplicateKeys', () => {
  it.each([
    '{"a":1,"a":2}',
    '{"a":{"b":1,"b":2}}',
    '{"a":[{"b":1,"b":2}]}',
    '{"a":1,"\\u0061":2}',
    '{"__proto__":{},"__proto__":{}}',
    '[{"k":1},{"x":{"y":1,"y":1}}]',
  ])('detects %s', (json) => {
    expect(hasDuplicateKeys(json)).toBe(true);
  });

  it.each([
    '{}',
    '{"a":1,"b":2}',
    '{"a":{"x":1},"b":{"x":1}}',
    '[{"a":1},{"a":2}]',
    '{"a":"a","b":"b"}',
    '{"a":"{\\"a\\":1,\\"a\\":2}"}',
    '{"a":["b","b"],"c":[1,1]}',
  ])('allows %s', (json) => {
    expect(hasDuplicateKeys(json)).toBe(false);
  });
});

describe('parseStrictJson', () => {
  it('returns the value for valid JSON', () => {
    expect(parseStrictJson('{"a":[1,2]}')).toEqual({
      ok: true,
      value: { a: [1, 2] },
    });
  });

  it('classifies syntax errors without echoing input', () => {
    const result = parseStrictJson('{"secret":');
    expect(result).toEqual({ ok: false, reason: 'syntax' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('classifies duplicate keys', () => {
    expect(parseStrictJson('{"a":1,"a":2}')).toEqual({
      ok: false,
      reason: 'duplicate_keys',
    });
  });
});

describe('isRecord / hasClosedKeys', () => {
  it('accepts only plain objects', () => {
    expect(isRecord({})).toBe(true);
    for (const value of [null, [], 'x', 1, undefined]) {
      expect(isRecord(value)).toBe(false);
    }
  });

  it('requires every required key and rejects unknown ones', () => {
    expect(hasClosedKeys({ a: 1 }, ['a'])).toBe(true);
    expect(hasClosedKeys({ a: 1, b: 2 }, ['a'], ['b'])).toBe(true);
    expect(hasClosedKeys({ b: 2 }, ['a'], ['b'])).toBe(false);
    expect(hasClosedKeys({ a: 1, c: 3 }, ['a'], ['b'])).toBe(false);
    expect(hasClosedKeys(JSON.parse('{"a":1,"__proto__":{}}'), ['a'])).toBe(
      false,
    );
  });
});
