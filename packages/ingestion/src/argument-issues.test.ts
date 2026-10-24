import type { ErrorObject } from 'ajv';
import { describe, expect, it } from 'vitest';
import {
  describeArgumentRefusal,
  handlerArgumentIssues,
} from './argument-issues.js';
import { HandlerArgumentsInvalidError } from './proposal-errors.js';

function error(instancePath: string, keyword = 'type'): ErrorObject {
  return { instancePath, keyword, schemaPath: '#', params: {} };
}

describe('value-free handler argument issues (#4281)', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['title'],
    properties: {
      title: { type: 'string', minLength: 1 },
      lines: {
        type: 'object',
        additionalProperties: { type: 'number' },
      },
      items: { type: 'array', items: { type: 'integer' } },
    },
  };
  it('names schema-owned paths and keywords, never data keys or values', () => {
    const secret = 'Invoice 4417002231 for Acme';
    const issues = describeArgumentRefusal(schema, {
      title: 7,
      lines: { [secret]: secret },
      items: [1, secret],
      [secret]: secret,
    });
    // `/` is the whole arguments object, not RFC 6901's key "".
    expect(issues).toEqual([
      { path: '/', keyword: 'additionalProperties' },
      { path: '/title', keyword: 'type' },
      { path: '/lines/?', keyword: 'type' },
      { path: '/items/1', keyword: 'type' },
    ]);
    expect(JSON.stringify(issues)).not.toMatch(/4417|Acme|Invoice/);
    expect(Object.isFrozen(issues)).toBe(true);
    expect(issues.every(Object.isFrozen)).toBe(true);
  });
  it('names a missing required field under the root without a double slash', () => {
    expect(describeArgumentRefusal(schema, {})).toEqual([
      { path: '/title', keyword: 'required' },
    ]);
  });
  it('treats inherited names such as toString and constructor as data keys', () => {
    // `Object.hasOwn`, not `in`: prototype names are not declared properties.
    expect(
      describeArgumentRefusal(schema, {
        title: 'Fine',
        lines: { toString: 'x', constructor: 'y', __proto__: 'z' },
      }),
    ).toEqual([{ path: '/lines/?', keyword: 'type' }]);
    expect(
      handlerArgumentIssues(
        [error('/toString'), error('/constructor/0')],
        schema,
        { toString: 1, constructor: [1] },
      ),
    ).toEqual([
      { path: '/?', keyword: 'type' },
      // A real array index under a data key stays; the key itself is hidden.
      { path: '/?/0', keyword: 'type' },
    ]);
  });
  it('keeps a numeric segment only when the instance really holds an array there', () => {
    const union = {
      type: 'object',
      properties: {
        items: {
          anyOf: [
            { type: 'array', items: { type: 'integer' } },
            { type: 'object', additionalProperties: { type: 'integer' } },
          ],
        },
      },
    };
    expect(
      handlerArgumentIssues([error('/items/4417002231')], union, {
        items: { '4417002231': 'x' },
      }),
    ).toEqual([{ path: '/items/?', keyword: 'type' }]);
    expect(
      handlerArgumentIssues([error('/items/0')], union, { items: ['x'] }),
    ).toEqual([{ path: '/items/0', keyword: 'type' }]);
  });
  it('dedupes by path and keyword', () => {
    expect(
      handlerArgumentIssues(
        [
          error('/title'),
          error('/title'),
          error('/title', 'minLength'),
          error('/title', 'type'),
        ],
        schema,
        { title: 7 },
      ),
    ).toEqual([
      { path: '/title', keyword: 'type' },
      { path: '/title', keyword: 'minLength' },
    ]);
  });
  it('returns exactly 20 issues at most', () => {
    const instance = { items: Array.from({ length: 500 }, () => 'x') };
    const errors = instance.items.map((_, index) => error(`/items/${index}`));
    const issues = handlerArgumentIssues(errors, schema, instance);
    expect(issues).toHaveLength(20);
    expect(issues.at(-1)).toEqual({ path: '/items/19', keyword: 'type' });
  });
  it('examines at most 200 Ajv errors, duplicates included', () => {
    const instance = { items: Array.from({ length: 300 }, () => 'x') };
    // 199 duplicates, then distinct errors at positions 200 and 201.
    const errors = [
      ...Array.from({ length: 199 }, () => error('/items/0')),
      error('/items/1'),
      error('/items/2'),
    ];
    expect(handlerArgumentIssues(errors, schema, instance)).toEqual([
      { path: '/items/0', keyword: 'type' },
      { path: '/items/1', keyword: 'type' },
    ]);
  });
  it('cuts paths at exactly 160 characters and drops unsafe keywords', () => {
    const key = 'a'.repeat(400);
    const deep = { type: 'object', properties: { [key]: { type: 'string' } } };
    const [long] = handlerArgumentIssues(
      [error(`/${key}`, 'type ignored; DROP')],
      deep,
      {},
    );
    expect(long.path).toHaveLength(160);
    expect(long.path).toBe(`/${'a'.repeat(159)}`);
    expect(long).not.toHaveProperty('keyword');
  });
  it('escapes schema-owned segments per RFC 6901 and keeps ? and the root /', () => {
    const escaped = {
      type: 'object',
      additionalProperties: false,
      required: ['a/b'],
      properties: {
        'a/b': { type: 'string' },
        vendor: {
          type: 'object',
          required: ['x~y'],
          properties: {
            'a/b~c': { type: 'string' },
            'x~y': { type: 'string' },
          },
          additionalProperties: { type: 'string' },
        },
      },
    };
    expect(
      describeArgumentRefusal(escaped, {
        vendor: { 'a/b~c': 7, 'data/key~1': 7 },
        'extra/key': 1,
      }),
    ).toEqual([
      { path: '/a~1b', keyword: 'required' },
      { path: '/', keyword: 'additionalProperties' },
      { path: '/vendor/x~0y', keyword: 'required' },
      { path: '/vendor/?', keyword: 'type' },
      { path: '/vendor/a~1b~0c', keyword: 'type' },
    ]);
  });
  it('cuts a 161-character path to 160 without splitting an escape', () => {
    const key = 'a'.repeat(160);
    const deep = { type: 'object', properties: { [key]: { type: 'string' } } };
    const [cut] = handlerArgumentIssues([error(`/${key}`)], deep, {});
    expect(`/${key}`).toHaveLength(161);
    expect(cut.path).toBe(`/${'a'.repeat(159)}`);
    const tilde = `${'a'.repeat(158)}~`;
    const escapedDeep = {
      type: 'object',
      properties: { [tilde]: { type: 'string' } },
    };
    const [split] = handlerArgumentIssues(
      [error(`/${tilde.replace('~', '~0')}`)],
      escapedDeep,
      {},
    );
    // `/` + 158 `a` + `~0` is 161 characters; the cut drops the lone `~`.
    expect(split.path).toBe(`/${'a'.repeat(158)}`);
  });
  it('omits issues on the error when none are known', () => {
    expect(new HandlerArgumentsInvalidError('x').issues).toBeUndefined();
    expect(new HandlerArgumentsInvalidError('x', []).issues).toBeUndefined();
    expect(
      new HandlerArgumentsInvalidError('x', [{ path: '/title' }]).issues,
    ).toEqual([{ path: '/title' }]);
  });
  it('returns no issues when the arguments are valid or the schema cannot compile', () => {
    expect(describeArgumentRefusal(schema, { title: 'Fine' })).toEqual([]);
    expect(describeArgumentRefusal({ type: 'nonsense' }, {})).toEqual([]);
  });
});
