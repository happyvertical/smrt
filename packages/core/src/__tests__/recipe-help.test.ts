import { deriveHelpFieldRefs } from '@happyvertical/smrt-scanner';
import { describe, expect, it } from 'vitest';
import {
  buildConnectSection,
  buildGlossary,
  createRecipeHelp,
  extractFieldRefs,
  findField,
  type HelpField,
  type HelpModel,
  helpToMarkdown,
  parseHelp,
  type RenderHelpOptions,
  renderHelp,
  resolveHelp,
  validateHelp,
} from '../recipe-help';

const MARKDOWN = `## Overview

Orders are what you sell.

## Tasks

### Take an order

1. Choose **New**.
2. Enter the **{field:customerId}** the order is for.
3. Enter the {field:Order.totalAmount} and {field:taxAmount}.
4. Save.

### Hide me

1. Set {field:channelId}.
2. Check {field:internalCode}.

### Follow an order

Update **{field:status}** as it moves along.
`;

function field(name: string, overrides: Partial<HelpField> = {}): HelpField {
  return { name, label: `L:${name}`, visibility: 'basic', ...overrides };
}

const ORDER: HelpModel = {
  id: '@shop/pkg:Order',
  name: 'Order',
  fields: [
    field('customerId', { label: 'Customer' }),
    field('totalAmount'),
    field('taxAmount'),
    field('status'),
    field('channelId', { visibility: 'hidden' }),
    field('internalCode', { visibility: 'advanced' }),
  ],
  descriptions: {
    customerId: 'The customer the order is for.',
    status: 'Where the order stands.',
    channelId: 'Where it came from.',
  },
};

function plain(blocks: ReturnType<typeof resolveHelp>): string[] {
  const text = (nodes: readonly { type: string }[]): string =>
    nodes
      .map((node) => {
        const n = node as {
          type: string;
          text?: string;
          children?: { type: string }[];
        };
        return n.children ? text(n.children) : (n.text ?? '');
      })
      .join('');
  return blocks.flatMap((block) =>
    block.type === 'list'
      ? block.items.map((item) => text(item.inlines))
      : [text(block.inlines)],
  );
}

describe('recipe help parsing', () => {
  it('derives distinct sorted references as written', () => {
    expect(extractFieldRefs(MARKDOWN)).toEqual([
      'Order.totalAmount',
      'channelId',
      'customerId',
      'internalCode',
      'status',
      'taxAmount',
    ]);
  });

  it('does not treat a reference inside a code span as a reference', () => {
    expect(extractFieldRefs('Type `{field:nope}` and {field:real}.')).toEqual([
      'real',
    ]);
  });

  it('builds a contract entry with derived fieldRefs', () => {
    expect(createRecipeHelp('Use {field:b} then {field:a}.')).toEqual({
      markdown: 'Use {field:b} then {field:a}.',
      fieldRefs: ['a', 'b'],
    });
  });

  it('parses headings, paragraphs and lists, and keeps unknown syntax as text', () => {
    const blocks = parseHelp(
      '## A\n\nSome *em* and `code`.\n\n- one\n- two\n\n##### deep',
    );
    expect(blocks.map((b) => b.type)).toEqual([
      'heading',
      'paragraph',
      'list',
      'paragraph',
    ]);
  });

  it('agrees with the scanner derivation, which cannot import core', () => {
    for (const sample of [
      MARKDOWN,
      'Plain.',
      'A `{field:x}` and **{field:y}** and *{field:z}* {field:M.w}',
      '- {field:a}\n- `{field:b}` {field:c}\n\n`{field:d}`',
    ]) {
      expect(deriveHelpFieldRefs(sample)).toEqual(extractFieldRefs(sample));
    }
  });
});

describe('validateHelp', () => {
  const ok = createRecipeHelp(MARKDOWN);

  it('passes a consistent entry', () => {
    expect(validateHelp(ok, [ORDER])).toEqual([]);
  });

  it('fails a reference to an undeclared field', () => {
    const bad = createRecipeHelp('Enter {field:ghost}.');
    expect(validateHelp(bad, [ORDER])).toEqual([
      "{field:ghost} names a field the recipe's models lack",
    ]);
  });

  it('fails a qualified reference to a model the recipe lacks', () => {
    const bad = createRecipeHelp('Enter {field:Other.status}.');
    expect(validateHelp(bad, [ORDER])).toHaveLength(1);
  });

  it('fails a fieldRefs list that disagrees with the markdown', () => {
    expect(
      validateHelp({ markdown: 'Enter {field:status}.', fieldRefs: [] }, [
        ORDER,
      ]),
    ).toEqual([
      expect.stringMatching(
        /^fieldRefs does not match the references in the markdown \(markdown: \[/,
      ),
    ]);
    expect(
      validateHelp(
        {
          markdown: 'Enter {field:status}.',
          fieldRefs: ['status', 'taxAmount'],
        },
        [ORDER],
      ),
    ).toEqual([
      expect.stringMatching(
        /^fieldRefs does not match the references in the markdown \(markdown: \[/,
      ),
    ]);
  });

  it('fails help with no markdown', () => {
    expect(validateHelp({ markdown: '  \n', fieldRefs: [] }, [ORDER])).toEqual([
      'help has no markdown',
    ]);
  });

  it('finds qualified and unqualified fields', () => {
    expect(findField('Order.status', [ORDER])?.field.name).toBe('status');
    expect(findField('status', [ORDER])?.model.name).toBe('Order');
    expect(findField('Nope.status', [ORDER])).toBeUndefined();
  });
});

describe('resolveHelp', () => {
  const help = createRecipeHelp(MARKDOWN);

  it('replaces references with the effective label', () => {
    const lines = plain(resolveHelp(help, [ORDER]));
    expect(lines).toContain('Enter the Customer the order is for.');
    expect(lines).toContain('Enter the L:totalAmount and L:taxAmount.');
    expect(lines).toContain('Update L:status as it moves along.');
  });

  it('drops a list item tied to a hidden field and keeps its siblings', () => {
    const lines = plain(resolveHelp(help, [ORDER]));
    expect(lines).not.toContain('Set L:channelId.');
    expect(lines).toContain('Choose New.');
  });

  it('drops an item tied to an advanced field unless advanced is enabled', () => {
    const off = plain(resolveHelp(help, [ORDER]));
    expect(off.join('\n')).not.toContain('internalCode');
    const on = plain(resolveHelp(help, [ORDER], { showAdvanced: true }));
    expect(on).toContain('Check L:internalCode.');
  });

  it('drops a block tied to a disabled field', () => {
    const disabled: HelpModel = {
      ...ORDER,
      fields: ORDER.fields.map((f) =>
        f.name === 'status' ? { ...f, disabled: true } : f,
      ),
    };
    expect(plain(resolveHelp(help, [disabled])).join('\n')).not.toContain(
      'L:status',
    );
  });

  it('drops a block tied to a field the models do not declare', () => {
    const lines = plain(
      resolveHelp(createRecipeHelp('Hi {field:ghost}.\n\nStay.'), [ORDER]),
    );
    expect(lines).toEqual(['Stay.']);
  });

  it('prunes a heading whose whole section was dropped', () => {
    const headings = resolveHelp(help, [ORDER])
      .filter((b) => b.type === 'heading')
      .map((b) => plain([b])[0]);
    expect(headings).toContain('Take an order');
    expect(headings).toContain('Follow an order');
    expect(headings).not.toContain('Hide me');
  });

  it('keeps an enclosing heading while any nested section survives', () => {
    const headings = resolveHelp(help, [ORDER])
      .filter((b) => b.type === 'heading')
      .map((b) => plain([b])[0]);
    expect(headings).toContain('Tasks');
  });

  it('prunes a parent heading when every nested section is dropped', () => {
    const md = '## Tasks\n\n### One\n\n- {field:channelId}\n';
    expect(resolveHelp(createRecipeHelp(md), [ORDER])).toEqual([]);
  });

  it('keeps a heading that never had any content', () => {
    const md = '## Lonely\n\n## Next\n\nText.';
    expect(
      resolveHelp(createRecipeHelp(md), [ORDER]).map((b) => b.type),
    ).toEqual(['heading', 'heading', 'paragraph']);
  });

  it('resolves tied bold and italic text without leaking markup', () => {
    const blocks = resolveHelp(createRecipeHelp('Set **{field:status}**.'), [
      ORDER,
    ]);
    expect(JSON.stringify(blocks)).toContain('"strong"');
    expect(plain(blocks)).toEqual(['Set L:status.']);
  });

  it('emits text nodes only, so authored markup stays inert text', () => {
    const blocks = resolveHelp(
      createRecipeHelp('Click <img src=x onerror=alert(1)> **now**.'),
      [ORDER],
    );
    const walk = (nodes: unknown[]): string[] =>
      nodes.flatMap((n) => {
        const node = n as { type: string; children?: unknown[] };
        return [node.type, ...(node.children ? walk(node.children) : [])];
      });
    const types = new Set(
      blocks.flatMap((b) =>
        b.type === 'list'
          ? b.items.flatMap((i) => walk(i.inlines))
          : walk(b.inlines),
      ),
    );
    expect([...types].sort()).toEqual(['strong', 'text']);
    expect(plain(blocks)[0]).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('buildGlossary', () => {
  it('uses effective help, then the description, and skips the rest', () => {
    const model: HelpModel = {
      ...ORDER,
      fields: [
        field('customerId', { label: 'Customer', help: '  Who is buying.  ' }),
        field('status'),
        field('taxAmount'),
        field('channelId', { visibility: 'hidden' }),
        field('internalCode', { visibility: 'advanced', help: 'Internal.' }),
      ],
    };
    expect(buildGlossary([model])).toEqual([
      {
        model: 'Order',
        name: 'customerId',
        label: 'Customer',
        text: 'Who is buying.',
      },
      {
        model: 'Order',
        name: 'status',
        label: 'L:status',
        text: 'Where the order stands.',
      },
    ]);
  });

  it('skips a shown field with no help and no description', () => {
    const names = buildGlossary([ORDER]).map((e) => e.name);
    expect(names).not.toContain('totalAmount');
    expect(names).not.toContain('taxAmount');
  });

  it('includes advanced fields only when enabled', () => {
    const model: HelpModel = {
      ...ORDER,
      fields: [field('internalCode', { visibility: 'advanced', help: 'x' })],
    };
    expect(buildGlossary([model])).toEqual([]);
    expect(buildGlossary([model], { showAdvanced: true })).toHaveLength(1);
  });
});

describe('connect section', () => {
  const surfaces: NonNullable<RenderHelpOptions['surfaces']> = [
    {
      model: 'Order',
      kind: 'api',
      operation: 'list',
      name: 'list',
      method: 'GET',
      path: '/api/orders',
    },
    {
      model: 'Order',
      kind: 'api',
      operation: 'update',
      name: 'update',
      method: 'PUT',
      path: '/api/orders/:id',
    },
    { model: 'Order', kind: 'mcp', operation: 'list', name: 'order_list' },
    { model: 'Order', kind: 'cli', operation: 'list', name: 'order list' },
  ];

  it('is absent without surfaces', () => {
    expect(buildConnectSection()).toBeUndefined();
    expect(renderHelp(createRecipeHelp('x'), [ORDER]).connect).toBeUndefined();
  });

  it('groups by transport, collapsed, listing REST routes by method and path', () => {
    const connect = buildConnectSection({ surfaces });
    expect(connect?.collapsed).toBe(true);
    expect(connect?.title).toBe('Connect other tools');
    expect(connect?.groups.map((g) => g.kind)).toEqual(['api', 'mcp', 'cli']);
    expect(connect?.groups[0]?.entries.map((e) => e.text)).toEqual([
      'GET /api/orders',
      'PUT /api/orders/:id',
    ]);
  });

  it('honours the recipe exposure narrowing', () => {
    const connect = buildConnectSection({
      surfaces,
      exposure: { Order: { api: { exclude: ['update'] }, mcp: false } },
    });
    expect(connect?.groups.map((g) => g.kind)).toEqual(['api', 'cli']);
    expect(connect?.groups[0]?.entries).toHaveLength(1);
  });

  it('is absent once everything is narrowed away', () => {
    expect(
      buildConnectSection({
        surfaces,
        exposure: { Order: { api: false, mcp: false, cli: false } },
      }),
    ).toBeUndefined();
  });
});

describe('renderHelp and helpToMarkdown', () => {
  it('returns blocks, glossary and connect, flattened to Markdown last', () => {
    const rendered = renderHelp(createRecipeHelp(MARKDOWN), [ORDER], {
      surfaces: [
        { model: 'Order', kind: 'mcp', operation: 'list', name: 'order_list' },
      ],
    });
    const md = helpToMarkdown(rendered);
    expect(md).toContain('## Overview');
    expect(md).toContain('1. Choose **New**.');
    expect(md).toContain('2. Enter the **Customer** the order is for.');
    expect(md).not.toContain('{field:');
    expect(md).not.toContain('channelId');
    expect(md).toContain('- **Customer**: The customer the order is for.');
    expect(md.indexOf('## Fields')).toBeLessThan(
      md.indexOf('## Connect other tools'),
    );
    expect(md.trimEnd().endsWith('`order_list`')).toBe(true);
  });
});
