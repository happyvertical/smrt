import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManifestAdapter } from '../manifest-adapter.js';
import {
  IDENTIFIER_PATTERN,
  MARKDOWN_MAX,
  MODEL_MAX_LENGTH,
  MODEL_PATTERN,
  OPTION_KEY_PATTERN,
  OVERVIEW_PAGE_ID_PATTERN,
  RECIPE_WIDGET_OPTION_TYPES,
  SPAN_MAX,
  SPAN_MIN,
  TEXT_MAX,
  WIDGET_TYPE_PATTERN,
} from '../recipe-widgets.js';
import { OxcScanner } from '../scanner.js';

const CORE = '@happyvertical/smrt-core';

const ORDER_MODEL = `
import { SmrtObject, smrt } from '${CORE}';
@smrt()
export class Order extends SmrtObject {
  status: string = 'draft';
}
`;

describe('recipe widget surfaces (#3727)', () => {
  let dir: string;

  function write(rel: string, source: string): void {
    const full = join(dir, rel);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, source);
  }

  const RECIPE = (statics: string) => `
import { SmrtRecipe } from '${CORE}';
import { Order } from './models/Order.js';
export class SalesRecipe extends SmrtRecipe {
  static id = 'shop.sales';
  static label = 'Sales';
  static summary = 'Take customer orders.';
  static models = [Order];
${statics}
}
`;

  async function scan() {
    const scanner = new OxcScanner({ cwd: dir, include: ['src/**/*.ts'] });
    return scanner.scanAndResolve();
  }

  async function errorsFor(statics: string): Promise<string> {
    write('src/recipes.ts', RECIPE(statics));
    const { results } = await scan();
    return results.errors.map((error) => error.message).join('\n');
  }

  const widget = (fields: string) =>
    `static surfaces = [{ kind: 'widget', type: 'sales-total', export: '@acme/shop/svelte#SalesTotal', label: 'Sales total', ${fields} }];`;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'smrt-recipe-widgets-'));
    write('src/models/Order.ts', ORDER_MODEL);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('emits a full widget surface in stable key order', async () => {
    write(
      'src/recipes.ts',
      RECIPE(`
  static surfaces = [
    {
      allowedIn: ['shop.home', 'shop.admin'],
      maxSpan: 3,
      data: { models: ['@acme/shop:Order'], load: '@acme/shop/server#loadSalesTotal' },
      options: [
        { key: 'title', type: 'text', label: 'Title', maxLength: 60, default: 'Sales' },
        { key: 'model', type: 'model', label: 'Model', required: true, default: '@acme/shop:Order' },
        { key: 'groupBy', type: 'identifier', label: 'Group by', help: 'A field id.' },
        { key: 'limit', type: 'integer', label: 'Limit', min: 1, max: 20, default: 5 },
        { key: 'ratio', type: 'number', label: 'Ratio', min: 0, max: 1 },
        { key: 'compact', type: 'boolean', label: 'Compact', default: false },
        { key: 'style', type: 'enum', label: 'Style', default: 'bar', choices: [{ value: 'bar', label: 'Bar' }, { value: 'line', label: 'Line' }] },
        { key: 'body', type: 'markdown', label: 'Body' },
      ],
      migrate: '@acme/shop/server#migrateSalesTotal',
      version: 2,
      icon: 'chart',
      description: 'Order totals.',
      label: 'Sales total',
      export: '@acme/shop/svelte#SalesTotal',
      type: 'sales-total',
      kind: 'widget',
      defaultSpan: 2,
      minSpan: 1,
    },
  ];
`),
    );
    const { results, resolved } = await scan();
    expect(results.errors).toEqual([]);
    const surface = results.recipes[0].surfaces?.[0];
    expect(Object.keys(surface ?? {})).toEqual([
      'kind',
      'type',
      'export',
      'label',
      'description',
      'icon',
      'version',
      'migrate',
      'options',
      'data',
      'allowedIn',
      'defaultSpan',
      'minSpan',
      'maxSpan',
    ]);
    expect(surface).toMatchObject({
      kind: 'widget',
      type: 'sales-total',
      export: '@acme/shop/svelte#SalesTotal',
      version: 2,
      migrate: '@acme/shop/server#migrateSalesTotal',
      data: {
        load: '@acme/shop/server#loadSalesTotal',
        models: ['@acme/shop:Order'],
      },
      allowedIn: ['shop.home', 'shop.admin'],
      defaultSpan: 2,
      minSpan: 1,
      maxSpan: 3,
    });
    const manifest = new ManifestAdapter().toManifest(resolved, {
      packageName: '@acme/shop',
      recipes: results.recipes,
    });
    expect(manifest.recipes?.[0].surfaces).toEqual(results.recipes[0].surfaces);
    expect(manifest.recipes?.[0].surfaces?.[0]).toMatchObject({
      options: expect.arrayContaining([
        expect.objectContaining({ key: 'style', type: 'enum' }),
      ]),
    });
  });

  it('accepts a minimal widget and several widgets beside other surfaces', async () => {
    write(
      'src/recipes.ts',
      RECIPE(`
  static surfaces = [
    { kind: 'widget', type: 'note-a', export: '@acme/shop/svelte#A', label: 'A' },
    { kind: 'widget', type: 'note-b', export: '@acme/shop/svelte#A', label: 'B' },
    { kind: 'settings-panel', export: '@acme/shop/svelte#Settings', label: 'Settings' },
  ];
`),
    );
    const { results } = await scan();
    expect(results.errors).toEqual([]);
    expect(results.recipes[0].surfaces).toEqual([
      {
        kind: 'widget',
        type: 'note-a',
        export: '@acme/shop/svelte#A',
        label: 'A',
      },
      {
        kind: 'widget',
        type: 'note-b',
        export: '@acme/shop/svelte#A',
        label: 'B',
      },
      {
        kind: 'settings-panel',
        export: '@acme/shop/svelte#Settings',
        label: 'Settings',
      },
    ]);
  });

  it.each([
    [
      'a missing type',
      `static surfaces = [{ kind: 'widget', export: 'a/b#C', label: 'X' }];`,
      'type must be a lowercase kebab id',
    ],
    [
      'an uppercase type',
      widget(`}, { kind: 'widget', type: 'Bad', export: 'a/b#C', label: 'X'`),
      'type must be a lowercase kebab id',
    ],
    [
      'a relative export',
      `static surfaces = [{ kind: 'widget', type: 'x', export: './W.svelte#W', label: 'X' }];`,
      'not a relative path',
    ],
    [
      'a missing label',
      `static surfaces = [{ kind: 'widget', type: 'x', export: 'a/b#C' }];`,
      'label must be a non-empty string',
    ],
    [
      'an unknown key',
      widget(`slot: 'header.end'`),
      '(widget) does not accept `slot`',
    ],
    [
      'a duplicate widget type',
      `static surfaces = [{ kind: 'widget', type: 'x', export: 'a/b#C', label: 'X' }, { kind: 'widget', type: 'x', export: 'a/b#D', label: 'Y' }];`,
      'repeats an earlier surface',
    ],
    [
      'a zero version',
      widget('version: 0'),
      'version must be a positive integer',
    ],
    [
      'a migrate on version 1',
      widget(`migrate: 'a/b#m'`),
      'migrate needs a `version` above 1',
    ],
    [
      'a relative migrate',
      widget(`version: 2, migrate: './m.js#m'`),
      'migrate `./m.js#m` must be',
    ],
    [
      'a relative loader',
      widget(`data: { load: '../x#load' }`),
      'data.load `../x#load` must be',
    ],
    ['empty data', widget('data: {}'), 'data needs `load` or `models`'],
    [
      'an unknown data key',
      widget(`data: { sql: 'select 1' }`),
      'data does not accept `sql`',
    ],
    [
      'an unqualified data model',
      widget(`data: { models: ['Order'] }`),
      'must be a qualified class name',
    ],
    [
      'duplicate data models',
      widget(`data: { models: ['a:B', 'a:B'] }`),
      'repeats `a:B`',
    ],
    [
      'empty allowedIn',
      widget('allowedIn: []'),
      'allowedIn must be a non-empty list',
    ],
    [
      'an invalid placement',
      widget(`allowedIn: ['no spaces']`),
      'must be an overview id',
    ],
    [
      'a duplicate placement',
      widget(`allowedIn: ['a.b', 'a.b']`),
      'repeats `a.b`',
    ],
    [
      'an out-of-range span',
      widget('maxSpan: 5'),
      'maxSpan must be an integer from 1 to 4',
    ],
    [
      'inverted spans',
      widget('minSpan: 3, maxSpan: 2'),
      'minSpan <= .defaultSpan <= .maxSpan',
    ],
    [
      'a default span outside the range',
      widget('minSpan: 2, defaultSpan: 1'),
      'minSpan <= .defaultSpan <= .maxSpan',
    ],
    [
      'empty options',
      widget('options: []'),
      'options must be a non-empty list',
    ],
    [
      'an unsupported option type',
      widget(`options: [{ key: 'q', type: 'sql', label: 'Query' }]`),
      'type must be one of text, markdown, identifier, model, integer, number, boolean, enum',
    ],
    [
      'an unsafe option key',
      widget(`options: [{ key: 'a-b', type: 'text', label: 'A' }]`),
      'key must be a camelCase name',
    ],
    [
      'a duplicate option key',
      widget(
        `options: [{ key: 'a', type: 'text', label: 'A' }, { key: 'a', type: 'text', label: 'B' }]`,
      ),
      'key `a` is already declared',
    ],
    [
      'an option without a label',
      widget(`options: [{ key: 'a', type: 'text' }]`),
      'label must be a non-empty string',
    ],
    [
      'an unknown option key',
      widget(
        `options: [{ key: 'a', type: 'text', label: 'A', pattern: '.*' }]`,
      ),
      'does not accept `pattern`',
    ],
    [
      'an enum without choices',
      widget(`options: [{ key: 'a', type: 'enum', label: 'A' }]`),
      'choices must be a non-empty list',
    ],
    [
      'choices on a non-enum',
      widget(
        `options: [{ key: 'a', type: 'text', label: 'A', choices: [{ value: 'x', label: 'X' }] }]`,
      ),
      'choices applies only to enum options',
    ],
    [
      'duplicate choices',
      widget(
        `options: [{ key: 'a', type: 'enum', label: 'A', choices: [{ value: 'x', label: 'X' }, { value: 'x', label: 'Y' }] }]`,
      ),
      'repeats the value `x`',
    ],
    [
      'an enum default outside its choices',
      widget(
        `options: [{ key: 'a', type: 'enum', label: 'A', default: 'z', choices: [{ value: 'x', label: 'X' }] }]`,
      ),
      'default must be one of the choices',
    ],
    [
      'a number bound on text',
      widget(`options: [{ key: 'a', type: 'text', label: 'A', min: 1 }]`),
      'min applies only to integer and number options',
    ],
    [
      'inverted bounds',
      widget(
        `options: [{ key: 'a', type: 'integer', label: 'A', min: 5, max: 1 }]`,
      ),
      'min cannot exceed .max',
    ],
    [
      'a default outside the bounds',
      widget(
        `options: [{ key: 'a', type: 'integer', label: 'A', max: 3, default: 9 }]`,
      ),
      'default must be within min and max',
    ],
    [
      'a fractional integer default',
      widget(
        `options: [{ key: 'a', type: 'integer', label: 'A', default: 1.5 }]`,
      ),
      'default must be a safe integer',
    ],
    [
      'a non-boolean boolean default',
      widget(
        `options: [{ key: 'a', type: 'boolean', label: 'A', default: 'yes' }]`,
      ),
      'default must be a boolean',
    ],
    [
      'a bad identifier default',
      widget(
        `options: [{ key: 'a', type: 'identifier', label: 'A', default: 'a b; drop' }]`,
      ),
      'default must be an identifier',
    ],
    [
      'a bad model default',
      widget(
        `options: [{ key: 'a', type: 'model', label: 'A', default: 'select * from x' }]`,
      ),
      'default must be a model name',
    ],
    [
      'a text default over the limit',
      widget(
        `options: [{ key: 'a', type: 'text', label: 'A', maxLength: 3, default: 'abcd' }]`,
      ),
      'default must be at most 3 characters',
    ],
  ])('rejects %s', async (_name, statics, expected) => {
    expect(await errorsFor(statics)).toContain(expected);
  });

  it('rejects the same widget type in two recipes of one package', async () => {
    write(
      'src/recipes.ts',
      `
import { SmrtRecipe } from '${CORE}';
import { Order } from './models/Order.js';
export class A extends SmrtRecipe {
  static id = 'shop.a';
  static label = 'A';
  static summary = 'A.';
  static models = [Order];
  static surfaces = [{ kind: 'widget', type: 'total', export: 'a/b#A', label: 'A' }];
}
export class B extends SmrtRecipe {
  static id = 'shop.b';
  static label = 'B';
  static summary = 'B.';
  static models = [Order];
  static surfaces = [{ kind: 'widget', type: 'total', export: 'a/b#B', label: 'B' }];
}
`,
    );
    const { results } = await scan();
    expect(results.errors.map((error) => error.message).join('\n')).toContain(
      'widget type `total` is already used by recipe shop.a',
    );
  });

  it('copies the smrt-svelte overview rules it validates against', () => {
    const overview = join(
      __dirname,
      '../../../smrt-svelte/src/components/overview',
    );
    const types = readFileSync(join(overview, 'types.ts'), 'utf8');
    const schema = readFileSync(join(overview, 'schema.ts'), 'utf8');
    const pattern = (source: string, name: string) =>
      new RegExp(`${name} =\\s*/(\\^.*\\$)/;`).exec(source)?.[1];
    const number = (source: string, name: string) =>
      Number(
        new RegExp(`${name} = ([0-9_]+);`).exec(source)?.[1]?.replace(/_/g, ''),
      );

    expect(pattern(types, 'WIDGET_TYPE_PATTERN')).toBe(
      WIDGET_TYPE_PATTERN.source,
    );
    expect(pattern(types, 'OVERVIEW_PAGE_ID_PATTERN')).toBe(
      OVERVIEW_PAGE_ID_PATTERN.source,
    );
    expect(number(types, 'OVERVIEW_MIN_SPAN')).toBe(SPAN_MIN);
    expect(number(types, 'OVERVIEW_MAX_SPAN')).toBe(SPAN_MAX);
    expect(pattern(schema, 'KEY_PATTERN')).toBe(OPTION_KEY_PATTERN.source);
    expect(pattern(schema, 'IDENTIFIER_PATTERN')).toBe(
      IDENTIFIER_PATTERN.source,
    );
    expect(pattern(schema, 'MODEL_PATTERN')).toBe(MODEL_PATTERN.source);
    expect(number(schema, 'MODEL_MAX_LENGTH')).toBe(MODEL_MAX_LENGTH);
    expect(number(schema, 'DEFAULT_TEXT_MAX')).toBe(TEXT_MAX);
    expect(number(schema, 'DEFAULT_MARKDOWN_MAX')).toBe(MARKDOWN_MAX);

    const body = /export type WidgetOptionType =([^;]*);/.exec(types)?.[1];
    const optionTypes = [...(body ?? '').matchAll(/'([^']+)'/g)].map(
      (m) => m[1],
    );
    expect(optionTypes.length).toBeGreaterThan(0);
    expect([...RECIPE_WIDGET_OPTION_TYPES]).toEqual(optionTypes);
  });
});
