import { describe, expect, it } from 'vitest';
import {
  formResourceSelections,
  openAiFormSupport,
  validateOpenAiForm,
  validateOpenAiFormReply,
} from './forms.js';

const schema = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 10 },
    enabled: { type: 'boolean' },
    count: { type: 'integer', minimum: 0, maximum: 4 },
    rating: { type: 'number', minimum: 0, maximum: 1 },
    choice: {
      type: 'string',
      oneOf: [
        {
          const: 'a',
          title: 'A',
          'x-openai-thumbnail': { src: 'https://example.invalid/a.png' },
        },
      ],
    },
    legacy: { type: 'string', enum: ['a', 'b'], enumNames: ['A', 'B'] },
    multiple: { type: 'array', items: { anyOf: [{ const: 'a', title: 'A' }] } },
    enumArray: { type: 'array', items: { type: 'string', enum: ['a'] } },
    strings: {
      type: 'array',
      uniqueItems: true,
      items: { type: 'string', maxLength: 4 },
    },
    resource: {
      type: 'string',
      format: 'uri',
      'x-openai-input': {
        type: 'resource',
        options: [{ uri: 'resource://opaque/a', name: 'A' }],
      },
    },
  },
};
describe('bounded pinned OpenAI forms', () => {
  it('accepts all field unions, exact replies, and detached snapshots', () => {
    const parsed = validateOpenAiForm(schema);
    expect(parsed).toEqual(schema);
    expect(parsed).not.toBe(schema);
    const reply = validateOpenAiFormReply(parsed, {
      action: 'accept',
      content: {
        name: 'Ada',
        enabled: false,
        count: 3,
        rating: 0.5,
        choice: 'a',
        legacy: 'b',
        multiple: ['a'],
        enumArray: ['a'],
        strings: ['hi'],
        resource: 'resource://opaque/a',
      },
    });
    expect(formResourceSelections(parsed, reply)).toEqual([
      'resource://opaque/a',
    ]);
    expect(validateOpenAiFormReply(parsed, { action: 'cancel' })).toEqual({
      action: 'cancel',
    });
    expect(validateOpenAiFormReply(parsed, { action: 'decline' })).toEqual({
      action: 'decline',
    });
  });
  it.each([
    { action: 'unknown' },
    { action: 'cancel', content: {} },
    { action: 'accept' },
    { action: 'accept', content: {} },
    { action: 'accept', content: { name: 'Ada', other: true } },
    { action: 'accept', content: { name: 'Ada', count: 1.5 } },
    { action: 'accept', content: { name: 'Ada', choice: 'b' } },
    { action: 'accept', content: { name: 'Ada', strings: ['x', 'x'] } },
    {
      action: 'accept',
      content: { name: 'Ada', resource: 'resource://opaque/other' },
    },
    { action: 'accept', content: { name: 'a'.repeat(11) } },
    { action: 'accept', content: { name: 'Ada', rating: Infinity } },
  ])('rejects malformed answer %j', (reply) => {
    expect(() => validateOpenAiFormReply(schema, reply)).toThrow();
  });
  it.each([
    { type: 'object', properties: { f: { type: 'object' } } },
    {
      type: 'object',
      properties: { f: { type: 'string', pattern: '(a+)+$' } },
    },
    {
      type: 'object',
      properties: {
        f: {
          type: 'string',
          'x-openai-input': { type: 'unknown', options: [] },
        },
      },
    },
    {
      type: 'object',
      properties: {
        f: {
          type: 'string',
          oneOf: [
            {
              const: 'a',
              title: 'A',
              'x-openai-thumbnail': { src: 'javascript:alert(1)' },
            },
          ],
        },
      },
    },
    { type: 'object', properties: {}, required: ['missing'] },
    { type: 'object', properties: { f: { type: 'string', maxLength: 99999 } } },
    {
      type: 'object',
      properties: { f: { type: 'string', enum: ['a'], default: 'b' } },
    },
    {
      type: 'object',
      properties: {
        f: {
          type: 'array',
          items: { type: 'string', format: 'uri' },
          'x-openai-input': {
            type: 'file',
            options: [],
            selection: 'implicit',
          },
          default: [],
        },
      },
    },
  ])('rejects unsafe schema %j', (value) => {
    expect(() => validateOpenAiForm(value)).toThrow();
  });
  it('rejects prototype keys, accessors, cycles, depth and byte overflows before interpretation', () => {
    expect(() =>
      validateOpenAiForm(
        JSON.parse(
          '{"type":"object","properties":{"__proto__":{"type":"string"}}}',
        ),
      ),
    ).toThrow();
    let called = false;
    const getter = {
      get type() {
        called = true;
        return 'object';
      },
    };
    expect(() => validateOpenAiForm(getter)).toThrow();
    expect(called).toBe(false);
    const cyclic: any = {};
    cyclic.self = cyclic;
    expect(() => validateOpenAiForm(cyclic)).toThrow();
    expect(() =>
      validateOpenAiForm({ ...schema, $schema: 'x'.repeat(70000) }),
    ).toThrow();
  });
  it('retains suggested values as hints and explicit resource rules without granting authority', () => {
    const form = {
      type: 'object',
      properties: {
        hint: {
          type: 'string',
          'x-openai-suggestions': [{ const: 'yes', title: 'Yes' }],
        },
        files: {
          type: 'array',
          items: { type: 'string', format: 'uri' },
          'x-openai-input': {
            type: 'file',
            options: [],
            userOptions: { kind: 'file', accept: ['image/png'] },
            selection: 'explicit',
          },
        },
      },
    };
    const parsed = validateOpenAiForm(form);
    const reply = validateOpenAiFormReply(parsed, {
      action: 'accept',
      content: { hint: 'other', files: ['resource://grant/new'] },
    });
    expect(formResourceSelections(parsed, reply)).toEqual([
      'resource://grant/new',
    ]);
    expect(() =>
      validateOpenAiFormReply(parsed, {
        action: 'accept',
        content: { files: ['file:///private/local'] },
      }),
    ).toThrow();
  });
  it('never advertises native support for absent, unknown, or present capability', () => {
    expect(openAiFormSupport({}).reason).toBe('capability-absent');
    expect(
      openAiFormSupport({ extensions: { 'openai/elicitation': { form: {} } } }),
    ).toEqual({
      mode: 'application-form',
      native: false,
      reason: 'sdk-mrtr-unsupported',
    });
    expect(
      openAiFormSupport({
        extensions: { 'openai/elicitation': { form: true } },
      }).reason,
    ).toBe('capability-unknown');
  });
  it('validates string formats and bounds without defaults or coercion', () => {
    for (const [format, good, bad] of [
      ['date', '2024-02-29', '2024-02-31'],
      ['date-time', '2024-02-29T12:00:00Z', 'today'],
      ['email', 'a@example.invalid', 'bad'],
      ['uri', 'resource://grant/a', 'javascript:alert(1)'],
    ]) {
      const f = {
        type: 'object',
        properties: { v: { type: 'string', format } },
      };
      expect(
        validateOpenAiFormReply(f, { action: 'accept', content: { v: good } }),
      ).toBeDefined();
      expect(() =>
        validateOpenAiFormReply(f, { action: 'accept', content: { v: bad } }),
      ).toThrow();
    }
  });
});

describe('reviewed form input boundaries', () => {
  for (const kind of [
    'index-getter',
    'iterator',
    'hidden-toJSON',
    'hidden-field',
    'array-prototype',
  ]) {
    it(`rejects ${kind} without invoking supplied code`, () => {
      let calls = 0;
      const hook = () => {
        calls++;
        return 'safe';
      };
      const values = ['safe'];
      if (kind === 'index-getter')
        Object.defineProperty(values, '0', { get: hook });
      if (kind === 'iterator')
        Object.defineProperty(values, Symbol.iterator, { value: hook });
      if (kind === 'array-prototype')
        Object.setPrototypeOf(values, { [Symbol.iterator]: hook });
      const input = { action: 'accept', content: { values } };
      if (kind === 'hidden-toJSON')
        Object.defineProperty(input, 'toJSON', { value: hook });
      if (kind === 'hidden-field')
        Object.defineProperty(input.content, 'hidden', { get: hook });
      expect(() =>
        validateOpenAiFormReply(
          {
            type: 'object',
            properties: {
              values: { type: 'array', items: { type: 'string' } },
            },
          },
          input,
        ),
      ).toThrow();
      expect(calls).toBe(0);
    });
  }
  it('rejects inherited serialization hooks without invoking them', () => {
    let calls = 0;
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value: () => {
        calls++;
        return {};
      },
    });
    try {
      let rejected = false;
      try {
        validateOpenAiForm({ type: 'object', properties: {} });
      } catch {
        rejected = true;
      }
      if (!rejected || calls !== 0)
        throw new Error(
          `inherited hook boundary: rejected=${rejected}, calls=${calls}`,
        );
    } finally {
      delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }
  });
  for (const value of [
    '2024-02-31T12:00:00Z',
    '2023-02-29T12:00:00Z',
    '2024-04-31T12:00:00+01:00',
    '2024-01-01T24:00:00Z',
    '2024-01-01T12:60:00Z',
    '2024-01-01T12:00:60Z',
    '2024-01-01T12:00:00+24:00',
    '2024-01-01T12:00:00+01:60',
  ]) {
    it(`rejects invalid calendar/time ${value}`, () => {
      expect(() =>
        validateOpenAiFormReply(
          {
            type: 'object',
            properties: { timestamp: { type: 'string', format: 'date-time' } },
          },
          { action: 'accept', content: { timestamp: value } },
        ),
      ).toThrow();
    });
  }
  for (const value of [
    '2024-02-29T23:59:59Z',
    '2024-03-01T00:30:00+01:00',
    '2024-02-29T23:30:00.123-02:00',
  ]) {
    it(`preserves valid calendar timestamp ${value}`, () => {
      expect(
        validateOpenAiFormReply(
          {
            type: 'object',
            properties: { timestamp: { type: 'string', format: 'date-time' } },
          },
          { action: 'accept', content: { timestamp: value } },
        ),
      ).toEqual({ action: 'accept', content: { timestamp: value } });
    });
  }
});

it('enforces aggregate byte bounds while allowing bounded multi-item content', () => {
  const form = {
    type: 'object',
    properties: { values: { type: 'array', items: { type: 'string' } } },
  };
  expect(
    validateOpenAiFormReply(form, {
      action: 'accept',
      content: { values: ['a'.repeat(3000), 'b'.repeat(3000)] },
    }),
  ).toEqual({
    action: 'accept',
    content: { values: ['a'.repeat(3000), 'b'.repeat(3000)] },
  });
  expect(() =>
    validateOpenAiFormReply(form, {
      action: 'accept',
      content: { values: Array(20).fill('x'.repeat(4096)) },
    }),
  ).toThrow();
});
it('rejects schema array accessors and array inherited toJSON without callbacks', () => {
  let calls = 0;
  const values = ['one'];
  Object.defineProperty(values, '0', {
    get: () => {
      calls++;
      return 'one';
    },
  });
  expect(() =>
    validateOpenAiForm({
      type: 'object',
      properties: { choice: { type: 'string', enum: values } },
    }),
  ).toThrow();
  expect(calls).toBe(0);
  Object.defineProperty(Array.prototype, 'toJSON', {
    configurable: true,
    value: () => {
      calls++;
      return [];
    },
  });
  try {
    let rejected = false;
    try {
      validateOpenAiFormReply(
        { type: 'object', properties: {} },
        { action: 'cancel' },
      );
    } catch {
      rejected = true;
    }
    if (!rejected || calls !== 0)
      throw new Error('Inherited array serialization hook was not inert');
  } finally {
    delete (Array.prototype as unknown as { toJSON?: unknown }).toJSON;
  }
});
