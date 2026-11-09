import { describe, expect, it } from 'vitest';
import { describeModelError, redact } from './diagnostics.ts';

describe('model error diagnostics', () => {
  it('keeps the provider message and status', () => {
    const e = Object.assign(
      new Error(
        'tools.16.custom.input_schema: input_schema does not support anyOf at the top level',
      ),
      { code: 'UNKNOWN_ERROR', status: 400 },
    );
    const text = describeModelError(e);
    expect(text).toContain('Error/UNKNOWN_ERROR status=400');
    expect(text).toContain('does not support anyOf');
  });

  it('redacts keys, bearer tokens, credentialed urls and long tokens', () => {
    const text = redact(
      'bad sk-ant-SECRETKEY123 and Bearer abcDEF123.xyz at https://user:pw@api.example.com/v1/x?key=SECRET and x-api-key: ZZZ ' +
        'a'.repeat(60),
    );
    for (const secret of [
      'SECRETKEY123',
      'abcDEF123',
      'user:pw',
      'key=SECRET',
      'ZZZ',
      'a'.repeat(40),
    ])
      expect(text).not.toContain(secret);
    expect(text).toContain('api.example.com/v1/x');
  });

  it('caps the length', () => {
    expect(redact('word '.repeat(500)).length).toBeLessThanOrEqual(300);
  });
});
