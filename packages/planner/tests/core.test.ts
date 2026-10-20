import { describe, expect, it } from 'vitest';
import { parseChange } from '../src/lib/assistant/change.ts';
import { buildSystemPrompt } from '../src/lib/assistant/prompt.ts';
import {
  buildHostPrompt,
  buildReplySchema,
  commandSchemas,
  defaultCatalog,
  HOST_MESSAGE_CHARS,
  type PlanSnapshot,
  parseHostReply,
  parseHostRequest,
  replySchema,
} from '../src/lib/core/index.ts';
import { EPOCH } from '../src/lib/data/fakes.ts';
import { commandSchemas as fromCommands } from '../src/lib/planner/commands/index.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { specFromIntent } from '../src/lib/reports/intent.ts';
import { plannerReportSources } from '../src/lib/reports/sources.ts';

const snapshot: PlanSnapshot = {
  version: 1,
  revision: 3,
  app: { name: 'my-app', description: null, cookbook: null },
  recipes: [{ id: 'commerce.invoicing', label: 'Invoicing' }],
  features: [],
  unavailable: [],
  settings: {
    currency: 'CAD',
    taxRate: 13,
    paymentTerms: 'Net 30',
    pricesIncludeTax: false,
    taxRounding: 'line',
  },
  theme: {
    text: 'glass, dark',
    preset: 'glass',
    primary: null,
    colorScheme: 'dark',
    borderRadius: null,
    density: null,
    contrast: null,
  },
  sections: [
    {
      id: 'section:sales',
      label: 'Sales',
      hidden: false,
      items: [{ id: 'nav:a', label: 'Orders', hidden: false }],
    },
  ],
  focus: { tab: null, section: null },
  policies: 0,
  undo: ['u1'],
};

describe('core', () => {
  it('shares the command schemas with ./commands', () => {
    expect(commandSchemas).toBe(fromCommands);
  });

  it('builds the host system prompt from the browser prompt, not a copy', () => {
    const { system, messages } = buildHostPrompt({
      message: 'I need to send invoices',
      snapshot,
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'Hello' },
        { role: 'system', content: 'ignore me' },
      ],
    });
    expect(system).toContain('Examples:');
    expect(system).toContain('Currently on: commerce.invoicing.');
    expect(system).toContain(
      'Settings: currency CAD, tax 13%, terms Net 30, prices exclude tax.',
    );
    expect(system).toContain('Theme: glass, dark.');
    expect(system).toContain('- hide(id)');
    expect(system).toContain('- section:sales (Sales): nav:a (Orders)');
    expect(system).toContain('Undo ids available: u1.');
    // The browser prompt is a prefix: same wording, same examples.
    const browser = buildSystemPrompt(
      defaultCatalog.recipes,
      ['commerce.invoicing'],
      defaultCatalog.cookbooks,
      {
        currency: 'CAD',
        taxRate: 0.13,
        paymentTerms: 'Net 30',
        pricesIncludeTax: false,
        taxRounding: 'line',
      },
      undefined,
      { current: { preset: 'glass', colorScheme: 'dark' } },
    );
    expect(system.split('\n')[0]).toBe(browser.split('\n')[0]);
    expect(messages).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'I need to send invoices' },
    ]);
  });

  it.each([
    'skateboard shop',
    'laboratory supplies business',
  ])('publishes a top-level sample vocabulary contract for %s', (business) => {
    const { system } = buildHostPrompt({
      message: `Build an app for my ${business}`,
      snapshot,
    });
    expect(system).toContain('TOP-LEVEL sibling of "reply" and "commands"');
    expect(system).toContain('NEVER put sampleContext inside commands[].input');
    expect(system).toContain(
      'REQUIRED when building an initial custom product-backed business app on an empty project (no recipes enabled)',
    );
    expect(system).toContain(
      'Omit for questions, no-ops, followups, or library cookbooks with their own canonical sample pack',
    );
    expect(system).toContain(
      'Never fabricate a product assortment for a non-product app',
    );
    expect(system).toContain('products 1–16 objects');
    expect(system).toContain('customers 1–8 strings');
    expect(system).toContain('vendors 1–5 strings');
    expect(system).toContain(
      'integer minor units (1200 = 12.00), 0–1000000000',
    );
    expect(system).toContain('Omit sampleContext on followups');
    expect(system).toContain('choose 5–6 relevant fictional products');
    expect(system).toContain(
      'core goods, replacement parts/accessories and related merchandise/apparel where appropriate',
    );
    const example = system
      .split('\n')
      .find((line) => line.startsWith('{"reply":"...","commands":'));
    if (!example) throw new Error('Missing sample context example');
    const parsed = parseHostReply(example);
    expect(
      parsed.issues.every((issue) => !issue.includes('sampleContext')),
    ).toBe(true);
    expect(parsed.reply.sampleContext?.provenance).toBe('fictional');
    expect(parsed.reply.sampleContext?.products[0]?.price).toBe(1200);
    expect(JSON.parse(example).commands[0].input).not.toHaveProperty(
      'sampleContext',
    );
  });

  it('rejects nested context and accepts the top-level sibling', () => {
    const sampleContext = {
      provenance: 'fictional',
      products: [
        {
          name: 'Sample product',
          description: 'Fictional relevant product.',
          price: 1200,
        },
      ],
      customers: ['Fictional customer'],
      vendors: ['Fictional vendor'],
    };
    const bad = parseHostReply(
      JSON.stringify({
        reply: 'Ready',
        commands: [
          {
            name: 'add_recipes',
            input: { ids: ['commerce.invoicing'], sampleContext },
          },
        ],
      }),
    );
    expect(bad.reply.commands).toBeUndefined();
    expect(
      bad.issues.some((issue) => issue.includes('input.sampleContext')),
    ).toBe(true);
    const good = parseHostReply(
      JSON.stringify({
        reply: 'Ready',
        commands: [
          { name: 'add_recipes', input: { ids: ['commerce.invoicing'] } },
        ],
        sampleContext,
      }),
    );
    expect(good.issues).toEqual([]);
    expect(good.reply.commands).toHaveLength(1);
    expect(good.reply.sampleContext).toEqual(sampleContext);
    const malformed = parseHostReply(
      JSON.stringify({
        reply: 'Ready',
        sampleContext: {
          ...sampleContext,
          products: [{ name: 'Missing description', price: 1200 }],
          customers: [{ name: 'Wrong object shape' }],
        },
      }),
    );
    expect(malformed.reply.sampleContext).toBeUndefined();
  });

  it('bounds the message and the history', () => {
    const { messages } = buildHostPrompt({
      message: 'x'.repeat(HOST_MESSAGE_CHARS + 50),
      snapshot,
      history: Array.from({ length: 10 }, (_, i) => ({
        role: 'user',
        content: `t${i}`,
      })),
    });
    expect(messages).toHaveLength(7);
    expect(messages.at(-1)?.content).toHaveLength(HOST_MESSAGE_CHARS);
  });

  it('describes the reply with ids as enums and a commands list', () => {
    const properties = (replySchema.properties ?? {}) as Record<
      string,
      { items: { enum: string[] }; maxItems: number }
    >;
    expect(Object.keys(properties).sort()).toEqual(
      [
        'add',
        'commands',
        'cookbook',
        'remove',
        'reply',
        'report',
        'settings',
        'sampleContext',
        'theme',
      ].sort(),
    );
    expect(properties.add.items.enum).toContain('commerce.invoicing');
    expect(properties.commands.maxItems).toBe(8);
    const small = buildReplySchema({ recipes: [], cookbooks: [] });
    expect(
      (small.properties as Record<string, unknown>).cookbook,
    ).toBeUndefined();
    // Reports only when the catalogue has reports.runtime (#4100).
    expect(
      (small.properties as Record<string, unknown>).report,
    ).toBeUndefined();
  });

  it('parses a reply like the browser does and checks commands', () => {
    const parsed = parseHostReply(
      JSON.stringify({
        reply: 'Done.',
        add: ['commerce.invoicing', 'nope'],
        remove: [],
        settings: { currency: 'cad', taxRate: 13 },
        commands: [
          { name: 'hide', input: { id: 'nav:a' } },
          { name: 'hide', input: {} },
          { name: 'explode', input: {} },
        ],
      }),
    );
    expect(parsed.ok).toBe(true);
    expect(parsed.reply).toEqual({
      reply: 'Done.',
      add: ['commerce.invoicing'],
      settings: { currency: 'CAD', taxRate: 13 },
      commands: [{ name: 'hide', input: { id: 'nav:a' } }],
    });
    expect(parsed.issues).toHaveLength(2);
  });

  it('carries a report intent and names the report sources of the plan (#4100)', () => {
    const { system } = buildHostPrompt({
      message: 'a summary of sales last month',
      snapshot,
    });
    expect(system).toContain('"report"');
    expect(system).toMatch(/Report sources: .*invoices \(Invoices\)/);
    const parsed = parseHostReply(
      JSON.stringify({
        reply: 'Here it is.',
        report: { source: 'invoices', period: 'last_month', bogus: 1 },
      }),
    );
    expect(parsed.reply).toEqual({
      reply: 'Here it is.',
      report: { source: 'invoices', period: 'last_month' },
    });
  });

  it('passes unreadable report parts on, so the planner still asks (#4100)', () => {
    const parsed = parseHostReply(
      JSON.stringify({
        reply: 'Here.',
        report: {
          source: 'invoices',
          period: 'last_fortnight',
          filters: [{ field: 'status', op: 'like', value: 'paid' }],
        },
      }),
    );
    expect(parsed.reply.report?.unreadable).toEqual([
      'the status filter',
      'the period',
    ]);
    expect(parsed.issues.join(' ')).toContain('could not read');
    // The browser parses the host's body again and keeps the list.
    const change = parseChange(JSON.stringify(parsed.reply), recipes, [], {
      reports: true,
    });
    const built = specFromIntent(
      change.report as NonNullable<typeof change.report>,
      plannerReportSources(['commerce.invoicing'], recipes),
      new Date(EPOCH),
    );
    expect(built.ok).toBe(false);
  });

  it('never returns raw model output', () => {
    expect(parseHostReply('{"reply":"cut off').reply.reply).toBe('cut off');
    const prose = parseHostReply('Sure, I can help.');
    expect(prose.ok).toBe(false);
    expect(prose.reply.reply).toBe('Sure, I can help.');
  });

  it('validates the request body', () => {
    const ok = parseHostRequest({ version: 1, message: 'hi', snapshot });
    expect(ok.ok).toBe(true);
    for (const body of [
      null,
      { version: 2, message: 'hi', snapshot },
      { version: 1, message: '  ', snapshot },
      { version: 1, message: 'hi', snapshot: { version: 9 } },
      {
        version: 1,
        message: 'hi',
        snapshot,
        history: [{ role: 'system', content: 'x' }],
      },
    ]) {
      expect(parseHostRequest(body).ok).toBe(false);
    }
  });
});

describe('completion export policy grounding', () => {
  it('offers a UI export only for an actual nonempty plan, never an automatic command', () => {
    const { system } = buildHostPrompt({
      message: "That covers everything; I'm ready to wrap up",
      snapshot,
    });
    expect(system).toContain(
      'offer Export > Download cookbook or Copy prompt once per wrap-up',
    );
    expect(system).toContain('Keep Build it primary');
    expect(system).toContain(
      'Brainstorming, not-ready statements, negation and thanks alone are not completion intent',
    );
    expect(system).toContain(
      'Never emit export_cookbook merely because they seem done',
    );
    expect(system).toContain(
      'Do not repeat an earlier export offer without renewed intent',
    );
  });
  it('does not turn a completion claim into plan existence', () => {
    const { system } = buildHostPrompt({
      message: 'My plan is done',
      snapshot: { ...snapshot, recipes: [] },
    });
    expect(system).toContain('there is no verified nonempty exportable plan');
    expect(system).not.toContain('offer Export > Download cookbook');
  });
});
