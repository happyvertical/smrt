import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyThemePatch,
  buildResponseSchema,
  parseChange,
  type ThemeStore,
} from '../src/lib/assistant/change.ts';
import { buildMatchIndex, matchText } from '../src/lib/assistant/match.ts';
import { buildSystemPrompt } from '../src/lib/assistant/prompt.ts';
import { ThemeUndos } from '../src/lib/assistant/theme-undo.svelte.ts';
import {
  type ChatModel,
  createBrowserAssistantTransport,
} from '../src/lib/assistant/transport.ts';
import { loadCookbook, saveCookbook } from '../src/lib/cookbook/storage.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { parseCookbook } from '../src/lib/cookbook/validate.ts';
import { applyLibraryCookbook } from '../src/lib/library/apply.ts';
import {
  getLibraryCookbook,
  libraryCookbooks,
} from '../src/lib/library/index.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';
import { DEFAULT_SETTINGS } from '../src/lib/settings/app-settings.ts';
import { brandThemeId, resolveTheme } from '../src/lib/theme/runtime.ts';
import {
  describeTheme,
  normalizeHex,
  parseTheme,
  type ThemeSetting,
  themeEquals,
} from '../src/lib/theme/theme.ts';

beforeEach(() => recipeState.clear());

const base = { version: 1, recipes: [], policies: [] };

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  } as unknown as Storage & { data: Map<string, string> };
}

function memoryTheme(initial?: ThemeSetting) {
  let theme = initial;
  const store: ThemeStore = {
    read: () => theme,
    write: (next) => {
      theme = next;
    },
  };
  return { store, get: () => theme };
}

describe('theme validation', () => {
  it('normalises hex colours', () => {
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('C2410C')).toBe('#c2410c');
    expect(normalizeHex('red')).toBeNull();
    expect(normalizeHex('#12345')).toBeNull();
    expect(normalizeHex(7)).toBeNull();
  });

  it('accepts a preset, scheme and brand colour with an allowed font', () => {
    const result = parseTheme({
      preset: 'glass',
      colorScheme: 'dark',
      custom: { primary: '#B45309', fontFamily: 'Georgia' },
    });
    expect(result).toEqual({
      ok: true,
      theme: {
        preset: 'glass',
        colorScheme: 'dark',
        custom: { primary: '#b45309', fontFamily: 'Georgia' },
      },
    });
  });

  it('reads absent and empty as the default', () => {
    expect(parseTheme(undefined)).toEqual({ ok: true, theme: undefined });
    expect(parseTheme({})).toEqual({ ok: true, theme: undefined });
  });

  it.each([
    [{ preset: 'neon' }],
    [{ colorScheme: 'sepia' }],
    [{ custom: { primary: 'orange' } }],
    [{ custom: { primary: '#fff', fontFamily: 'Comic Sans' } }],
    [{ custom: 'red' }],
    ['dark'],
  ])('rejects %j', (value) => {
    expect(parseTheme(value).ok).toBe(false);
  });

  it('compares themes with defaults filled in', () => {
    expect(
      themeEquals(undefined, { preset: 'smrt', colorScheme: 'system' }),
    ).toBe(true);
    expect(themeEquals({ preset: 'glass' }, undefined)).toBe(false);
    expect(describeTheme({ preset: 'glass', colorScheme: 'dark' })).toBe(
      'glass, dark',
    );
  });
});

describe('theme in the document', () => {
  it('is validated on import and round-trips', () => {
    const theme = { preset: 'studio', colorScheme: 'light' };
    const ok = parseCookbook({ ...base, theme });
    expect(ok).toMatchObject({ ok: true, cookbook: { theme } });
    const bad = parseCookbook({ ...base, theme: { preset: 'neon' } });
    expect(bad.ok).toBe(false);
    // A saved value may name a preset a newer build lacks: keep the rest.
    const lenient = parseCookbook(
      { ...base, theme: { preset: 'neon' } },
      { dropUnknownRecipes: true },
    );
    expect(lenient.ok && lenient.cookbook.theme).toBeUndefined();
  });

  it('is absent in older files and stays absent', () => {
    const result = parseCookbook(base);
    expect(result.ok && 'theme' in result.cookbook).toBe(false);
  });

  it('persists with the document and migrates an old one as default', () => {
    const storage = memoryStorage();
    const store = new CookbookStore();
    store.hydrate('', storage);
    expect(store.snapshot().theme).toBeUndefined();
    store.setTheme({ custom: { primary: '#0f766e' }, colorScheme: 'dark' });
    expect(store.save()).toBe(true);
    const loaded = loadCookbook(storage);
    expect(loaded).toMatchObject({
      status: 'loaded',
      cookbook: {
        theme: { custom: { primary: '#0f766e' }, colorScheme: 'dark' },
      },
    });
    const again = new CookbookStore();
    again.hydrate('', storage);
    expect(again.theme).toEqual({
      custom: { primary: '#0f766e' },
      colorScheme: 'dark',
    });
    again.setTheme({});
    expect(again.snapshot().theme).toBeUndefined();
    store.reset();
    expect(store.theme).toBeUndefined();
    expect(saveCookbook(storage, store.snapshot())).toBe(true);
  });
});

describe('cookbook themes', () => {
  it('built-in cookbooks carry valid themes', () => {
    for (const cookbook of libraryCookbooks) {
      const result = parseCookbook(cookbook.document);
      expect(result.ok, cookbook.id).toBe(true);
      expect(cookbook.document.theme, cookbook.id).toBeDefined();
    }
  });

  it('applying one sets its theme; one without leaves the visitor theme', () => {
    const store = new CookbookStore();
    const bakery = getLibraryCookbook('bakery');
    if (!bakery) throw new Error('bakery missing');
    expect(applyLibraryCookbook(bakery, store, DEFAULT_SETTINGS).ok).toBe(true);
    expect(store.theme).toEqual(bakery.document.theme);
    const plain = {
      ...bakery,
      document: { ...bakery.document, theme: undefined },
    };
    store.setTheme({ preset: 'glass' });
    expect(applyLibraryCookbook(plain, store, DEFAULT_SETTINGS).ok).toBe(true);
    expect(store.theme).toEqual({ preset: 'glass' });
  });

  it('resolves a brand colour to a registered theme id, reused per colour', () => {
    const first = resolveTheme({
      custom: { primary: '#b45309' },
      colorScheme: 'dark',
    });
    expect(first).toEqual({
      preset: brandThemeId('#b45309'),
      colorScheme: 'dark',
    });
    expect(resolveTheme({ custom: { primary: '#b45309' } }).preset).toBe(
      first.preset,
    );
    const other = resolveTheme({
      custom: { primary: '#0f766e', fontFamily: 'Georgia' },
    });
    expect(other.preset).not.toBe(first.preset);
    expect(resolveTheme({ preset: 'glass' })).toEqual({
      preset: 'glass',
      colorScheme: 'system',
    });
    expect(resolveTheme(undefined)).toEqual({
      preset: 'smrt',
      colorScheme: 'system',
    });
  });
});

describe('assistant theme', () => {
  it('parses a preset, a brand colour and a scheme, dropping the rest', () => {
    const change = parseChange(
      JSON.stringify({
        reply: 'ok',
        add: [],
        remove: [],
        theme: {
          preset: 'glass',
          primary: '#D97706',
          colorScheme: 'dark',
          css: 'x',
        },
      }),
      recipes,
    );
    expect(change.theme).toEqual({
      preset: 'glass',
      primary: '#d97706',
      colorScheme: 'dark',
    });
    const bad = parseChange(
      '{"reply":"ok","add":[],"remove":[],"theme":{"preset":"neon","primary":"orange"}}',
      recipes,
    );
    expect(bad.theme).toEqual({});
  });

  it('adds theme to the schema only when asked', () => {
    const props = (withTheme: boolean) =>
      (
        buildResponseSchema(recipes, [], false, withTheme) as {
          properties: Record<string, unknown>;
        }
      ).properties;
    expect(props(false).theme).toBeUndefined();
    expect(props(true).theme).toMatchObject({ type: 'object' });
  });

  it('applies a patch tersely and returns the previous theme', () => {
    const mem = memoryTheme({ preset: 'glass', colorScheme: 'dark' });
    const applied = applyThemePatch(mem.store, { primary: '#d97706' });
    expect(applied?.text).toBe('Theme: brand colour #d97706, dark.');
    expect(applied?.previous).toEqual({ preset: 'glass', colorScheme: 'dark' });
    expect(mem.get()).toEqual({
      preset: 'glass',
      colorScheme: 'dark',
      custom: { primary: '#d97706' },
    });
    // A preset replaces the brand colour.
    applyThemePatch(mem.store, { preset: 'studio' });
    expect(mem.get()?.custom).toBeUndefined();
    expect(applyThemePatch(mem.store, { preset: 'studio' })).toBeNull();
    expect(applyThemePatch(mem.store, {})).toBeNull();
  });

  it('undoes a change, once', () => {
    const mem = memoryTheme({ preset: 'glass' });
    const undos = new ThemeUndos(mem.store);
    const applied = applyThemePatch(mem.store, { colorScheme: 'dark' });
    const ref = undos.record(applied?.previous);
    expect(mem.get()?.colorScheme).toBe('dark');
    undos.undo(ref.undoId);
    expect(mem.get()).toEqual({ preset: 'glass' });
    expect(undos.undos[ref.undoId].status).toBe('undone');
    mem.store.write({ preset: 'material' });
    undos.undo(ref.undoId);
    expect(mem.get()).toEqual({ preset: 'material' });
  });

  it('undo returns to the default when there was no theme', () => {
    const mem = memoryTheme();
    const undos = new ThemeUndos(mem.store);
    const applied = applyThemePatch(mem.store, { preset: 'glass' });
    const ref = undos.record(applied?.previous);
    undos.undo(ref.undoId);
    expect(mem.get()).toBeUndefined();
  });

  it('prompt: rule, example and current theme only when theming is on; stays small', () => {
    const on = buildSystemPrompt(
      recipes,
      [],
      libraryCookbooks,
      DEFAULT_SETTINGS,
      undefined,
      {
        current: { preset: 'glass' },
      },
    );
    expect(on).toContain('"theme"');
    expect(on).toContain('"make it warmer" -> ');
    expect(on).toContain('Theme: glass.');
    expect(on.length).toBeLessThan(4600);
    const off = buildSystemPrompt(
      recipes,
      [],
      libraryCookbooks,
      DEFAULT_SETTINGS,
    );
    expect(off).not.toContain('make it warmer');
    expect(off).not.toContain('Theme:');
  });

  it('keyword matching mentions theming in the hint', () => {
    const index = buildMatchIndex(recipes, libraryCookbooks, { theme: true });
    for (const text of [
      'change the theme',
      'use our brand colour',
      'switch to dark mode',
      'make the colors warmer',
      'new font',
    ]) {
      expect(
        matchText(index, text).some((m) => m.kind === 'theme'),
        text,
      ).toBe(true);
    }
    const prompt = buildSystemPrompt(
      recipes,
      [],
      libraryCookbooks,
      DEFAULT_SETTINGS,
      matchText(index, 'I want dark mode'),
      { current: undefined },
    );
    expect(prompt).toMatch(/Looks relevant: theming/);
    // Without theme keywords in the index nothing changes.
    const plain = buildMatchIndex(recipes, libraryCookbooks);
    expect(
      matchText(plain, 'change the theme').some((m) => m.kind === 'theme'),
    ).toBe(false);
  });

  it('the transport applies a theme live and carries an Undo', async () => {
    const mem = memoryTheme();
    const undos = new ThemeUndos(mem.store);
    const model: ChatModel = {
      message: async () =>
        JSON.stringify({
          reply: 'Warmed it up.',
          add: [],
          remove: [],
          theme: { primary: '#d97706' },
        }),
    };
    const transport = createBrowserAssistantTransport({
      model: () => model,
      store: recipeState,
      recipes,
      theme: mem.store,
      themeUndos: undos,
    });
    const result = await transport.sendMessage({
      threadId: 'planner',
      content: 'make it warmer',
      clientRequestId: 'r1',
    });
    expect(mem.get()?.custom?.primary).toBe('#d97706');
    expect(result.assistantMessage?.content).toContain('Warmed it up.');
    expect(result.assistantMessage?.content).toContain(
      'Theme: brand colour #d97706.',
    );
    const ref = result.assistantMessage?.toolCallData as {
      kind: string;
      undoId: string;
    };
    expect(ref.kind).toBe('theme-undo');
    undos.undo(ref.undoId);
    expect(mem.get()).toBeUndefined();
  });
});
