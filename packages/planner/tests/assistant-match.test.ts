import { writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMatchIndex,
  matchText,
  normalize,
  termsOf,
} from '../src/lib/assistant/match.ts';
import { CookbookOffers } from '../src/lib/assistant/offers.svelte.ts';
import { buildSystemPrompt } from '../src/lib/assistant/prompt.ts';
import {
  type ChatModel,
  createBrowserAssistantTransport,
} from '../src/lib/assistant/transport.ts';
import {
  getLibraryCookbook,
  libraryCookbooks,
} from '../src/lib/library/index.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings/app-settings.ts';

beforeEach(() => recipeState.clear());

const index = buildMatchIndex(recipes, libraryCookbooks);
const top = (text: string) => matchText(index, text)[0];
const ids = (text: string, kind: 'recipe' | 'cookbook') =>
  matchText(index, text)
    .filter((m) => m.kind === kind)
    .map((m) => m.id);

describe('normalize', () => {
  it('folds case, accents, punctuation, plurals and possessives', () => {
    expect(normalize('Bakeries')).toBe(normalize('bakery'));
    expect(normalize('Café')).toBe('cafe');
    expect(normalize("Baker's, bread!")).toBe(normalize('baker bread'));
    expect(normalize('classes')).toBe('class');
    expect(normalize('  Hello,   WORLD ')).toBe('hello world');
  });
});

describe('coverage', () => {
  it('gives every recipe at least 3 distinct match terms', () => {
    for (const recipe of recipes) {
      const terms = new Set(termsOf(index, 'recipe', recipe.id));
      expect(terms.size, recipe.id).toBeGreaterThanOrEqual(3);
    }
  });

  it('gives every cookbook at least 3 distinct match terms and keywords', () => {
    for (const cookbook of libraryCookbooks) {
      const terms = new Set(termsOf(index, 'cookbook', cookbook.id));
      expect(terms.size, cookbook.id).toBeGreaterThanOrEqual(3);
      expect(cookbook.keywords.length, cookbook.id).toBeGreaterThanOrEqual(3);
    }
  });

  it('makes each item the top match for its own name or label', () => {
    for (const recipe of recipes) {
      expect(top(recipe.label), recipe.label).toMatchObject({
        kind: 'recipe',
        id: recipe.id,
      });
    }
    for (const cookbook of libraryCookbooks) {
      expect(top(cookbook.name), cookbook.name).toMatchObject({
        kind: 'cookbook',
        id: cookbook.id,
        confidence: 'strong',
      });
    }
  });

  it('maps realistic phrases', () => {
    const cases: [string, 'recipe' | 'cookbook', string][] = [
      ['I run a bakery', 'cookbook', 'bakery'],
      ['we make bread and pastries', 'cookbook', 'bakery'],
      ['we fix cars', 'cookbook', 'mechanic'],
      ['I own a garage doing brakes and oil changes', 'cookbook', 'mechanic'],
      ['metal fabrication shop', 'cookbook', 'welder'],
      ['I do welding', 'cookbook', 'welder'],
      ['yoga classes', 'cookbook', 'yoga-studio'],
      ['I teach pilates', 'cookbook', 'yoga-studio'],
      ['I need to send invoices', 'recipe', 'commerce.invoicing'],
      ['track stock', 'recipe', 'inventory.stock'],
      ['quotes for customers', 'recipe', 'commerce.estimates'],
      ['keep the books', 'recipe', 'ledgers.bookkeeping'],
      ['schedule appointments', 'recipe', 'events.calendar'],
      ['drop the pipeline', 'recipe', 'sales.pipeline'],
      ['we sell wholesale to cafés', 'recipe', 'commerce.wholesale'],
      ['I need to track my leads', 'recipe', 'sales.pipeline'],
    ];
    for (const [text, kind, id] of cases) {
      expect(ids(text, kind), text).toContain(id);
    }
    for (const [text, kind, id] of cases.filter(([, k]) => k === 'cookbook')) {
      expect(top(text), text).toMatchObject({ kind, id });
    }
    expect(ids('I run a bakery', 'cookbook')[0]).toBe('bakery');
    expect(top('we fix cars')).toMatchObject({ id: 'mechanic' });
  });

  it('does not make ambiguous words strong cookbook matches', () => {
    const strongBooks = (text: string) =>
      matchText(index, text).filter(
        (m) => m.kind === 'cookbook' && m.confidence === 'strong',
      );
    for (const text of [
      'I need to send invoices',
      'track stock',
      'quotes for customers',
      'my car',
      'we have members',
      'classes',
      'a metal roof',
      'an art studio',
      'hello',
      'keep the books',
      'schedule appointments',
    ]) {
      expect(strongBooks(text), text).toEqual([]);
    }
    expect(matchText(index, 'hello')).toEqual([]);
    // Weak words still hint.
    expect(ids('my car', 'cookbook')).toContain('mechanic');
  });

  it('ranks an exact label above another recipe whose id ends in the same word', () => {
    const two = buildMatchIndex([
      { id: 'analytics.reports', label: 'Analytics', synonyms: ['traffic'] },
      { id: 'reports.materialized', label: 'Reports', synonyms: ['totals'] },
    ]);
    expect(matchText(two, 'Reports').map((m) => m.id)).toEqual([
      'reports.materialized',
      'analytics.reports',
    ]);
  });

  it('a new recipe or cookbook without terms fails the coverage check', () => {
    const bare = buildMatchIndex(
      [{ id: 'x.thing', label: 'Thing', synonyms: [] }],
      [{ id: 'new-book', name: 'New book', keywords: [] }],
    );
    expect(new Set(termsOf(bare, 'recipe', 'x.thing')).size).toBeLessThan(3);
    expect(new Set(termsOf(bare, 'cookbook', 'new-book')).size).toBeLessThan(3);
  });
});

describe('focused prompt', () => {
  const settings = DEFAULT_SETTINGS;
  const build = (text: string, current: string[] = []) =>
    buildSystemPrompt(
      recipes,
      current,
      libraryCookbooks,
      settings,
      matchText(index, text),
    );

  it('hints and spends full lines only on matched and on recipes', () => {
    const prompt = build(
      'I run a bakery selling wholesale and tracking stock',
      ['commerce.sales'],
    );
    expect(prompt).toMatch(
      /Looks relevant: cookbook bakery; recipes .*commerce\.wholesale/,
    );
    expect(prompt).toContain('- bakery: Bakery.');
    expect(prompt).not.toContain('- mechanic: Mechanic.');
    expect(prompt).toContain('Other cookbooks: ');
    expect(prompt).toContain('mechanic (Mechanic)');
    expect(prompt).toContain('- commerce.sales: Sales.');
    expect(prompt).toContain('- commerce.wholesale: Wholesale orders.');
    expect(prompt).toContain('Other recipes: ');
    expect(prompt).toContain('commerce.leases (Leases)');
    expect(prompt).toContain('"I run a bakery" -> ');
  });

  it('a message with no match has no hint and compact lists', () => {
    const prompt = build('hello there');
    expect(prompt).not.toContain('Looks relevant');
    expect(prompt).toContain('Other recipes: ');
    expect(prompt).not.toMatch(/^- commerce\./m);
  });

  it('reports sizes: matched and unmatched are smaller than the full prompt', () => {
    const full = buildSystemPrompt(
      recipes,
      [],
      libraryCookbooks,
      settings,
    ).length;
    const bakery = build('I run a bakery').length;
    const none = build('hello there').length;
    try {
      writeFileSync(
        process.env.PROMPT_SIZE_REPORT ?? '/dev/null',
        JSON.stringify({ full, bakery, none }),
      );
    } catch {
      // The report is optional.
    }
    expect(bakery).toBeLessThan(full);
    expect(none).toBeLessThan(bakery);
    expect(bakery).toBeLessThan(3400);
  });
});

describe('cookbook backstop', () => {
  function setup(reply: object) {
    const message = vi.fn<ChatModel['message']>(async () =>
      JSON.stringify(reply),
    );
    const offers = new CookbookOffers(getLibraryCookbook);
    const applier = vi.fn(() => null);
    offers.applier = applier;
    const transport = createBrowserAssistantTransport({
      model: () => ({ message }),
      store: recipeState,
      recipes,
      cookbooks: libraryCookbooks,
      offers,
    });
    const send = (content: string) =>
      transport.sendMessage({
        threadId: 'planner',
        content,
        clientRequestId: content,
      });
    return { message, offers, applier, send };
  }

  it('sends the matched prompt to the model', async () => {
    const { message, send } = setup({ reply: 'ok', add: [], remove: [] });
    await send('I run a bakery');
    const system = message.mock.calls[0][1]?.history?.[0].content ?? '';
    expect(system).toContain('Looks relevant: cookbook bakery');
  });

  it('offers a strong cookbook match the model missed, without applying', async () => {
    const { offers, applier, send } = setup({
      reply: 'Sounds good.',
      add: [],
      remove: [],
    });
    const result = await send('I run a bakery');
    const data = result.assistantMessage?.toolCallData as { offerId: string };
    expect(offers.offers[data.offerId]).toMatchObject({
      cookbookId: 'bakery',
      status: 'pending',
    });
    expect(applier).not.toHaveBeenCalled();
    expect(recipeState.ids).toEqual([]);
    expect(result.assistantMessage?.content).toBe('Sounds good.');
  });

  it('does not back up a weak match, a recipe match or a model cookbook', async () => {
    const weak = setup({ reply: 'ok', add: [], remove: [] });
    expect(
      (await weak.send('my car')).assistantMessage?.toolCallData,
    ).toBeUndefined();
    const recipe = setup({ reply: 'ok', add: [], remove: [] });
    const result = await recipe.send('I need to send invoices');
    expect(result.assistantMessage?.toolCallData).toBeUndefined();
    expect(recipeState.ids).toEqual([]);
    const own = setup({
      reply: 'ok',
      add: [],
      remove: [],
      cookbook: 'mechanic',
    });
    const chosen = await own.send('I run a bakery');
    const data = chosen.assistantMessage?.toolCallData as { offerId: string };
    expect(own.offers.offers[data.offerId].cookbookId).toBe('mechanic');
  });

  it('does not back up when a cookbook is pending or applied', async () => {
    const { offers, send } = setup({ reply: 'ok', add: [], remove: [] });
    const pending = offers.offer('welder');
    const first = await send('I run a bakery');
    expect(first.assistantMessage?.toolCallData).toBeUndefined();
    offers.accept(pending?.offerId ?? '');
    const second = await send('we also bake bread');
    expect(second.assistantMessage?.toolCallData).toBeUndefined();
  });
});
