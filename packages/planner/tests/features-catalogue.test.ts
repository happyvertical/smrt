import { describe, expect, it } from 'vitest';
import { catalog } from '../src/lib/catalog/index.ts';
import type { CatalogPackage } from '../src/lib/catalog/types.ts';
import {
  alsoAdds,
  buildFeatureCards,
  cardsByGroup,
  describeSurface,
  featureGets,
  featureGroups,
  filterFeatureCards,
  groupOf,
  optionLabel,
  optionList,
  secretNames,
} from '../src/lib/features/catalogue.ts';
import {
  browserNote,
  DEMO_MODE_LABEL,
  demoBadge,
  effectiveDemo,
} from '../src/lib/features/demo.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import type { Recipe } from '../src/lib/recipes/types.ts';

function recipe(id: string, extra: Partial<Recipe> = {}): Recipe {
  return {
    id,
    label: id.split('.')[1] ?? id,
    summary: `${id} summary`,
    synonyms: [],
    models: [`@happyvertical/smrt-${id.split('.')[0]}:Model`],
    nav: [],
    requires: [],
    ...extra,
  };
}

const mailbox = recipe('messages.mailbox', {
  label: 'Mailbox',
  summary: 'Read and send email.',
  synonyms: ['inbox'],
  group: { id: 'communication', label: 'Communication', summary: 'Talk.' },
  nav: [{ label: 'Messages', icon: 'mail', description: '', model: 'x' }],
  runtime: 'both',
  providers: [
    {
      id: 'mail',
      kind: 'email',
      options: ['imap', 'smtp', 'mock'],
      required: true,
      secrets: ['SMTP_PASSWORD', 'IMAP_PASSWORD'],
    },
    {
      id: 'llm',
      kind: 'llm',
      options: ['openai', 'webllm'],
      required: false,
      secrets: ['OPENAI_API_KEY', 'SMTP_PASSWORD'],
      browserOptions: ['webllm'],
    },
  ],
  surfaces: [
    {
      kind: 'route',
      path: '/mail/inbox',
      export: '@happyvertical/smrt-messages/svelte#Inbox',
      label: 'Inbox',
    },
  ],
  demo: { mode: 'mock', reasons: ['SMTP is faked.'], mocked: ['mail'] },
});
const bell = recipe('notifications.bell', {
  label: 'Notifications',
  group: { id: 'communication', label: 'Communication' },
  requires: ['messages.mailbox'],
  surfaces: [
    {
      kind: 'shell-widget',
      slot: 'header.end',
      export: '@happyvertical/smrt-notifications/svelte#Bell',
      label: 'Bell',
      icon: 'bell',
    },
  ],
  demo: { mode: 'live', reasons: [] },
  // What the catalog generator writes: the mailbox it requires is Mock.
  effectiveDemo: {
    mode: 'mock',
    reasons: ['Needs messages.mailbox, which is mock.'],
  },
});
const taxonomy = recipe('tags.taxonomy', {
  label: 'Tags',
  models: ['@happyvertical/smrt-tags:Tag', '@happyvertical/smrt-tags:TagAlias'],
  demo: { mode: 'sample', reasons: ['Uses fixtures only.'] },
});
const bare = recipe('things.plain', { label: 'Plain things' });

const pkg = (
  id: string,
  list: Recipe[],
  browser?: CatalogPackage['browser'],
): CatalogPackage => ({
  id,
  packageName: `@happyvertical/smrt-${id}`,
  version: '1.0.0',
  description: '',
  models: [],
  dependencies: [],
  surfaceSource: 'knowledge',
  ...(browser ? { browser } : {}),
  recipes: list,
});
const packages = [
  pkg('messages', [mailbox]),
  pkg('notifications', [bell]),
  pkg('tags', [taxonomy], {
    status: 'server-only',
    issues: ['#3624'],
    reason: 'node:crypto',
  }),
  pkg('things', [bare]),
];
const all = [mailbox, bell, taxonomy, bare];
const cards = buildFeatureCards(all, packages);
const card = (id: string) =>
  cards.find((c) => c.id === id) as (typeof cards)[0];

describe('demo label', () => {
  it('names the four modes and shows whatever the manifest says', () => {
    expect(DEMO_MODE_LABEL).toEqual({
      live: 'Live',
      mock: 'Mock',
      sample: 'Sample',
      server: 'Server',
    });
    for (const mode of ['live', 'mock', 'sample', 'server'] as const) {
      const badge = demoBadge({ mode, reasons: ['why'], mocked: ['p'] });
      expect(badge?.label).toBe(DEMO_MODE_LABEL[mode]);
      expect(badge?.reasons).toEqual(['why']);
      expect(badge?.mocked).toEqual(['p']);
    }
  });

  it('shows no label when the manifest reports no demo', () => {
    expect(demoBadge(undefined)).toBeUndefined();
    expect(card('things.plain').demo).toBeUndefined();
  });

  it('shows the effective demo the generator wrote, else the recipe own', () => {
    expect(effectiveDemo(bell)?.mode).toBe('mock');
    expect(effectiveDemo(mailbox)?.mode).toBe('mock');
    expect(effectiveDemo(bare)).toBeUndefined();
    expect(card('notifications.bell').demo?.label).toBe('Mock');
    expect(card('notifications.bell').ownMode).toBe('live');
    expect(card('messages.mailbox').ownMode).toBeUndefined();
    expect(card('tags.taxonomy').demo?.label).toBe('Sample');
  });

  it('keeps the folded-in reasons of a feature that requires a server one', () => {
    const badge = demoBadge(
      effectiveDemo({
        demo: { mode: 'live', reasons: [] },
        effectiveDemo: {
          mode: 'server',
          reasons: ['Needs a.a, which is server.'],
        },
      }),
    );
    expect(badge?.label).toBe('Server');
    expect(badge?.reasons.join(' ')).toContain('a.a');
  });

  it("explains a package's browser capability", () => {
    expect(browserNote(undefined)).toBeUndefined();
    expect(browserNote({ status: 'browser-safe' })).toMatch(
      /builds for a browser/,
    );
    expect(card('tags.taxonomy').packageNote).toBe(
      'Its package does not build for a browser yet (node:crypto) and is tracked in #3624.',
    );
  });
});

describe('feature cards', () => {
  it('has one card per recipe, in order', () => {
    expect(cards.map((c) => c.id)).toEqual(all.map((r) => r.id));
  });

  it('groups by the recipe group, else the package', () => {
    expect(card('messages.mailbox').group).toEqual({
      id: 'group:communication',
      label: 'Communication',
      summary: 'Talk.',
    });
    expect(card('tags.taxonomy').group).toEqual({
      id: 'package:tags',
      label: 'Tags',
    });
    expect(groupOf(taxonomy, 'tags').id).toBe('package:tags');
    const groups = featureGroups(cards);
    expect(groups.map((g) => g.label)).toEqual([
      'Communication',
      'Tags',
      'Things',
    ]);
    // The first declaration with a summary supplies it for the whole group.
    expect(groups[0].summary).toBe('Talk.');
    const sections = cardsByGroup(cards);
    expect(sections[0].cards.map((c) => c.id)).toEqual([
      'messages.mailbox',
      'notifications.bell',
    ]);
  });

  it('lists providers with secret names only, and what runs in a browser', () => {
    const [mail, llm] = card('messages.mailbox').providers;
    expect(mail).toMatchObject({
      kindLabel: 'Email',
      required: true,
      secrets: ['SMTP_PASSWORD', 'IMAP_PASSWORD'],
    });
    expect(llm.kindLabel).toBe('Language model');
    expect(llm.browserOptions).toEqual(['webllm']);
    expect(secretNames(card('messages.mailbox'))).toEqual([
      'SMTP_PASSWORD',
      'IMAP_PASSWORD',
      'OPENAI_API_KEY',
    ]);
    expect(optionLabel('webllm')).toBe('WebLLM');
    expect(optionLabel('some_new_one')).toBe('Some new one');
    expect(optionList(['openai'])).toBe('OpenAI');
    expect(optionList(['openai', 'webllm'])).toBe('OpenAI or WebLLM');
    expect(optionList(['openai', 'gemini', 'webllm'], 'and')).toBe(
      'OpenAI, Gemini and WebLLM',
    );
  });

  it('lists what a feature gets: menu entries, then surfaces', () => {
    expect(
      featureGets(mailbox).map((g) => `${g.kindLabel}: ${g.label}`),
    ).toEqual(['List and form: Messages', 'Page: Inbox']);
    expect(describeSurface(bell.surfaces?.[0] as never)).toEqual({
      kind: 'shell-widget',
      kindLabel: 'Shell widget',
      label: 'Bell',
      where: 'header, right side',
    });
    expect(
      describeSurface({
        kind: 'settings-panel',
        export: 'p#P',
        label: 'Defaults',
      }),
    ).toMatchObject({ kindLabel: 'Settings panel', label: 'Defaults' });
    expect(describeSurface({ kind: 'playground', export: 'p#P' }).label).toBe(
      'Try it',
    );
    expect(
      describeSurface({
        kind: 'widget',
        type: 't',
        export: 'p#W',
        label: 'Total',
      }).kindLabel,
    ).toBe('Overview widget');
    expect(featureGets(taxonomy)).toEqual([
      {
        kind: 'data',
        kindLabel: 'Records only',
        label: '2 models, no screens of their own',
      },
    ]);
  });

  it('falls back to the first model package for an unplaced recipe', () => {
    const orphan = recipe('tags.extra', {
      models: ['@happyvertical/smrt-tags:Tag'],
    });
    const withModels = [
      {
        ...pkg('tags', []),
        models: [{ id: '@happyvertical/smrt-tags:Tag' } as never],
      },
    ];
    expect(buildFeatureCards([orphan], withModels)[0].packageId).toBe('tags');
    expect(buildFeatureCards([orphan], [])[0].packageId).toBe('tags');
  });
});

describe('filtering', () => {
  it('matches label, synonyms, providers, surfaces and demo label', () => {
    const find = (q: string) => filterFeatureCards(cards, q).map((c) => c.id);
    expect(find('inbox')).toEqual(['messages.mailbox']);
    expect(find('language model')).toEqual(['messages.mailbox']);
    expect(find('shell widget')).toEqual(['notifications.bell']);
    expect(find('sample')).toEqual(['tags.taxonomy']);
    expect(find('mock')).toEqual(['messages.mailbox', 'notifications.bell']);
    expect(find('inbox zzz')).toEqual([]);
    expect(find('')).toHaveLength(4);
  });

  it('narrows to one group', () => {
    expect(
      filterFeatureCards(cards, '', 'group:communication').map((c) => c.id),
    ).toEqual(['messages.mailbox', 'notifications.bell']);
    expect(filterFeatureCards(cards, 'tags', 'group:communication')).toEqual(
      [],
    );
  });
});

describe('switching a feature on', () => {
  const byId = new Map(all.map((r) => [r.id, r]));

  it('adds what the recipe requires, nothing already on', () => {
    expect(alsoAdds('notifications.bell', [], byId)).toEqual([
      'messages.mailbox',
    ]);
    expect(alsoAdds('notifications.bell', ['messages.mailbox'], byId)).toEqual(
      [],
    );
    expect(alsoAdds('tags.taxonomy', [], byId)).toEqual([]);
  });
});

describe('the committed catalog', () => {
  it('builds a card for every recipe, each in a named group', () => {
    const built = buildFeatureCards(recipes, catalog.packages);
    expect(built).toHaveLength(recipes.length);
    for (const c of built) {
      expect(c.group.label).not.toBe('');
      expect(c.gets.length).toBeGreaterThan(0);
      for (const p of c.providers) {
        for (const secret of p.secrets)
          expect(secret).toMatch(/^[A-Z][A-Z0-9_]*$/);
      }
    }
  });
});
