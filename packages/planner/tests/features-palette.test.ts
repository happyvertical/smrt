import { describe, expect, it, vi } from 'vitest';
import {
  PLANNER_TAB_COMMANDS,
  plannerProviders,
} from '../src/lib/features/palette.ts';
import type { Recipe } from '../src/lib/recipes/types.ts';

const recipe = (id: string, extra: Partial<Recipe> = {}): Recipe => ({
  id,
  label: id,
  summary: `${id} summary`,
  synonyms: [],
  models: [],
  nav: [],
  requires: [],
  ...extra,
});

const recipes = [
  recipe('a.on'),
  recipe('b.mail', {
    label: 'Mailbox',
    synonyms: ['inbox'],
    demo: { mode: 'mock', reasons: [] },
  }),
  recipe('c.plain', { label: 'Plain' }),
];

function setup(on: string[] = ['a.on']) {
  const added: string[] = [];
  const providers = plannerProviders({
    recipes,
    isOn: (id) => on.includes(id),
    add: (id) => added.push(id),
    href: (tab) => `/?tab=${tab}`,
  });
  const byId = (id: string) => {
    const provider = providers.find((p) => p.id === id);
    if (!provider?.items) throw new Error(id);
    return provider.items({ signal: new AbortController().signal }) as {
      id: string;
      title: string;
      subtitle?: string;
      keywords?: readonly string[];
      href?: string;
      run?: (c: never) => unknown;
    }[];
  };
  return { added, byId };
}

describe('planner palette', () => {
  it('opens every planner tab through the app query', () => {
    const { byId } = setup();
    expect(byId('planner-tabs').map((i) => i.href)).toEqual(
      PLANNER_TAB_COMMANDS.map((t) => `/?tab=${t.id}`),
    );
  });

  it('offers to add only the features not yet on, with the demo label', () => {
    const { byId } = setup();
    const rows = byId('planner-features');
    expect(rows.map((r) => r.title)).toEqual(['Add Mailbox', 'Add Plain']);
    expect(rows[0].subtitle).toBe('Mock: b.mail summary');
    expect(rows[0].keywords).toEqual(['inbox']);
    expect(rows[1].subtitle).toBe('c.plain summary');
  });

  it('adds the feature and lands on the Features tab', async () => {
    const { added, byId } = setup();
    const navigate = vi.fn();
    await byId('planner-features')[0].run?.({ navigate } as never);
    expect(added).toEqual(['b.mail']);
    expect(navigate).toHaveBeenCalledWith('/?tab=features');
  });

  it('re-reads what is on each time it opens', () => {
    const on = ['a.on'];
    const { byId } = setup(on);
    expect(byId('planner-features')).toHaveLength(2);
    on.push('b.mail');
    expect(byId('planner-features').map((r) => r.id)).toEqual(['c.plain']);
  });
});
