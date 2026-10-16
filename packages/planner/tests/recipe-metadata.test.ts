import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assembleCatalog } from '../src/lib/catalog/generate/build.ts';
import {
  extractPackage,
  type RawPackage,
} from '../src/lib/catalog/generate/extract.ts';
import { readLocalPackages } from '../src/lib/catalog/generate/local.ts';
import {
  extractBrowser,
  extractDemo,
  extractRecipeMetadata,
} from '../src/lib/catalog/generate/recipe-metadata.ts';

const base = {
  id: 'chat.assistant',
  className: 'AssistantRecipe',
  label: 'Assistant',
  summary: 'Ask an AI assistant about the page you are on.',
  synonyms: [],
  models: ['@happyvertical/smrt-chat:ChatRoom'],
  nav: [],
  requires: [],
};

const assistant = {
  ...base,
  runtime: 'both',
  surfaces: [
    {
      kind: 'shell-widget',
      slot: 'header.end',
      export: '@happyvertical/smrt-chat/svelte#AssistantDock',
      label: 'Assistant',
      icon: 'bot',
    },
  ],
  providers: [
    {
      id: 'llm',
      kind: 'llm',
      options: ['openai', 'webllm'],
      required: true,
      secrets: ['OPENAI_API_KEY'],
      browserOptions: ['webllm'],
    },
  ],
  demoSeed: { data: { rooms: [] } },
  demo: {
    mode: 'server',
    reasons: ['The package needs a server.'],
  },
};

function raw(
  recipes: unknown,
  extra: Record<string, unknown> = {},
): RawPackage {
  return {
    packageName: '@happyvertical/smrt-chat',
    version: '1.0.0',
    description: 'Chat',
    knowledge: null,
    manifest: {
      packageName: '@happyvertical/smrt-chat',
      objects: {
        '@happyvertical/smrt-chat:ChatRoom': {
          className: 'ChatRoom',
          qualifiedName: '@happyvertical/smrt-chat:ChatRoom',
          collection: 'chat_rooms',
          fields: { name: { type: 'text' } },
          methods: {},
          decoratorConfig: {},
        },
      },
      recipes,
      ...extra,
    },
  };
}

describe('recipe metadata in the catalog', () => {
  it('carries surfaces, providers, runtime, demo seed and demo as authored', () => {
    const [recipe] = extractPackage(raw([assistant])).recipes ?? [];
    expect(recipe.surfaces).toEqual(assistant.surfaces);
    expect(recipe.providers).toEqual(assistant.providers);
    expect(recipe.runtime).toBe('both');
    expect(recipe.demoSeed).toEqual({ data: { rooms: [] } });
    expect(recipe.demo).toEqual(assistant.demo);
    expect('className' in recipe).toBe(false);
  });

  it('adds nothing to a recipe that declares none of it', () => {
    const [recipe] = extractPackage(raw([base])).recipes ?? [];
    expect(Object.keys(recipe)).not.toContain('surfaces');
    expect(Object.keys(recipe)).not.toContain('providers');
    expect(Object.keys(recipe)).not.toContain('runtime');
    expect(Object.keys(recipe)).not.toContain('demo');
  });

  it('prefers the knowledge artifact for recipes and browser', () => {
    const pkg = extractPackage({
      ...raw([base], { browser: { status: 'browser-safe' } }),
      knowledge: {
        recipes: [{ ...base, demo: { mode: 'live', reasons: [] } }],
        browser: { status: 'server-only', issues: ['#3624'] },
      },
    });
    expect(pkg.recipes?.[0].demo?.mode).toBe('live');
    expect(pkg.browser).toEqual({ status: 'server-only', issues: ['#3624'] });
  });

  it('reads the package browser capability from the manifest', () => {
    const pkg = extractPackage(
      raw([base], {
        browser: {
          status: 'server-only',
          issues: ['#3624'],
          reason: 'node:crypto',
          via: ['@happyvertical/smrt-tenancy'],
          extra: 1,
        },
      }),
    );
    expect(pkg.browser).toEqual({
      status: 'server-only',
      issues: ['#3624'],
      reason: 'node:crypto',
      via: ['@happyvertical/smrt-tenancy'],
    });
    expect(extractPackage(raw([base])).browser).toBeUndefined();
  });
});

describe('extractRecipeMetadata drops what the catalogue cannot render', () => {
  it('drops malformed and unknown surfaces, keeping the valid ones', () => {
    const { surfaces } = extractRecipeMetadata({
      surfaces: [
        { kind: 'route', path: '/x', export: 'pkg#X', label: 'X' },
        { kind: 'route', path: '/y', export: 'not-a-ref', label: 'Y' },
        { kind: 'route', export: 'pkg#Z', label: 'Z' },
        { kind: 'hologram', export: 'pkg#H', label: 'H' },
        { kind: 'settings-panel', export: 'pkg#P', label: 'Panel' },
        { kind: 'playground', export: 'pkg#Play' },
        { kind: 'widget', type: 'total', export: 'pkg#T', label: 'Total' },
        'junk',
      ],
    });
    expect(surfaces?.map((s) => s.kind)).toEqual([
      'route',
      'settings-panel',
      'playground',
      'widget',
    ]);
  });

  it('keeps provider secret names, drops providers without a boolean required', () => {
    const { providers } = extractRecipeMetadata({
      providers: [
        { id: 'smtp', kind: 'email', options: ['smtp'], required: true },
        { id: 'bad', kind: 'email', options: ['smtp'] },
        { id: 'bad2', kind: 'email', options: [1], required: false },
        {
          id: 'oauth',
          kind: 'oauth',
          options: ['google'],
          required: false,
          secrets: ['GOOGLE_CLIENT_SECRET'],
        },
      ],
    });
    expect(providers?.map((p) => p.id)).toEqual(['smtp', 'oauth']);
    expect(providers?.[1].secrets).toEqual(['GOOGLE_CLIENT_SECRET']);
  });

  it('accepts only known runtimes and demo modes', () => {
    expect(extractRecipeMetadata({ runtime: 'cloud' }).runtime).toBeUndefined();
    expect(extractRecipeMetadata({ runtime: 'server' }).runtime).toBe('server');
    expect(extractDemo({ mode: 'fast', reasons: [] })).toBeUndefined();
    expect(
      extractDemo({ mode: 'mock', reasons: ['x'], mocked: ['smtp'] }),
    ).toEqual({ mode: 'mock', reasons: ['x'], mocked: ['smtp'] });
    expect(extractDemo({ mode: 'live' })).toBeUndefined();
  });

  it('rejects a browser capability with an unknown status', () => {
    expect(extractBrowser({ status: 'maybe' })).toBeUndefined();
    expect(extractBrowser('server-only')).toBeUndefined();
  });
});

describe('effective demo', () => {
  const entry = (id: string, extra: Record<string, unknown>) => ({
    ...base,
    id,
    className: id,
    ...extra,
  });
  const pkg = (name: string, recipes: unknown[]): RawPackage => ({
    ...raw(recipes),
    packageName: `@happyvertical/smrt-${name}`,
    manifest: {
      ...raw(recipes).manifest,
      packageName: `@happyvertical/smrt-${name}`,
      objects: {
        [`@happyvertical/smrt-${name}:Thing`]: {
          className: 'Thing',
          qualifiedName: `@happyvertical/smrt-${name}:Thing`,
          collection: 'things',
          fields: { name: { type: 'text' } },
          methods: {},
          decoratorConfig: {},
        },
      },
      recipes,
    },
  });
  const catalog = assembleCatalog(
    [
      pkg('mail', [
        entry('mail.box', {
          demo: { mode: 'mock', reasons: ['SMTP is faked.'], mocked: ['smtp'] },
        }),
      ]),
      pkg('bell', [
        entry('bell.ring', {
          requires: ['mail.box'],
          demo: { mode: 'live', reasons: [] },
        }),
        entry('bell.plain', { demo: { mode: 'live', reasons: [] } }),
        entry('bell.unmeasured', { requires: ['mail.box'] }),
      ]),
    ],
    'x',
  );
  const recipe = (id: string) =>
    catalog.packages.flatMap((p) => p.recipes ?? []).find((r) => r.id === id);

  it("folds a requirement's mode across packages with smrt-core's rule", () => {
    expect(recipe('bell.ring')?.demo?.mode).toBe('live');
    expect(recipe('bell.ring')?.effectiveDemo?.mode).toBe('mock');
    expect(recipe('bell.ring')?.effectiveDemo?.reasons.join(' ')).toContain(
      'mail.box',
    );
  });

  it('writes nothing when the effective demo is the recipe own, or none was measured', () => {
    expect(recipe('mail.box')?.effectiveDemo).toBeUndefined();
    expect(recipe('bell.plain')?.effectiveDemo).toBeUndefined();
    expect(recipe('bell.unmeasured')?.demo).toBeUndefined();
    expect(recipe('bell.unmeasured')?.effectiveDemo).toBeUndefined();
  });
});

describe('catalog assembly and local sources', () => {
  it('is deterministic for the same inputs', () => {
    const a = assembleCatalog([raw([assistant])], 'x');
    const b = assembleCatalog([raw([assistant])], 'x');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.packages[0].recipes?.[0].demo?.mode).toBe('server');
  });

  it('reads recipes, demo and browser from a built checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'planner-recipe-metadata-'));
    try {
      const dist = join(root, 'packages', 'chat', 'dist');
      await mkdir(dist, { recursive: true });
      await writeFile(
        join(root, 'packages', 'chat', 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-chat',
          version: '2.0.0',
          description: 'Chat',
        }),
      );
      const { manifest } = raw([assistant], {
        browser: { status: 'server-only', issues: ['#3624'] },
      });
      await writeFile(join(dist, 'manifest.json'), JSON.stringify(manifest));
      const raws = await readLocalPackages(root);
      const catalog = assembleCatalog(raws, 'file://x');
      const pkg = catalog.packages[0];
      expect(pkg.recipes?.[0].providers?.[0].secrets).toEqual([
        'OPENAI_API_KEY',
      ]);
      expect(pkg.recipes?.[0].demo?.mode).toBe('server');
      expect(pkg.browser?.status).toBe('server-only');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
