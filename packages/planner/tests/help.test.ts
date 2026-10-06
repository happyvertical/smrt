import { beforeEach, describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import {
  buildGlossary,
  createRecipeHelp,
  extractFieldRefs,
  findField,
  type HelpBlock,
  type HelpModel,
  type Inline,
  parseHelp,
  renderHelp,
  validateHelp,
} from '../src/lib/recipes/help.ts';
import { getRecipe, helpModels, recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const model = (
  name: string,
  fields: HelpModel['fields'],
  descriptions: Record<string, string> = {},
): HelpModel => ({ id: `@x/y:${name}`, name, fields, descriptions });

const f = (
  name: string,
  label: string,
  visibility: 'basic' | 'advanced' | 'hidden' = 'basic',
  help?: string,
) => ({ name, label, visibility, help });

const text = (inlines: readonly Inline[]): string =>
  inlines
    .map((n) =>
      n.type === 'text' || n.type === 'code'
        ? n.text
        : n.type === 'field'
          ? `{${n.ref}}`
          : text(n.children),
    )
    .join('');

const lines = (blocks: readonly HelpBlock[]): string[] =>
  blocks.flatMap((b) =>
    b.type === 'list'
      ? b.items.map((i) => `- ${text(i.inlines)}`)
      : [
          `${b.type === 'heading' ? '#'.repeat(b.level) : 'p'}: ${text(b.inlines)}`,
        ],
  );

const SALES = [
  f('customerId', 'Customer'),
  f('status', 'Stage'),
  f('notes', 'Notes', 'hidden'),
];

describe('parseHelp', () => {
  it('reads headings, paragraphs and flat lists, joining wrapped lines', () => {
    const blocks = parseHelp(
      '## Tasks\n\nFirst line\nsecond line.\n\n1. One\n   more\n2. Two\n\n- A\n- B',
    );
    expect(lines(blocks)).toEqual([
      '##: Tasks',
      'p: First line second line.',
      '- One more',
      '- Two',
      '- A',
      '- B',
    ]);
    expect(blocks.map((b) => (b.type === 'list' ? b.ordered : null))).toEqual([
      null,
      null,
      true,
      false,
    ]);
  });

  it('never produces markup: HTML stays text and links stay literal', () => {
    const [block] = parseHelp('<script>alert(1)</script> [x](javascript:y)');
    expect(block?.type).toBe('paragraph');
    expect(JSON.stringify(block)).not.toContain('"type":"html"');
    expect(lines([block as HelpBlock])[0]).toContain('<script>');
  });

  it('keeps references inside emphasis', () => {
    expect(
      extractFieldRefs('Pick **{field:a}** and *{field:Order.b}*.'),
    ).toEqual(['Order.b', 'a']);
  });
});

describe('field references', () => {
  it('replaces {field:x} with the effective label', () => {
    const { blocks } = renderHelp(
      createRecipeHelp('Set **{field:status}** first.'),
      [model('Order', SALES)],
    );
    expect(lines(blocks)).toEqual(['p: Set Stage first.']);
  });

  it('resolves Model.name against the named model only', () => {
    const models = [
      model('Order', [f('status', 'Order status')]),
      model('Customer', [f('status', 'Customer status')]),
    ];
    expect(findField('status', models)?.model.name).toBe('Order');
    expect(findField('Customer.status', models)?.field.label).toBe(
      'Customer status',
    );
    expect(findField('Vendor.status', models)).toBeUndefined();
    expect(findField('nope', models)).toBeUndefined();
  });

  it('follows a renamed label everywhere', () => {
    const renamed = [model('Order', [f('customerId', 'Client')])];
    const { blocks } = renderHelp(
      createRecipeHelp(
        'Pick the {field:customerId}.\n\n- Ask the {field:customerId}.',
      ),
      renamed,
    );
    expect(lines(blocks)).toEqual(['p: Pick the Client.', '- Ask the Client.']);
  });
});

describe('block dropping', () => {
  const markdown = [
    '## Tasks',
    '',
    '### Take an order',
    '',
    '1. Pick the {field:customerId}.',
    '2. Add {field:notes}.',
    '3. Save.',
    '',
    'Mention the {field:notes} when you call.',
    '',
    '### Only notes',
    '',
    '- Write {field:notes}.',
  ].join('\n');

  it('drops list items and paragraphs tied to a hidden field', () => {
    const { blocks } = renderHelp(createRecipeHelp(markdown), [
      model('Order', SALES),
    ]);
    expect(lines(blocks)).toEqual([
      '##: Tasks',
      '###: Take an order',
      '- Pick the Customer.',
      '- Save.',
    ]);
  });

  it('keeps them when the field is shown, and drops "advanced" like hidden', () => {
    const shown = renderHelp(createRecipeHelp(markdown), [
      model('Order', [...SALES.slice(0, 2), f('notes', 'Notes')]),
    ]);
    expect(lines(shown.blocks)).toContain('- Add Notes.');
    expect(lines(shown.blocks)).toContain('###: Only notes');
    const advanced = renderHelp(createRecipeHelp(markdown), [
      model('Order', [...SALES.slice(0, 2), f('notes', 'Notes', 'advanced')]),
    ]);
    expect(lines(advanced.blocks)).not.toContain('- Add Notes.');
  });

  it('drops a block that names an unknown field rather than showing a gap', () => {
    const { blocks } = renderHelp(
      createRecipeHelp('Keep.\n\nSee {field:ghost}.'),
      [model('Order', SALES)],
    );
    expect(lines(blocks)).toEqual(['p: Keep.']);
  });

  it('keeps a heading that never had a body', () => {
    const { blocks } = renderHelp(
      createRecipeHelp('## Overview\n\n## Tasks\n\nBody.'),
      [],
    );
    expect(lines(blocks)).toEqual(['##: Overview', '##: Tasks', 'p: Body.']);
  });
});

describe('glossary', () => {
  it('uses the effective label and help, then falls back to the description', () => {
    const glossary = buildGlossary([
      model(
        'Order',
        [
          f('customerId', 'Client', 'basic', 'My own help.'),
          f('status', 'Stage'),
          f('notes', 'Notes', 'hidden'),
          f('terms', 'Terms'),
        ],
        { customerId: 'Seed.', status: 'Where it stands.', notes: 'Hidden.' },
      ),
    ]);
    expect(glossary).toEqual([
      {
        model: 'Order',
        name: 'customerId',
        label: 'Client',
        text: 'My own help.',
      },
      {
        model: 'Order',
        name: 'status',
        label: 'Stage',
        text: 'Where it stands.',
      },
    ]);
  });

  it('falls back when help is blank', () => {
    const [entry] = buildGlossary([
      model('Order', [f('status', 'Stage', 'basic', '  ')], {
        status: 'Desc.',
      }),
    ]);
    expect(entry?.text).toBe('Desc.');
  });
});

describe('validateHelp', () => {
  const models = [model('Order', SALES)];
  it('accepts consistent help', () => {
    expect(
      validateHelp(createRecipeHelp('Use {field:status}.'), models),
    ).toEqual([]);
  });
  it('fails on references to undeclared fields, mismatched fieldRefs and empty help', () => {
    expect(
      validateHelp(
        createRecipeHelp('Use {field:ghost} {field:Vendor.x}.'),
        models,
      ),
    ).toHaveLength(2);
    expect(
      validateHelp({ markdown: 'Use {field:status}.', fieldRefs: [] }, models),
    ).toEqual(['fieldRefs does not match the references in the markdown']);
    expect(validateHelp({ markdown: ' ', fieldRefs: [] }, models)).toEqual([
      'help has no markdown',
    ]);
  });
});

describe('every recipe', () => {
  beforeEach(() => recipeState.clear());

  const effective = (id: string) => {
    const recipe = getRecipe(id);
    if (!recipe) throw new Error(id);
    return {
      recipe,
      models: helpModels(recipe, recipeState.rows),
    };
  };

  it('ships valid help with every shown field described', () => {
    expect(
      recipes.map((r) => r.id).filter((id) => !getRecipe(id)?.help),
    ).toEqual([]);
    for (const recipe of recipes) {
      const { models } = effective(recipe.id);
      expect(
        validateHelp(recipe.help ?? { markdown: '', fieldRefs: [] }, models),
      ).toEqual([]);
      const { blocks, glossary } = renderHelp(
        recipe.help ?? { markdown: '', fieldRefs: [] },
        models,
      );
      // Overview plus two or three tasks.
      const tasks = blocks.filter((b) => b.type === 'heading' && b.level === 3);
      expect(tasks.length).toBeGreaterThanOrEqual(2);
      expect(tasks.length).toBeLessThanOrEqual(3);
      // Every shown field has a glossary entry.
      for (const m of models) {
        const shown = m.fields.filter((x) => x.visibility === 'basic');
        expect(glossary.filter((g) => g.model === m.name)).toHaveLength(
          shown.length,
        );
      }
      // No developer vocabulary leaks into the prose.
      expect(JSON.stringify(blocks)).not.toMatch(
        /\b(REST|MCP|CLI|API|JSON|UUID)\b/,
      );
      expect(JSON.stringify(glossary)).not.toMatch(
        /\b(REST|MCP|CLI|API|JSON|UUID)\b/,
      );
    }
  });

  it('declares only fields the catalog models declare', () => {
    for (const recipe of recipes) {
      for (const id of recipe.models) {
        const catalog = getModelByQualifiedName(id)?.model;
        const { models } = effective(recipe.id);
        expect(models.find((m) => m.id === id)?.fields.length).toBe(
          catalog?.fields.filter((x) => !x.system).length,
        );
      }
    }
  });

  it('Sales help follows the options: hiding a field removes its glossary entry and step', () => {
    recipeState.add('commerce.sales');
    const before = effective('commerce.sales');
    const render = () =>
      renderHelp(
        before.recipe.help as never,
        effective('commerce.sales').models,
      );
    expect(render().glossary.map((g) => g.name)).toContain('expiryDate');
    expect(lines(render().blocks).join('\n')).toContain('Expiry date');

    recipeState.save(
      '@happyvertical/smrt-commerce:Order',
      [
        {
          objectRef: '@happyvertical/smrt-commerce:Order',
          fieldName: 'expiryDate',
          scopeType: 'app',
          visibility: 'hidden',
        },
        {
          objectRef: '@happyvertical/smrt-commerce:Order',
          fieldName: 'customerId',
          scopeType: 'app',
          label: 'Client',
        },
      ],
      [],
    );
    const after = render();
    expect(after.glossary.map((g) => g.name)).not.toContain('expiryDate');
    expect(lines(after.blocks).join('\n')).not.toContain('Expiry date');
    expect(lines(after.blocks).join('\n')).toContain('Enter the Client');
    expect(after.glossary.find((g) => g.name === 'customerId')?.label).toBe(
      'Client',
    );
  });
});
