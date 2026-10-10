import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import {
  COOKBOOK_LEGACY_SCHEMA_URL,
  COOKBOOK_SCHEMA_URL,
  parseCookbookText,
  validateCookbook,
} from './index.js';

const dir = join(import.meta.dirname, '__fixtures__');
const fixtures = readdirSync(dir).filter((f) => f.endsWith('.cookbook.json'));
const schema = JSON.parse(
  readFileSync(join(import.meta.dirname, 'v1.schema.json'), 'utf8'),
);
const ajv = new Ajv2020({ strict: true });
const matches = ajv.compile(schema);

describe('cookbook v1', () => {
  it('has the four library fixtures', () => {
    expect(fixtures.length).toBe(4);
  });

  it.each(fixtures)('%s passes schema and validator', (file) => {
    const text = readFileSync(join(dir, file), 'utf8');
    expect(matches(JSON.parse(text)), JSON.stringify(matches.errors)).toBe(
      true,
    );
    const result = parseCookbookText(text);
    expect(result.ok).toBe(true);
  });

  it('migrates the legacy blueprint $schema and defaults features', () => {
    const result = validateCookbook({
      $schema: COOKBOOK_LEGACY_SCHEMA_URL,
      version: 1,
      recipes: ['b', 'a', 'a'],
      policies: [],
    });
    expect(result.ok && result.cookbook).toMatchObject({
      $schema: COOKBOOK_SCHEMA_URL,
      features: [],
      recipes: ['a', 'b'],
    });
  });

  it('keeps unknown top-level keys (additive fields)', () => {
    const result = validateCookbook({
      version: 1,
      recipes: [],
      policies: [],
      x: 1,
    });
    expect(result.ok && (result.cookbook as unknown as { x: number }).x).toBe(
      1,
    );
  });

  it('reports every problem with its path', () => {
    const doc = {
      version: 1,
      recipes: 'nope',
      policies: [{ objectRef: '', fieldName: 'f', scopeType: 'tenant' }],
      layout: { version: 2 },
      theme: { custom: { primary: 'red' } },
    };
    const result = validateCookbook(doc);
    expect(result.ok).toBe(false);
    expect(matches(doc)).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          expect.stringContaining('recipes'),
          expect.stringContaining('policies[0].objectRef'),
          expect.stringContaining('policies[0].scopeType'),
          expect.stringContaining('layout'),
          expect.stringContaining('theme.custom.primary'),
        ]),
      );
    }
  });

  it('rejects newer versions, bad JSON and non-objects', () => {
    expect(validateCookbook({ version: 2, recipes: [], policies: [] }).ok).toBe(
      false,
    );
    expect(parseCookbookText('{').ok).toBe(false);
    expect(validateCookbook([]).ok).toBe(false);
  });

  it('checks recipe existence only when a catalog is supplied', () => {
    const doc = { version: 1, recipes: ['a', 'zzz'], policies: [] };
    expect(validateCookbook(doc).ok).toBe(true);
    const result = validateCookbook(doc, { recipes: ['a'] });
    expect(!result.ok && result.errors).toEqual([
      'recipes: unknown recipe "zzz"',
    ]);
  });
});
