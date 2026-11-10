import { describe, expect, it } from 'vitest';
import {
  changedFields,
  coerceInput,
  fieldLabel,
  fieldOfError,
  formFields,
  humanize,
  initialValues,
  inputKind,
  methodToolName,
  recordLabel,
  serializeForm,
  stripFieldPrefix,
} from './fields.ts';
import type { FieldDef, RecordRow } from './types.ts';

const fields: Record<string, FieldDef> = {
  title: { type: 'text', required: true },
  qty: { type: 'integer' },
  weight: { type: 'number' },
  price: { type: 'money' },
  done: { type: 'boolean' },
  due: { type: 'date', label: 'Due on' },
  kind: { type: 'choice', choices: ['home', 'work'] },
  owner: { type: 'reference', ref: 'Person' },
  extra: { type: 'json' },
};

describe('field mapping', () => {
  it('maps each field type to an input kind', () => {
    const kinds = Object.fromEntries(
      Object.entries(fields).map(([k, d]) => [k, inputKind(d)]),
    );
    expect(kinds).toEqual({
      title: 'text',
      qty: 'integer',
      weight: 'number',
      price: 'money',
      done: 'checkbox',
      due: 'date',
      kind: 'select',
      owner: 'reference',
      extra: 'json',
    });
  });

  it('labels from the label or the humanized name', () => {
    expect(humanize('dueDate')).toBe('Due date');
    expect(fieldLabel('due', fields.due)).toBe('Due on');
    expect(fieldLabel('qty', fields.qty)).toBe('Qty');
  });

  it('lists form fields in order and skips hidden ones', () => {
    const specs = formFields({
      fields: { a: { type: 'text' }, b: { type: 'text', hidden: true } },
    });
    expect(specs.map((s) => s.name)).toEqual(['a']);
    expect(specs[0].required).toBe(false);
  });
});

describe('values', () => {
  const record = {
    id: 'r1',
    title: 'Mop',
    qty: 3,
    price: 1250,
    done: 1,
    due: '2026-03-04T00:00:00.000Z',
    extra: '{"a":1}',
    kind: null,
  } as unknown as RecordRow;

  it('reads a record into form values', () => {
    const v = initialValues(fields, record);
    expect(v.title).toBe('Mop');
    expect(v.qty).toBe('3');
    expect(v.price).toBe('12.50');
    expect(v.done).toBe(true);
    expect(v.due).toBe('2026-03-04');
    expect(v.extra).toBe('{\n  "a": 1\n}');
    expect(v.kind).toBe('');
  });

  it('starts empty for a new record', () => {
    const v = initialValues(fields, null);
    expect(v.title).toBe('');
    expect(v.done).toBe(false);
  });

  it('serializes values with money in minor units', () => {
    const { data, errors } = serializeForm(fields, {
      title: 'Mop',
      qty: '4',
      weight: '2.5',
      price: '12.50',
      done: true,
      due: '2026-03-04',
      kind: 'home',
      owner: 'p1',
      extra: '{"a":[1]}',
    });
    expect(errors).toEqual({});
    expect(data).toEqual({
      title: 'Mop',
      qty: 4,
      weight: 2.5,
      price: 1250,
      done: true,
      due: '2026-03-04',
      kind: 'home',
      owner: 'p1',
      extra: { a: [1] },
    });
  });

  it('reports required, number, choice, json and money problems', () => {
    const { errors } = serializeForm(fields, {
      title: '  ',
      qty: '1.5',
      weight: 'abc',
      price: '12.345',
      done: false,
      due: '',
      kind: 'play',
      owner: '',
      extra: '{oops',
    });
    expect(Object.keys(errors).sort()).toEqual(
      ['extra', 'kind', 'price', 'qty', 'title', 'weight'].sort(),
    );
    expect(errors.title).toMatch(/required/);
  });

  it('sends empty optional fields as null so they can be cleared', () => {
    expect(coerceInput({ type: 'text' }, '')).toEqual({
      ok: true,
      value: null,
    });
    expect(coerceInput({ type: 'boolean' }, false)).toEqual({
      ok: true,
      value: false,
    });
  });

  it('keeps text exactly as typed', () => {
    expect(coerceInput({ type: 'text' }, ' hi ')).toEqual({
      ok: true,
      value: ' hi ',
    });
  });

  it('serializes only the changed fields on update', () => {
    const record = { id: 'r', title: 'A', qty: 1 } as unknown as RecordRow;
    const small = { title: fields.title, qty: fields.qty };
    const values = { title: 'B', qty: '1' };
    const changed = changedFields(small, values, record);
    expect(changed).toEqual(['title']);
    expect(serializeForm(small, values, changed).data).toEqual({ title: 'B' });
  });
});

describe('server errors', () => {
  it('finds the field a server message is about', () => {
    const names = Object.keys(fields);
    expect(fieldOfError('Chore.qty must be a number', 'Chore', names)).toBe(
      'qty',
    );
    expect(
      fieldOfError("Chore has no field 'zzz' (fields: a)", 'Chore', ['zzz']),
    ).toBe('zzz');
    expect(fieldOfError('something else', 'Chore', names)).toBeNull();
    expect(stripFieldPrefix('Chore.qty must be a number', 'Chore')).toBe(
      'must be a number',
    );
  });
});

describe('labels', () => {
  it('uses the first text value, else a short id', () => {
    const model = { fields };
    expect(
      recordLabel(model, { id: 'abcdefghijkl', title: 'Mop' } as RecordRow),
    ).toBe('Mop');
    expect(recordLabel(model, { id: 'abcdefghijkl' } as RecordRow)).toBe(
      'abcdefgh…',
    );
  });

  it('names the generated tool of a method', () => {
    expect(methodToolName('Chore', 'complete')).toBe('chore_complete');
  });
});
