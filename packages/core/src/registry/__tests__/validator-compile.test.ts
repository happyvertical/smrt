/**
 * Coverage tests for registry/validator.ts (compileValidators).
 *
 * Drives ObjectRegistry.compileValidators() directly with field-definition
 * maps, then executes each compiled validator against mock instances to
 * exercise every branch: required, numeric min/max, string min/max length,
 * regex pattern, custom validator (pass/fail/throw), transient skip, and the
 * pass-through (returns null) paths.
 *
 * No database needed — compileValidators is a pure function over field
 * metadata; the validators it returns are plain async closures we call by hand.
 *
 * @see src/registry/validator.ts (issue #1500 coverage push, ORM group)
 */

import { describe, expect, it } from 'vitest';
import { ObjectRegistry } from '../../registry';

/**
 * Field definition shape matching what the AST scanner / decorators produce:
 * a `type` discriminator, optional top-level `transient`, and an `_meta`
 * options bag carrying required/min/max/minLength/maxLength/pattern/validate.
 */
function field(
  type: string,
  meta: Record<string, any> = {},
  extra: Record<string, any> = {},
): any {
  return { type, _meta: meta, ...extra };
}

function compile(fields: Record<string, any>) {
  const map = new Map<string, any>(Object.entries(fields));
  return ObjectRegistry.compileValidators('CompileValidatorFixture', map);
}

/** Run every validator and collect the non-null results (validation errors). */
async function runAll(validators: any[], instance: any): Promise<any[]> {
  const results = await Promise.all(validators.map((v) => v(instance)));
  return results.filter((r) => r !== null && r !== undefined);
}

describe('compileValidators', () => {
  describe('transient fields', () => {
    it('skips fields flagged transient via _meta.transient', () => {
      const validators = compile({
        ghost: field('text', { transient: true, required: true }),
      });
      expect(validators).toHaveLength(0);
    });

    it('skips fields flagged transient via top-level field.transient', () => {
      const validators = compile({
        ghost: field('text', { required: true }, { transient: true }),
      });
      expect(validators).toHaveLength(0);
    });
  });

  describe('required validator', () => {
    it('returns a requiredField error when value is null/undefined/empty', async () => {
      const validators = compile({
        name: field('text', { required: true }),
      });
      expect(validators).toHaveLength(1);

      const nullErr = await validators[0]({ name: null });
      const undefErr = await validators[0]({ name: undefined });
      const emptyErr = await validators[0]({ name: '' });

      for (const err of [nullErr, undefErr, emptyErr]) {
        expect(err).not.toBeNull();
        expect(err.code).toBe('VALIDATION_REQUIRED_FIELD');
        expect(err.details.fieldName).toBe('name');
      }
    });

    it('returns null when the required value is present', async () => {
      const validators = compile({
        name: field('text', { required: true }),
      });
      expect(await validators[0]({ name: 'present' })).toBeNull();
      // 0 is a present value for a required field (only '' counts as empty).
      expect(await validators[0]({ name: 0 })).toBeNull();
    });
  });

  describe('numeric range validators', () => {
    it('produces min and max validators for integer/decimal/number types', () => {
      for (const type of ['integer', 'decimal', 'number']) {
        const validators = compile({ a: field(type, { min: 1, max: 10 }) });
        expect(validators).toHaveLength(2);
      }
    });

    it('flags values below min and passes values at/above min', async () => {
      const [minValidator] = compile({ qty: field('integer', { min: 5 }) });
      const below = await minValidator({ qty: 4 });
      expect(below.code).toBe('VALIDATION_RANGE_ERROR');
      expect(below.details.min).toBe(5);

      expect(await minValidator({ qty: 5 })).toBeNull();
      expect(await minValidator({ qty: 99 })).toBeNull();
      // null/undefined skip the range check (only checked when value present)
      expect(await minValidator({ qty: null })).toBeNull();
      expect(await minValidator({ qty: undefined })).toBeNull();
    });

    it('flags values above max and passes values at/below max', async () => {
      const [maxValidator] = compile({ qty: field('decimal', { max: 100 }) });
      const above = await maxValidator({ qty: 101 });
      expect(above.code).toBe('VALIDATION_RANGE_ERROR');
      expect(above.details.max).toBe(100);

      expect(await maxValidator({ qty: 100 })).toBeNull();
      expect(await maxValidator({ qty: 0 })).toBeNull();
      expect(await maxValidator({ qty: null })).toBeNull();
    });

    it('does not emit numeric validators for non-numeric types', () => {
      // text type with min/max should not generate range validators here
      const validators = compile({ a: field('text', { min: 1, max: 10 }) });
      expect(validators).toHaveLength(0);
    });
  });

  describe('string length validators', () => {
    it('flags strings shorter than minLength and passes longer ones', async () => {
      const [minLen] = compile({ bio: field('text', { minLength: 3 }) });
      const tooShort = await minLen({ bio: 'ab' });
      expect(tooShort.code).toBe('VALIDATION_INVALID_VALUE');
      expect(tooShort.details.fieldName).toBe('bio');

      expect(await minLen({ bio: 'abc' })).toBeNull();
      // empty string is falsy → guard short-circuits, returns null
      expect(await minLen({ bio: '' })).toBeNull();
      // non-string value → typeof guard short-circuits
      expect(await minLen({ bio: 12345 })).toBeNull();
    });

    it('flags strings longer than maxLength and passes shorter ones', async () => {
      const [maxLen] = compile({ code: field('text', { maxLength: 4 }) });
      const tooLong = await maxLen({ code: 'abcde' });
      expect(tooLong.code).toBe('VALIDATION_INVALID_VALUE');

      expect(await maxLen({ code: 'abcd' })).toBeNull();
      expect(await maxLen({ code: '' })).toBeNull();
      expect(await maxLen({ code: { not: 'a string' } })).toBeNull();
    });
  });

  describe('pattern validator', () => {
    it('flags strings that do not match the pattern and passes matches', async () => {
      const [pat] = compile({
        slug: field('text', { pattern: '^[a-z]+$' }),
      });
      const bad = await pat({ slug: 'Has-Caps-123' });
      expect(bad.code).toBe('VALIDATION_INVALID_VALUE');

      expect(await pat({ slug: 'lowercase' })).toBeNull();
      // empty / non-string short-circuit
      expect(await pat({ slug: '' })).toBeNull();
      expect(await pat({ slug: 42 })).toBeNull();
    });
  });

  describe('custom validator', () => {
    it('returns null when the custom validator resolves truthy', async () => {
      const [custom] = compile({
        even: field('integer', {
          validate: (v: number) => v % 2 === 0,
        }),
      });
      expect(await custom({ even: 4 })).toBeNull();
    });

    it('returns invalidValue with default message when validator resolves falsy', async () => {
      const [custom] = compile({
        even: field('integer', {
          validate: (v: number) => v % 2 === 0,
        }),
      });
      const err = await custom({ even: 3 });
      expect(err.code).toBe('VALIDATION_INVALID_VALUE');
      expect(err.details.expectedType).toContain('failed custom validation');
    });

    it('uses customMessage when provided and validator fails', async () => {
      const [custom] = compile({
        even: field('integer', {
          validate: (v: number) => v % 2 === 0,
          customMessage: 'must be even',
        }),
      });
      const err = await custom({ even: 7 });
      expect(err.details.expectedType).toBe('must be even');
    });

    it('catches a throwing custom validator and reports the error message', async () => {
      const [custom] = compile({
        x: field('text', {
          validate: () => {
            throw new Error('boom in validator');
          },
        }),
      });
      const err = await custom({ x: 'anything' });
      expect(err.code).toBe('VALIDATION_INVALID_VALUE');
      expect(err.details.expectedType).toContain('boom in validator');
    });

    it('catches a thrown non-Error value (String(error) branch)', async () => {
      const [custom] = compile({
        x: field('text', {
          validate: () => {
            // Intentionally throw a non-Error to hit the String(error) branch.
            return Promise.reject('string failure');
          },
        }),
      });
      const err = await custom({ x: 'anything' });
      expect(err.code).toBe('VALIDATION_INVALID_VALUE');
      expect(err.details.expectedType).toContain('string failure');
    });

    it('ignores a non-function validate option', () => {
      // validate present but not a function → no custom validator pushed
      const validators = compile({
        x: field('text', { validate: 'not-a-function' }),
      });
      expect(validators).toHaveLength(0);
    });
  });

  describe('combined fields', () => {
    it('compiles independent validators across many fields', async () => {
      const validators = compile({
        name: field('text', { required: true, maxLength: 10 }),
        age: field('integer', { min: 0, max: 120 }),
        nickname: field('text', { minLength: 2 }),
      });
      // required(name) + maxLength(name) + min(age) + max(age) + minLength(nickname)
      expect(validators).toHaveLength(5);

      const errors = await runAll(validators, {
        name: '',
        age: 200,
        nickname: 'x',
      });
      // missing name (required), age over max, nickname too short
      expect(errors.length).toBe(3);
    });
  });
});
