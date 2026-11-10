import { describe, expect, it } from 'vitest';
import {
  type AppDefinition,
  EMPTY_APP,
  MemoryVersionStore,
  refuseChanges,
  type VersionRecord,
  validate,
} from './index.ts';

const app = (
  models: AppDefinition['models'],
  recipes: string[] = [],
): AppDefinition => ({
  ...EMPTY_APP,
  recipes,
  models,
});

describe('validate', () => {
  it('accepts a good definition and the empty app', () => {
    expect(validate(EMPTY_APP)).toEqual([]);
    expect(
      validate(
        app({
          Chore: {
            fields: {
              title: { type: 'text', required: true },
              kind: { type: 'choice', choices: ['a', 'b'] },
              who: { type: 'reference', ref: 'Person' },
            },
            methods: {
              done: {
                description: 'd',
                code: 'return 1',
                params: { x: { type: 'text' } },
              },
            },
          },
          Person: { fields: {} },
        }),
      ),
    ).toEqual([]);
  });

  it('rejects unknown formats and non-objects', () => {
    expect(validate({ ...EMPTY_APP, format: 2 })).toEqual([
      expect.stringMatching(/format/),
    ]);
    expect(validate(null)).not.toEqual([]);
    expect(
      validate({ format: 1, name: 'x', recipes: [], models: [] }),
    ).not.toEqual([]);
  });

  it('rejects bad names, reserved words, unknown types and bad references', () => {
    const errs = validate(
      app({
        chore: { fields: {} },
        Chore: {
          fields: {
            Title: { type: 'text' },
            id: { type: 'text' },
            constructor: { type: 'text' as never },
            kind: { type: 'choice' as never },
            ref: { type: 'reference', ref: 'Missing' },
            odd: { type: 'weird' as never },
            aBC: { type: 'text' },
          },
          methods: {
            kind: { description: 'd', code: '1' },
            delete: { description: 'd', code: '1' },
          },
        },
      }),
    );
    const text = errs.join('\n');
    expect(text).toMatch(/chore: model names/);
    expect(text).toMatch(/Chore.Title/);
    expect(text).toMatch(/Chore.id: reserved/);
    expect(text).toMatch(/Chore.constructor/);
    expect(text).toMatch(/kind: choice needs choices/);
    expect(text).toMatch(/ref: reference needs ref/);
    expect(text).toMatch(/odd: unknown type/);
    expect(text).toMatch(/aBC/);
    expect(text).toMatch(/kind\(\): clashes/);
    expect(text).toMatch(/delete\(\): 'delete' is a reserved name/);
  });

  it('keeps recipe models consistent with recipes', () => {
    expect(validate(app({ Profile: { fields: {} } }))).toEqual([
      expect.stringMatching(/reserved for a recipe/),
    ]);
    expect(validate({ ...EMPTY_APP, recipes: ['nope'] })).toEqual([
      expect.stringMatching(/unknown recipe/),
    ]);
    expect(validate({ ...EMPTY_APP, recipes: ['profiles'] }).join()).toMatch(
      /needs the app model Profile/,
    );
    const good = app(
      {
        Profile: {
          extends: '@happyvertical/smrt-profiles:Profile',
          fields: { nick: { type: 'text' } },
        },
      },
      ['profiles'],
    );
    expect(validate(good)).toEqual([]);
    const clash = app(
      {
        Profile: {
          extends: '@happyvertical/smrt-profiles:Profile',
          fields: { email: { type: 'text' } },
        },
      },
      ['profiles'],
    );
    expect(validate(clash).join()).toMatch(/built in/);
  });

  it('refuseChanges asks for changeFieldType when the storage type changes', () => {
    const a = app({ M: { fields: { f: { type: 'text' } } } });
    const b = app({ M: { fields: { f: { type: 'integer' } } } });
    expect(refuseChanges(a, b)).toEqual([
      expect.stringMatching(/changeFieldType/),
    ]);
    expect(refuseChanges(a, b, new Set(['M.f']))).toEqual([]);
  });
});

describe('MemoryVersionStore', () => {
  it('holds versions, the current pointer and purge marks', async () => {
    const s = new MemoryVersionStore();
    expect(await s.current()).toBeNull();
    expect(await s.maxVersion()).toBe(-1);
    await s.append({
      version: 0,
      parent: null,
      author: 'a',
      summary: 's',
      definition: EMPTY_APP,
      migration: { steps: [] },
      createdAt: 'now',
    });
    await s.setCurrent(0);
    await s.markPurged(0);
    expect((await s.get(0))?.migration?.purged).toBe(true);
    expect(await s.maxVersion()).toBe(0);
    expect(await s.list()).toHaveLength(1);
    await expect(
      s.append({ ...((await s.get(0)) as VersionRecord) }),
    ).rejects.toThrow(/already exists/);
  });
});

describe('method parameters in the generated tool schema', () => {
  it('declares wire types, not storage types', async () => {
    const { toRuntimeModel, runtimeType } = await import('./definition.ts');
    expect(runtimeType('integer')).toBe('integer');
    const { runtimeModelEntry } = await import('@happyvertical/smrt-core');
    const entry = runtimeModelEntry(
      toRuntimeModel('Chore', {
        fields: {},
        methods: {
          log: {
            description: 'log',
            code: 'return 1',
            params: {
              count: { type: 'integer' },
              ratio: { type: 'number' },
              done: { type: 'boolean' },
              note: { type: 'text' },
              extra: { type: 'json' },
            },
          },
        },
      } as never),
    );
    const types = Object.fromEntries(
      (entry.methods.log.parameters as { name: string; type: string }[]).map(
        (p) => [p.name, p.type],
      ),
    );
    expect(types).toEqual({
      count: 'number',
      ratio: 'number',
      done: 'boolean',
      note: 'string',
      extra: 'object',
    });
  });
});
