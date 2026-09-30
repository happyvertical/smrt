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
