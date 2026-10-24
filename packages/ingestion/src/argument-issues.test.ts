import { describe, expect, it } from 'vitest';
import {
  describeArgumentRefusal,
  HANDLER_ARGUMENT_ISSUE_LIMIT,
  HANDLER_ARGUMENT_PATH_LIMIT,
  handlerArgumentIssues,
} from './argument-issues.js';

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
  it('bounds the issue count and path length and drops unsafe keywords', () => {
    const errors = Array.from({ length: 500 }, (_, index) => ({
      instancePath: `/items/${index}`,
      keyword: 'type',
      schemaPath: '#/properties/items/items/type',
      params: { type: 'integer' },
    }));
    const instance = { items: Array.from({ length: 500 }, () => 'x') };
    expect(handlerArgumentIssues(errors, schema, instance)).toHaveLength(
      HANDLER_ARGUMENT_ISSUE_LIMIT,
    );
    const deep = {
      type: 'object',
      properties: { ['a'.repeat(400)]: { type: 'string' } },
    };
    const [long] = handlerArgumentIssues(
      [
        {
          instancePath: `/${'a'.repeat(400)}`,
          keyword: 'type ignored; DROP',
          schemaPath: '#',
          params: {},
        },
      ],
      deep,
      {},
    );
    expect(long.path).toHaveLength(HANDLER_ARGUMENT_PATH_LIMIT);
    expect(long).not.toHaveProperty('keyword');
  });
  it('returns no issues when the arguments are valid or the schema cannot compile', () => {
    expect(describeArgumentRefusal(schema, { title: 'Fine' })).toEqual([]);
    expect(describeArgumentRefusal({ type: 'nonsense' }, {})).toEqual([]);
  });
});
