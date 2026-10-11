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
      expect(result.diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            severity: 'error',
            code: 'invalid_type',
            path: 'recipes',
          }),
          expect.objectContaining({
            severity: 'error',
            code: 'invalid_value',
            path: 'theme.custom.primary',
          }),
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
    expect(!result.ok && result.diagnostics[0]).toMatchObject({
      code: 'unknown_recipe',
      path: 'recipes[1]',
    });
  });

  it('checks theme and every layout reference when host catalogs are supplied', () => {
    const result = validateCookbook(
      {
        version: 1,
        recipes: [],
        policies: [],
        theme: { preset: 'neon' },
        layout: {
          version: 1,
          sectionOrder: ['section:known', 'section:ghost'],
          itemOrder: { 'section:known': ['item:known', 'item:ghost'] },
          hidden: ['item:ghost'],
          moved: { 'item:known': 'section:ghost' },
          sections: { 'section:ghost': { label: 'Ghost' } },
          items: { 'item:ghost': { label: 'Ghost' } },
          placements: { 'item:ghost': 'header.end' },
        },
      },
      {
        themePresets: ['smrt'],
        layout: {
          sections: ['section:known'],
          items: ['item:known'],
        },
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('fixture must fail');
    expect(result.diagnostics.map((issue) => issue.code)).toEqual([
      'unknown_theme_preset',
      'unknown_layout_id',
      'unknown_layout_id',
      'unknown_layout_id',
      'unknown_layout_id',
      'unknown_layout_id',
      'unknown_layout_id',
      'unknown_layout_id',
    ]);
    expect(result.diagnostics.map((issue) => issue.path)).toContain(
      'layout.moved.item:known',
    );
  });

  it('drops and reports invalid overview data and stores host-canonical values', () => {
    const result = validateCookbook(
      {
        version: 1,
        recipes: [],
        policies: [],
        overviews: {
          'section:known': {
            version: 1,
            added: [
              { id: 'valid', type: 'note', span: 2, options: { body: 'Hi' } },
              { id: 'bad id', type: 'note', span: 2, options: {} },
            ],
            changed: { valid: { span: 3 }, broken: { span: 9 } },
          },
          'section:ghost': { version: 1 },
          'section:malformed': { version: 2 },
        },
      },
      {
        overviewIds: ['section:known', 'section:malformed'],
        validateOverview: (id, override) => ({
          ok: true,
          override: {
            ...override,
            added: override.added?.filter((widget) => widget.type === 'note'),
          },
          diagnostics: [
            {
              severity: 'warning',
              code: 'canonicalized_overview',
              path: `overviews.${id}`,
              message: 'Overview was checked against its page definition.',
            },
          ],
        }),
      },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('fixture must pass');
    expect(Object.keys(result.cookbook.overviews ?? {})).toEqual([
      'section:known',
    ]);
    expect(result.cookbook.overviews?.['section:known']?.added).toHaveLength(1);
    expect(result.cookbook.overviews?.['section:known']?.changed).toEqual({
      valid: { span: 3 },
    });
    expect(result.diagnostics.map((issue) => issue.code)).toEqual([
      'malformed_overview_widget',
      'malformed_overview_change',
      'canonicalized_overview',
      'unknown_overview',
      'malformed_overview',
    ]);
    expect(result.warnings).toHaveLength(5);
  });

  it('rejects a malformed top-level overviews value', () => {
    const result = validateCookbook({
      version: 1,
      recipes: [],
      policies: [],
      overviews: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('fixture must fail');
    expect(result.diagnostics).toContainEqual({
      severity: 'error',
      code: 'invalid_type',
      path: 'overviews',
      message: 'overviews must map overview ids to overrides',
    });
  });

  it('checks hidden references against whichever layout catalogs are supplied', () => {
    const result = validateCookbook(
      {
        version: 1,
        recipes: [],
        policies: [],
        layout: { version: 1, hidden: ['missing'] },
      },
      { layout: { sections: ['known'] } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('fixture must fail');
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: 'unknown_layout_id',
        path: 'layout.hidden[0]',
      }),
    ]);
  });
});

describe('the ./cookbook package export', () => {
  it('names a file the build emits (one dist/<export>.js per entry)', () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, '../../package.json'), 'utf8'),
    ) as { exports: Record<string, { import: string } | string> };
    const entry = pkg.exports['./cookbook'] as { import: string };
    // vite.config.ts maps `./dist/x.js` to `src/x.ts` and emits `dist/x.js`.
    const source = entry.import
      .replace(/^\.\/dist\//, '')
      .replace(/\.js$/, '.ts');
    expect(readdirSync(join(import.meta.dirname, '..'))).toContain(source);
  });
});
