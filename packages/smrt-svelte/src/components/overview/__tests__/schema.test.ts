import { describe, expect, it } from 'vitest';
import {
  assertWidgetOptionFields,
  defaultWidgetOptions,
  validateWidgetOptions,
} from '../schema.js';
import { countFields } from './fixtures.js';

describe('validateWidgetOptions', () => {
  it('applies defaults, keeps schema order and drops nothing valid', () => {
    const result = validateWidgetOptions(countFields, {
      model: 'events:Event',
    });
    expect(result).toEqual({
      ok: true,
      options: { model: 'events:Event', measure: 'count' },
    });
  });

  it('reports a missing required field and treats null as missing', () => {
    expect(validateWidgetOptions(countFields, {})).toEqual({
      ok: false,
      issues: [{ key: 'model', code: 'required' }],
    });
    expect(validateWidgetOptions(countFields, { model: null })).toMatchObject({
      ok: false,
    });
  });

  it('rejects unknown keys, wrong types and values outside a closed set', () => {
    const result = validateWidgetOptions(countFields, {
      model: 'events:Event',
      measure: 'drop table',
      limit: 2.5,
      compact: 'yes',
      sql: 'select 1',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual(
      expect.arrayContaining([
        { key: 'sql', code: 'unknown_option' },
        { key: 'measure', code: 'not_in_choices' },
        { key: 'limit', code: 'invalid_type' },
        { key: 'compact', code: 'invalid_type' },
      ]),
    );
  });

  it('bounds numbers and text length', () => {
    expect(
      validateWidgetOptions(countFields, { model: 'A', limit: 21 }),
    ).toMatchObject({
      ok: false,
      issues: [{ key: 'limit', code: 'out_of_range' }],
    });
    expect(
      validateWidgetOptions(countFields, { model: 'A', title: 'x'.repeat(41) }),
    ).toMatchObject({
      ok: false,
      issues: [{ key: 'title', code: 'too_long' }],
    });
  });

  it('only lets a model option be a bare identifier', () => {
    for (const model of [
      'a b',
      "Event'; --",
      '../Event',
      'events:',
      'x'.repeat(200),
    ]) {
      expect(validateWidgetOptions(countFields, { model }).ok).toBe(false);
    }
    for (const model of [
      'Event',
      'events:Event',
      '@happyvertical/events:Event',
    ]) {
      expect(validateWidgetOptions(countFields, { model }).ok).toBe(true);
    }
  });

  it('confines models to the page list', () => {
    const models = ['events:Event'];
    expect(
      validateWidgetOptions(countFields, { model: 'events:Venue' }, { models }),
    ).toEqual({ ok: false, issues: [{ key: 'model', code: 'not_allowed' }] });
    expect(
      validateWidgetOptions(countFields, { model: 'events:Event' }, { models })
        .ok,
    ).toBe(true);
  });

  it('rejects options that are not a plain object', () => {
    expect(validateWidgetOptions(countFields, [])).toMatchObject({ ok: false });
    expect(validateWidgetOptions(countFields, 'x')).toMatchObject({
      ok: false,
    });
  });

  it('treats a cleared select as unset', () => {
    expect(
      validateWidgetOptions(countFields, { model: 'A', measure: '' }),
    ).toEqual({ ok: true, options: { model: 'A', measure: 'count' } });
  });
});

describe('defaultWidgetOptions / assertWidgetOptionFields', () => {
  it('collects defaults', () => {
    expect(defaultWidgetOptions(countFields)).toEqual({ measure: 'count' });
  });

  it('rejects malformed schemas', () => {
    expect(() =>
      assertWidgetOptionFields('x', [
        { key: 'a', type: 'text', label: 'A' },
        { key: 'a', type: 'text', label: 'A' },
      ]),
    ).toThrow(/duplicate/);
    expect(() =>
      assertWidgetOptionFields('x', [
        { key: '__proto__', type: 'text', label: 'A' },
      ]),
    ).toThrow(/invalid option key/);
    expect(() =>
      assertWidgetOptionFields('x', [{ key: 'e', type: 'enum', label: 'E' }]),
    ).toThrow(/choices/);
    expect(() =>
      assertWidgetOptionFields('x', [
        { key: 'n', type: 'integer', label: 'N', max: 3, default: 9 },
      ]),
    ).toThrow(/default/);
  });
});
