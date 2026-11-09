import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { registerRuntimeModel } from '../../runtime-model.js';
import { snapshotObjectRegistryState } from '../../test-utils.js';
import { MCPGenerator } from '../mcp.js';
import { toProviderToolSchema } from '../provider-tool-schema.js';

let restore: () => void;
beforeEach(() => {
  restore = snapshotObjectRegistryState();
});
afterEach(() => restore());

const FORBIDDEN_TOP = ['anyOf', 'oneOf', 'allOf', 'not', 'enum', 'const'];
const walk = (v: unknown, f: (o: Record<string, unknown>) => void): void => {
  if (Array.isArray(v)) {
    for (const x of v) walk(x, f);
  } else if (v && typeof v === 'object') {
    f(v as Record<string, unknown>);
    for (const x of Object.values(v)) walk(x, f);
  }
};

describe('toProviderToolSchema', () => {
  it('makes every generated tool schema acceptable to a provider', async () => {
    registerRuntimeModel({
      name: 'Chore',
      packageName: '@test/provider-schema',
      fields: {
        title: { type: 'text', required: true },
        dueDate: { type: 'datetime' },
        done: { type: 'boolean' },
        points: { type: 'integer' },
      },
      methods: { bump: { parameters: [{ name: 'n', type: 'integer' }] } },
    });
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    const tools = await new MCPGenerator({ name: 't', version: '1' }, {
      db,
      user: { id: 'o', roles: ['admin'] },
    } as never).generateTools();
    const mine = tools.filter((t) => t.name.startsWith('chore_'));
    expect(mine.length).toBeGreaterThan(4);
    // The raw `get` tool is the reported failure: a top-level anyOf.
    const rawGet = mine.find((t) => t.name === 'chore_get');
    expect(Object.keys(rawGet?.inputSchema ?? {})).toContain('anyOf');
    for (const tool of mine) {
      const prepared = toProviderToolSchema(tool.inputSchema);
      expect(prepared.type, tool.name).toBe('object');
      for (const key of FORBIDDEN_TOP)
        expect(Object.keys(prepared), `${tool.name} ${key}`).not.toContain(key);
      walk(prepared, (o) => {
        expect(Object.keys(o), tool.name).not.toContain('$ref');
        expect(Object.keys(o), tool.name).not.toContain('$defs');
        expect(Object.keys(o), tool.name).not.toContain('$schema');
      });
    }
    const get = toProviderToolSchema(rawGet?.inputSchema);
    expect(get.description).toContain('Provide one of: id, slug');
    expect(Object.keys(get.properties as object)).toEqual(['id', 'slug']);
    const create = toProviderToolSchema(
      mine.find((t) => t.name === 'chore_create')?.inputSchema,
    );
    expect(
      (create.properties as Record<string, { type: string }>).title.type,
    ).toBe('string');
    expect(create.required).toEqual(['title']);
  });

  it('inlines refs, breaks cycles and leaves the input untouched', () => {
    const input = {
      type: 'object',
      properties: {
        a: { $ref: '#/$defs/a' },
        loop: { $ref: '#/$defs/node' },
        gone: { $ref: 'https://example.com/x' },
      },
      $defs: {
        a: { type: 'string', description: 'a' },
        node: {
          type: 'object',
          properties: { next: { $ref: '#/$defs/node' } },
        },
      },
      $schema: 'x',
    };
    const copy = structuredClone(input);
    const out = toProviderToolSchema(input) as {
      properties: Record<string, { type?: string; properties?: object }>;
    };
    expect(input).toEqual(copy);
    expect(out.properties.a).toEqual({ type: 'string', description: 'a' });
    expect(out.properties.loop.type).toBe('object');
    expect(JSON.stringify(out)).not.toContain('$ref');
    expect(out.properties.gone).toEqual({});
    expect(toProviderToolSchema(undefined)).toEqual({
      type: 'object',
      properties: {},
    });
  });
});
