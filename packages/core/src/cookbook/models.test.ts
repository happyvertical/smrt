import { readFileSync } from 'node:fs';
import type { Cookbook } from '@happyvertical/smrt-types';
import Ajv from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { createCookbookEngine } from './engine/engine.js';
import { COOKBOOK_SCHEMA_URL, validateCookbook } from './validate.js';

const doc: Cookbook = {
  $schema: COOKBOOK_SCHEMA_URL,
  version: 1,
  recipes: [],
  features: ['@fixture/models:LoanerMat'],
  policies: [],
  models: {
    version: 1,
    packageName: '@fixture/models',
    fields: {},
    lists: {
      LoanerMat: {
        label: 'Mats',
        icon: 'layers',
        displayField: 'size',
        fields: {
          size: { type: 'text' },
          fee: { type: 'money', currency: 'CAD' },
          condition: { type: 'choice', choices: ['new', 'used'] },
        },
      },
    },
  },
};
const schema = new Ajv({ strict: true }).compile(
  JSON.parse(
    readFileSync(new URL('./v1.schema.json', import.meta.url), 'utf8'),
  ),
);
describe('cookbook app model contract', () => {
  it('validates with JSON Schema and reader and survives engine export/import and recovery', () => {
    expect(schema(doc), JSON.stringify(schema.errors)).toBe(true);
    expect(validateCookbook(doc).ok).toBe(true);
    const catalog = { recipes: [], models: [] };
    const engine = createCookbookEngine({ catalog, cookbook: doc });
    expect(engine.snapshot().features).toContain('@fixture/models:LoanerMat');
    expect(engine.snapshot().sections[0].items[0]).toMatchObject({
      label: 'Mats',
      icon: 'layers',
    });
    const result = engine.run({
      name: 'set_policy',
      input: {
        model: '@fixture/models:LoanerMat',
        field: 'size',
        label: 'Mat size',
      },
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const imported = createCookbookEngine({ catalog });
    expect(
      imported.run({
        name: 'import_cookbook',
        input: { document: engine.cookbook() },
      }).ok,
    ).toBe(true);
    expect(imported.cookbook()).toEqual(engine.cookbook());
    expect(
      createCookbookEngine({ catalog, state: imported.state() }).cookbook(),
    ).toEqual(engine.cookbook());
  });
  it.each([
    { version: 2 },
    { packageName: 'app' },
    { lists: [] },
    { fields: [] },
    { lists: { bad_name: {} } },
    {
      lists: {
        LoanerMat: {
          label: '',
          icon: '<svg>',
          displayField: 'missing',
          fields: {},
        },
      },
    },
    { fields: { '@fixture/models:Thing': { save: { type: 'text' } } } },
    { fields: { '@fixture/models:Thing': { choice: { type: 'choice' } } } },
    {
      fields: {
        '@fixture/models:Thing': { fee: { type: 'money', currency: 'cad' } },
      },
    },
    { fields: { '@fixture/models:Thing': { ref: { type: 'reference' } } } },
    {
      fields: {
        '@fixture/models:Thing': {
          text: { type: 'text', label: 'Do not duplicate policies' },
        },
      },
    },
  ])('rejects malformed model definitions: %j', (patch) => {
    const value = { ...doc, models: { ...doc.models, ...patch } };
    expect(validateCookbook(value).ok).toBe(false);
    expect(schema(value)).toBe(false);
  });
  it('keeps legacy cookbooks unchanged and treats models as non-empty for replacement', () => {
    const legacy = {
      $schema: COOKBOOK_SCHEMA_URL,
      version: 1,
      recipes: [],
      features: [],
      policies: [],
    };
    expect(validateCookbook(legacy)).toMatchObject({
      ok: true,
      cookbook: legacy,
    });
    expect(
      createCookbookEngine({
        catalog: { recipes: [], models: [] },
        cookbook: doc,
      }).run({ name: 'import_cookbook', input: { document: legacy } }),
    ).toMatchObject({ ok: false, error: { code: 'confirmation_required' } });
  });
});
