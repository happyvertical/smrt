import { describe, expect, it } from 'vitest';
import { deriveScreenFields } from '../fields.js';
import {
  compareScreenValues,
  currencyMinorDigits,
  draftForCreate,
  draftFromRecord,
  formatScreenValue,
  majorStringToMinorUnits,
  minorUnitsToMajorString,
  parseDraft,
  toDatetimeLocal,
} from '../values.js';
import { taskDefinition, taskPolicy, taskRows } from './fixtures.js';

const editFields = deriveScreenFields(taskDefinition, taskPolicy, {
  mode: 'edit',
});

describe('money minor units', () => {
  it('converts exactly, without float arithmetic', () => {
    expect(minorUnitsToMajorString(125050, 2)).toBe('1250.50');
    expect(minorUnitsToMajorString(5, 2)).toBe('0.05');
    expect(minorUnitsToMajorString(-5, 2)).toBe('-0.05');
    expect(minorUnitsToMajorString(100, 0)).toBe('100');
    expect(minorUnitsToMajorString(1.5, 2)).toBeNull();
    expect(minorUnitsToMajorString(Number.MAX_SAFE_INTEGER + 2, 2)).toBeNull();

    expect(majorStringToMinorUnits('1250.50', 2)).toBe(125050);
    expect(majorStringToMinorUnits('1,250.5', 2)).toBe(125050);
    expect(majorStringToMinorUnits('0.07', 2)).toBe(7);
    // 19.99 * 100 is 1998.9999999999998 in floating point.
    expect(majorStringToMinorUnits('19.99', 2)).toBe(1999);
    expect(majorStringToMinorUnits('-3', 2)).toBe(-300);
    expect(majorStringToMinorUnits('12', 0)).toBe(12);
  });

  it('rejects malformed, over-precise and unsafe amounts', () => {
    expect(majorStringToMinorUnits('1.234', 2)).toBeNull();
    expect(majorStringToMinorUnits('abc', 2)).toBeNull();
    expect(majorStringToMinorUnits('1.5', 0)).toBeNull();
    expect(majorStringToMinorUnits('90071992547409.93', 2)).toBeNull();
  });

  it('knows currency minor-unit digits', () => {
    expect(currencyMinorDigits('usd')).toBe(2);
    expect(currencyMinorDigits('JPY')).toBe(0);
    expect(currencyMinorDigits('KWD')).toBe(3);
    expect(currencyMinorDigits('ZZZ')).toBe(2);
  });
});

describe('drafts', () => {
  it('draftFromRecord renders each kind as its control value', () => {
    const draft = draftFromRecord(editFields, taskRows[0]);
    expect(draft.title).toBe('Write docs');
    expect(draft.budget).toBe('1250.50');
    expect(draft.priority).toBe('2');
    expect(draft.done).toBe(false);
    expect(draft.dueAt).toMatch(/^2026-10-(09|10)T\d\d:\d\d$/);
    expect(draft.ownerId).toBe('0b0c7b5e-0000-4000-8000-000000000001');
  });

  it('draftForCreate prefers a resolved policy default over the manifest default', () => {
    const draft = draftForCreate(editFields, taskPolicy);
    // policy default 5 beats manifest default 3
    expect(draft.priority).toBe('5');
    expect(draft.done).toBe(false);
    expect(draft.title).toBe('');
    // without a policy the manifest default applies
    const seeded = draftForCreate(editFields, null);
    expect(seeded.priority).toBe('3');
  });

  it('an explicit null policy default overrides a manifest default', () => {
    const draft = draftForCreate(editFields, {
      ...taskPolicy,
      fields: {
        ...taskPolicy.fields,
        priority: { visibility: 'basic', hasDefault: true, defaultValue: null },
      },
    });
    expect(draft.priority).toBe('');
  });

  it('toDatetimeLocal tolerates junk', () => {
    expect(toDatetimeLocal('nope')).toBe('');
    expect(toDatetimeLocal(null)).toBe('');
  });
});

describe('parseDraft', () => {
  const base = () => draftFromRecord(editFields, taskRows[0]);

  it('produces wire values: safe integers, minor units, ISO datetimes, parsed JSON', () => {
    const draft = {
      ...base(),
      priority: '7',
      budget: '19.99',
      payload: '{"a":1}',
      dueAt: '2026-10-09T08:15',
    };
    const { values, errors } = parseDraft(editFields, draft);
    expect(errors).toEqual({});
    expect(values.priority).toBe(7);
    expect(values.budget).toBe(1999);
    expect(values.payload).toEqual({ a: 1 });
    expect(values.dueAt).toBe(new Date('2026-10-09T08:15').toISOString());
    expect(values.done).toBe(false);
  });

  it('flags required, malformed and unsafe values with codes', () => {
    const { errors } = parseDraft(editFields, {
      ...base(),
      title: '   ',
      priority: '1.5',
      budget: '1.234',
      payload: '{nope',
    });
    expect(errors).toEqual({
      title: 'required',
      priority: 'invalid_integer',
      budget: 'invalid_money',
      payload: 'invalid_json',
    });
    expect(
      parseDraft(editFields, { ...base(), priority: '9007199254740993' }).errors
        .priority,
    ).toBe('invalid_integer');
    expect(
      parseDraft(editFields, { ...base(), dueAt: 'tomorrow-ish' }).errors.dueAt,
    ).toBe('invalid_datetime');
  });

  it('clears an empty optional field to null (text to empty string unless nullable)', () => {
    const { values } = parseDraft(editFields, {
      ...base(),
      budget: '',
      dueAt: '',
      notes: '',
      payload: '',
    });
    expect(values.budget).toBeNull();
    expect(values.dueAt).toBeNull();
    expect(values.payload).toBeNull();
    // `notes` is non-nullable text: unset text persists as ''.
    expect(values.notes).toBe('');
  });

  it('keeps full datetime precision when the control text is unchanged', () => {
    const record = { ...taskRows[0], dueAt: '2026-10-09T12:30:45.123Z' };
    const unchanged = draftFromRecord(editFields, record);
    const saved = parseDraft(
      editFields,
      { ...unchanged, title: 'Renamed' },
      { record },
    );
    expect(saved.errors).toEqual({});
    expect(saved.values.dueAt).toBe('2026-10-09T12:30:45.123Z');
    // Without the loaded record the minute-precision text is all there is.
    expect(parseDraft(editFields, unchanged).values.dueAt).toBe(
      new Date(toDatetimeLocal(record.dueAt)).toISOString(),
    );
    // A Date-valued record keeps its precision too.
    const dated = { ...record, dueAt: new Date('2026-10-09T12:30:45.123Z') };
    expect(
      parseDraft(editFields, draftFromRecord(editFields, dated), {
        record: dated,
      }).values.dueAt,
    ).toBe('2026-10-09T12:30:45.123Z');
  });

  it('saves an edited datetime as the new value', () => {
    const record = { ...taskRows[0], dueAt: '2026-10-09T12:30:45.123Z' };
    const draft = {
      ...draftFromRecord(editFields, record),
      dueAt: '2026-11-01T09:05',
    };
    expect(parseDraft(editFields, draft, { record }).values.dueAt).toBe(
      new Date('2026-11-01T09:05').toISOString(),
    );
  });

  it('respects the currency minor-unit digits', () => {
    expect(
      parseDraft(editFields, { ...base(), budget: '1250' }, { currency: 'JPY' })
        .values.budget,
    ).toBe(1250);
  });
});

describe('formatScreenValue', () => {
  const kind = (name: string) =>
    editFields.find((f) => f.name === name) ?? { kind: 'text' as const };

  it('formats each kind for display', () => {
    expect(formatScreenValue(kind('budget'), 125050, { locale: 'en-US' })).toBe(
      '$1,250.50',
    );
    expect(
      formatScreenValue(kind('budget'), 125050, {
        locale: 'en-US',
        currency: 'JPY',
      }),
    ).toBe('¥125,050');
    expect(formatScreenValue(kind('priority'), 1234, { locale: 'en-US' })).toBe(
      '1,234',
    );
    expect(
      formatScreenValue(kind('done'), true, { yes: 'Oui', no: 'Non' }),
    ).toBe('Oui');
    expect(formatScreenValue(kind('done'), false)).toBe('No');
    expect(formatScreenValue(kind('done'), null)).toBe('');
    expect(
      formatScreenValue(kind('dueAt'), '2026-10-09T12:30:00.000Z', {
        locale: 'en-US',
        timeZone: 'UTC',
      }),
    ).toBe('Oct 9, 2026, 12:30 PM');
    expect(formatScreenValue(kind('payload'), { a: 1 })).toBe('{"a":1}');
    expect(formatScreenValue(kind('title'), null)).toBe('');
  });

  it('never throws on an unsupported currency or a bad date', () => {
    expect(formatScreenValue(kind('budget'), 100, { currency: 'zz' })).toBe(
      '100',
    );
    expect(formatScreenValue(kind('dueAt'), 'soon')).toBe('soon');
  });
});

describe('compareScreenValues', () => {
  it('orders numbers numerically and keeps empties last in both directions', () => {
    expect(compareScreenValues(2, 10, 'asc')).toBeLessThan(0);
    expect(compareScreenValues(2, 10, 'desc')).toBeGreaterThan(0);
    expect(compareScreenValues(null, 3, 'asc')).toBeGreaterThan(0);
    expect(compareScreenValues(null, 3, 'desc')).toBeGreaterThan(0);
    expect(compareScreenValues('a', 'b', null)).toBe(0);
  });
});
