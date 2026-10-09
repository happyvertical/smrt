import type {
  PackageBrowserCapability,
  RecipeDefinition,
  RecipeProvider,
} from '@happyvertical/smrt-types';
import { describe, expect, it } from 'vitest';
import {
  deriveRecipeDemo,
  effectiveRecipeDemo,
  isMockableProvider,
  isServerProvider,
} from '../recipe-demo.js';

const SAFE: PackageBrowserCapability = { status: 'browser-safe' };
const SERVER: PackageBrowserCapability = {
  status: 'server-only',
  issues: ['#3624'],
  reason: 'node:crypto',
};

const smtp: RecipeProvider = {
  id: 'smtp',
  kind: 'email',
  options: ['smtp', 'gmail'],
  required: true,
  secrets: ['SMTP_PASSWORD'],
};
const mockableSmtp: RecipeProvider = {
  ...smtp,
  options: ['smtp', 'mock'],
};
const local: RecipeProvider = {
  id: 'blobs',
  kind: 'storage',
  options: ['opfs'],
  required: true,
};

function derive(
  declared: Partial<RecipeDefinition>,
  capability?: PackageBrowserCapability,
) {
  return deriveRecipeDemo({ id: 'shop.x', ...declared }, capability);
}

describe('provider rules', () => {
  it('treats a provider that lists secrets as a server provider', () => {
    expect(isServerProvider(smtp)).toBe(true);
    expect(isServerProvider(local)).toBe(false);
    expect(isMockableProvider(mockableSmtp)).toBe(true);
    expect(isMockableProvider(smtp)).toBe(false);
  });
});

describe('deriveRecipeDemo', () => {
  it('is live when the package is browser-safe and the recipe declares nothing', () => {
    const { demo, problems } = derive({}, SAFE);
    expect(problems).toEqual([]);
    expect(demo?.mode).toBe('live');
    expect(demo?.mocked).toBeUndefined();
  });

  it('emits nothing when the package is unmeasured and nothing is declared', () => {
    expect(derive({})).toEqual({ problems: [] });
  });

  it('classifies from declarations alone when the package is unmeasured', () => {
    const { demo } = derive({ providers: [mockableSmtp] });
    expect(demo?.mode).toBe('mock');
    expect(demo?.reasons.at(-1)).toMatch(/not measured/);
  });

  it('refines an omitted or explicit "both" runtime with the bundle-gate', () => {
    for (const runtime of [undefined, 'both' as const]) {
      const { demo, problems } = derive({ runtime }, SERVER);
      expect(problems).toEqual([]);
      expect(demo?.mode).toBe('server');
      expect(demo?.reasons[0]).toMatch(/node:crypto.*#3624/);
    }
  });

  it('describes an inherited failure by the package it comes through', () => {
    const { demo } = derive(
      {},
      { status: 'server-only', issues: ['#3624'], via: ['@x/chat'] },
    );
    expect(demo?.reasons[0]).toMatch(/depends on @x\/chat/);
  });

  it('is server when the recipe declares runtime "server"', () => {
    expect(derive({ runtime: 'server' }, SAFE).demo?.mode).toBe('server');
  });

  it('is mock when a server provider can be faked', () => {
    const { demo } = derive({ providers: [mockableSmtp] }, SAFE);
    expect(demo).toMatchObject({ mode: 'mock', mocked: ['smtp'] });
  });

  it('is mock for an optional mockable provider too', () => {
    const { demo } = derive(
      { providers: [{ ...mockableSmtp, required: false }] },
      SAFE,
    );
    expect(demo?.mode).toBe('mock');
  });

  it('is server when a required server provider cannot be faked and no seed exists', () => {
    const { demo } = derive({ providers: [smtp] }, SAFE);
    expect(demo?.mode).toBe('server');
    expect(demo?.reasons[0]).toMatch(/Required provider smtp/);
  });

  it('is sample when the same recipe ships a demo seed', () => {
    const { demo } = derive(
      { providers: [smtp], demoSeed: { data: { rows: [] } } },
      SAFE,
    );
    expect(demo?.mode).toBe('sample');
  });

  it('keeps an optional unmockable provider live and says so', () => {
    const { demo } = derive(
      { providers: [{ ...smtp, required: false }] },
      SAFE,
    );
    expect(demo?.mode).toBe('live');
    expect(demo?.reasons.join(' ')).toMatch(/Optional provider smtp/);
  });

  it('ignores providers without secrets', () => {
    expect(derive({ providers: [local] }, SAFE).demo?.mode).toBe('live');
  });

  it('lets the worst reason win and lists the faked providers', () => {
    const { demo } = derive(
      {
        providers: [mockableSmtp, { ...smtp, id: 'oauth', kind: 'oauth' }],
        demoSeed: { data: { a: 1 } },
      },
      SAFE,
    );
    expect(demo).toMatchObject({ mode: 'sample', mocked: ['smtp'] });
  });

  describe('contradictions', () => {
    it('rejects runtime "browser" on a server-only package', () => {
      const { problems } = derive({ runtime: 'browser' }, SERVER);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/shop\.x.*"browser".*#3624/);
    });

    it('rejects runtime "browser" beside a required server provider', () => {
      const { problems } = derive(
        { runtime: 'browser', providers: [smtp] },
        SAFE,
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/provider "smtp".*SMTP_PASSWORD/);
    });

    it('reports every contradiction', () => {
      expect(
        derive({ runtime: 'browser', providers: [smtp] }, SERVER).problems,
      ).toHaveLength(2);
    });

    it('allows runtime "browser" with a mockable or optional provider', () => {
      expect(
        derive({ runtime: 'browser', providers: [mockableSmtp] }, SAFE)
          .problems,
      ).toEqual([]);
      expect(
        derive(
          { runtime: 'browser', providers: [{ ...smtp, required: false }] },
          SAFE,
        ).problems,
      ).toEqual([]);
    });

    it('allows runtime "both" and "server" on a server-only package', () => {
      expect(derive({ runtime: 'both' }, SERVER).problems).toEqual([]);
      expect(derive({ runtime: 'server' }, SERVER).problems).toEqual([]);
    });

    it('cannot judge a browser runtime on an unmeasured package', () => {
      expect(derive({ runtime: 'browser' }).problems).toEqual([]);
    });
  });
});

describe('effectiveRecipeDemo', () => {
  const entry = (
    id: string,
    mode: 'live' | 'mock' | 'sample' | 'server',
    extra: Partial<RecipeDefinition> = {},
  ) => ({
    id,
    requires: [] as string[],
    demo: { mode, reasons: [`${id} is ${mode}`] },
    ...extra,
  });

  it("is the recipe's own demo when it needs nothing", () => {
    expect(effectiveRecipeDemo('a', [entry('a', 'mock')])?.mode).toBe('mock');
  });

  it('takes the worst of the recipe and what it requires, transitively', () => {
    const recipes = [
      entry('a', 'live', { requires: ['b'] }),
      entry('b', 'mock', { requires: ['c'] }),
      entry('c', 'server'),
    ];
    const demo = effectiveRecipeDemo('a', recipes);
    expect(demo?.mode).toBe('server');
    expect(demo?.reasons.join(' ')).toMatch(/Needs b, which is server/);
  });

  it('uses the best known alternative of each requiresAny list', () => {
    const recipes = [
      entry('a', 'live', { requiresAny: [['b', 'c']] }),
      entry('b', 'server'),
      entry('c', 'sample'),
    ];
    expect(effectiveRecipeDemo('a', recipes)?.mode).toBe('sample');
  });

  it('ignores unknown or demo-less recipes', () => {
    const recipes = [
      entry('a', 'live', { requires: ['gone', 'b'], requiresAny: [['gone']] }),
      { id: 'b', requires: [] as string[] },
    ];
    expect(effectiveRecipeDemo('a', recipes)?.mode).toBe('live');
    expect(effectiveRecipeDemo('b', recipes)).toBeUndefined();
    expect(effectiveRecipeDemo('missing', recipes)).toBeUndefined();
  });

  it('terminates on a requires cycle', () => {
    const recipes = [
      entry('a', 'live', { requires: ['b'] }),
      entry('b', 'sample', { requires: ['a'] }),
    ];
    expect(effectiveRecipeDemo('a', recipes)?.mode).toBe('sample');
  });
});
