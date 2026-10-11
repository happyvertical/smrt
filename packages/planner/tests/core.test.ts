import { describe, expect, it } from 'vitest';
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
import { commandSchemas as fromCommands } from '../src/lib/planner/commands/index.ts';

const snapshot: PlanSnapshot = {
  version: 1,
  revision: 3,
  app: { name: 'my-app', description: null, cookbook: null },
  recipes: [{ id: 'commerce.invoicing', label: 'Invoicing' }],
  features: [],
  unavailable: [],
  settings: { currency: 'CAD', taxRate: 13, paymentTerms: 'Net 30' },
  theme: {
    text: 'glass, dark',
    preset: 'glass',
    primary: null,
    colorScheme: 'dark',
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
    expect(system).toContain('Settings: currency CAD, tax 13%, terms Net 30.');
    expect(system).toContain('Theme: glass, dark.');
    expect(system).toContain('- hide(id)');
    expect(system).toContain('- section:sales (Sales): nav:a (Orders)');
    expect(system).toContain('Undo ids available: u1.');
    // The browser prompt is a prefix: same wording, same examples.
    const browser = buildSystemPrompt(
      defaultCatalog.recipes,
      ['commerce.invoicing'],
      defaultCatalog.cookbooks,
      { currency: 'CAD', taxRate: 0.13, paymentTerms: 'Net 30' },
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
        'settings',
        'theme',
      ].sort(),
    );
    expect(properties.add.items.enum).toContain('commerce.invoicing');
    expect(properties.commands.maxItems).toBe(8);
    const small = buildReplySchema({ recipes: [], cookbooks: [] });
    expect(
      (small.properties as Record<string, unknown>).cookbook,
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
