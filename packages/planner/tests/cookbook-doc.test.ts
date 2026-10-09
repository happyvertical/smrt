import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportFileName } from '../src/lib/cookbook/file.ts';
import { cookbookFromLegacySearch } from '../src/lib/cookbook/legacy.ts';
import {
  BACKUP_KEY,
  loadCookbook,
  PREVIOUS_STORAGE_KEY,
  STORAGE_KEY,
  saveCookbook,
  UNREADABLE_KEY,
} from '../src/lib/cookbook/storage.ts';
import {
  CookbookStore,
  SAVE_DELAY_MS,
} from '../src/lib/cookbook/store.svelte.ts';
import { COOKBOOK_SCHEMA, PREVIOUS_SCHEMA } from '../src/lib/cookbook/types.ts';
import {
  parseCookbook,
  parseCookbookText,
} from '../src/lib/cookbook/validate.ts';
import { selection } from '../src/lib/planner/selection.svelte.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const ORDER = '@happyvertical/smrt-commerce:Order';
// `?o=` as the planner encoded it before the cookbook: one Order `notes` row
// (hidden, label "Memo é", help null, default '"hi"', order 4) and `cli`, `mcp`
// narrowed on Order.
const LEGACY_O =
  'eyJyIjp7IkBoYXBweXZlcnRpY2FsL3NtcnQtY29tbWVyY2U6T3JkZXIiOnsibm90ZXMiOnsidiI6ImhpZGRlbiIsImwiOiJNZW1vIMOpIiwiaCI6bnVsbCwiZCI6IlwiaGlcIiIsIm8iOjR9fX0sIngiOnsiQGhhcHB5dmVydGljYWwvc21ydC1jb21tZXJjZTpPcmRlciI6WyJjbGkiLCJtY3AiXX19';

const valid = {
  $schema: COOKBOOK_SCHEMA,
  version: 1,
  recipes: ['commerce.sales'],
  policies: [
    {
      objectRef: ORDER,
      fieldName: 'notes',
      scopeType: 'app',
      visibility: 'hidden',
      label: 'Memo',
      help: null,
      displayOrder: 4,
      locked: false,
    },
  ],
  exposure: { [ORDER]: ['cli'] },
};

/** A Storage double; `broken` makes every call throw like private mode. */
function fakeStorage(broken = false) {
  const data = new Map<string, string>();
  const fail = () => {
    throw new DOMException('denied', 'SecurityError');
  };
  return {
    data,
    getItem: (k: string) => (broken ? fail() : (data.get(k) ?? null)),
    setItem: (k: string, v: string) => (broken ? fail() : void data.set(k, v)),
    removeItem: (k: string) => (broken ? fail() : void data.delete(k)),
  } as unknown as Storage & { data: Map<string, string> };
}

describe('parseCookbook', () => {
  it('accepts a valid cookbook and pulls in required recipes', () => {
    const result = parseCookbook(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.cookbook.recipes).toEqual([
      'commerce.customers',
      'commerce.sales',
    ]);
    expect(result.cookbook.policies).toEqual(valid.policies);
    expect(result.cookbook.exposure).toEqual({ [ORDER]: ['cli'] });
    expect(result.cookbook.layout).toBeUndefined();
  });

  it('accepts a layout in the ShellLayout shape and keeps it', () => {
    const layout = {
      version: 1,
      hidden: ['x'],
      panels: { left: { visible: false } },
    };
    const result = parseCookbook({ ...valid, layout });
    expect(result.ok && result.cookbook.layout).toEqual(layout);
  });

  it.each([
    ['not an object', [], /expected a JSON object/],
    ['null', null, /expected a JSON object/],
    ['no version', { recipes: [], policies: [] }, /no "version"/],
    ['string version', { ...valid, version: '1' }, /whole number/],
    ['newer version', { ...valid, version: 2 }, /newer than this planner/],
    ['old version', { ...valid, version: 0 }, /not supported/],
    ['recipes not a list', { ...valid, recipes: 'x' }, /"recipes"/],
    ['policies not a list', { ...valid, policies: {} }, /"policies"/],
    ['row not object', { ...valid, policies: [1] }, /policies\[0\]/],
    [
      'row wrong scope',
      {
        ...valid,
        policies: [{ objectRef: ORDER, fieldName: 'a', scopeType: 'org' }],
      },
      /scopeType/,
    ],
    [
      'row bad visibility',
      {
        ...valid,
        policies: [
          {
            objectRef: ORDER,
            fieldName: 'a',
            scopeType: 'app',
            visibility: 'x',
          },
        ],
      },
      /visibility/,
    ],
    [
      'bad exposure surface',
      { ...valid, exposure: { [ORDER]: ['ftp'] } },
      /exposure/,
    ],
    ['bad layout', { ...valid, layout: { version: 2 } }, /layout/],
  ])('rejects %s', (_name, input, message) => {
    const result = parseCookbook(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it('rejects non-JSON text', () => {
    const result = parseCookbookText('{oops');
    expect(result).toEqual({
      ok: false,
      error: 'This file is not valid JSON.',
    });
  });
});

describe('storage', () => {
  it('round-trips through a Storage', () => {
    const storage = fakeStorage();
    const parsed = parseCookbook(valid);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(saveCookbook(storage, parsed.cookbook)).toBe(true);
    expect(loadCookbook(storage)).toEqual({
      status: 'loaded',
      cookbook: parsed.cookbook,
      previousKept: false,
    });
  });

  it('reports empty, and unavailable without throwing', () => {
    expect(loadCookbook(fakeStorage()).status).toBe('empty');
    expect(loadCookbook(null).status).toBe('unavailable');
    expect(loadCookbook(fakeStorage(true)).status).toBe('unavailable');
    const parsed = parseCookbook(valid);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(saveCookbook(fakeStorage(true), parsed.cookbook)).toBe(false);
    expect(saveCookbook(null, parsed.cookbook)).toBe(false);
  });

  it('keeps an unreadable value aside instead of losing it', () => {
    const storage = fakeStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...valid, version: 9 }));
    const outcome = loadCookbook(storage);
    expect(outcome.status).toBe('unreadable');
    expect(storage.data.get(UNREADABLE_KEY)).toContain('"version":9');
  });
});

describe('legacy url migration', () => {
  it('imports ?r= and ?o= into a cookbook', () => {
    const bp = cookbookFromLegacySearch(
      `?p=x&r=commerce.sales,bogus&o=${LEGACY_O}`,
    );
    expect(bp.recipes).toEqual(['commerce.customers', 'commerce.sales']);
    expect(bp.policies).toEqual([
      {
        objectRef: ORDER,
        fieldName: 'notes',
        scopeType: 'app',
        visibility: 'hidden',
        label: 'Memo é',
        help: null,
        defaultValue: '"hi"',
        displayOrder: 4,
      },
    ]);
    expect(bp.exposure).toEqual({ [ORDER]: ['cli', 'mcp'] });
    expect(parseCookbook(bp).ok).toBe(true);
  });

  it('survives garbage options', () => {
    const bp = cookbookFromLegacySearch('?r=commerce.vendors&o=%%%');
    expect(bp.recipes).toEqual(['commerce.vendors']);
    expect(bp.policies).toEqual([]);
  });
});

describe('CookbookStore', () => {
  let store: CookbookStore;
  beforeEach(() => {
    vi.useFakeTimers();
    recipeState.clear();
    selection.clear();
    store = new CookbookStore();
  });
  afterEach(() => vi.useRealTimers());

  it('does not save before the saved cookbook is read', () => {
    const storage = fakeStorage();
    store.scheduleSave();
    vi.advanceTimersByTime(SAVE_DELAY_MS * 2);
    expect(storage.data.size).toBe(0);
  });

  it('saves debounced and reloads the same app', () => {
    const storage = fakeStorage();
    store.hydrate('', storage);
    recipeState.add('commerce.sales');
    store.scheduleSave();
    store.scheduleSave();
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(store.persist).toBe('ok');
    const saved = store.snapshot();

    recipeState.clear();
    const fresh = new CookbookStore();
    expect(fresh.hydrate('', storage)).toBe(false);
    expect(fresh.snapshot()).toEqual(saved);
    expect(recipeState.ids).toEqual(['commerce.customers', 'commerce.sales']);
  });

  it('works in memory with a notice state when storage throws', () => {
    store.hydrate('', fakeStorage(true));
    expect(store.persist).toBe('memory');
    recipeState.add('commerce.vendors');
    expect(() => store.save()).not.toThrow();
    expect(store.persist).toBe('memory');
    expect(recipeState.ids).toContain('commerce.vendors');
  });

  it('migrates a legacy link once, saves it, and backs up what it replaced', () => {
    const storage = fakeStorage();
    recipeState.add('commerce.vendors');
    const first = new CookbookStore();
    first.hydrate('', storage);
    first.save();
    const before = storage.data.get(STORAGE_KEY);

    recipeState.clear();
    const migrated = store.hydrate(`?r=commerce.sales&o=${LEGACY_O}`, storage);
    expect(migrated).toBe(true);
    expect(recipeState.ids).toEqual(['commerce.customers', 'commerce.sales']);
    expect(
      JSON.parse(storage.data.get(STORAGE_KEY) ?? '').policies,
    ).toHaveLength(1);
    expect(storage.data.get(BACKUP_KEY)).toBe(before);

    // A later plain load reads the cookbook and migrates nothing.
    const again = new CookbookStore();
    expect(again.hydrate('', storage)).toBe(false);
    expect(recipeState.ids).toEqual(['commerce.customers', 'commerce.sales']);
  });

  it('starts empty with a notice when the saved cookbook is unreadable', () => {
    const storage = fakeStorage();
    storage.setItem(STORAGE_KEY, '{nope');
    store.hydrate('', storage);
    expect(store.loadNotice).toMatch(/could not be read/);
    expect(recipeState.ids).toEqual([]);
    expect(storage.data.get(UNREADABLE_KEY)).toBe('{nope');
  });

  it('layout edits from the shell are stored, and an empty one clears it', () => {
    store.hydrate('', fakeStorage());
    store.setLayout({ version: 1, hidden: ['planner'] });
    expect(store.snapshot().layout).toEqual({
      version: 1,
      hidden: ['planner'],
    });
    store.setLayout({ version: 1 });
    expect(store.snapshot().layout).toBeUndefined();
  });

  it('export then import reproduces the same cookbook; bad import changes nothing', () => {
    store.hydrate('', fakeStorage());
    recipeState.add('commerce.sales');
    recipeState.save(ORDER, [valid.policies[0] as never], ['cli']);
    store.layout = { version: 1, hidden: ['a'] };
    const text = JSON.stringify(store.snapshot());

    store.reset();
    expect(store.snapshot().recipes).toEqual([]);
    expect(store.importText(text).ok).toBe(true);
    expect(store.snapshot()).toEqual(JSON.parse(text));

    const before = JSON.stringify(store.snapshot());
    expect(store.importText('{"version":3}').ok).toBe(false);
    expect(JSON.stringify(store.snapshot())).toBe(before);
  });
});

describe('review fixes', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    recipeState.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('keeps unknown recipes and features through load, save and reload', () => {
    const storage = fakeStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...valid,
        recipes: ['commerce.sales', 'gone.recipe', 'newer.recipe'],
        features: ['@x/gone:Thing'],
      }),
    );
    const store = new CookbookStore();
    store.hydrate('', storage);
    expect(recipeState.ids).not.toContain('gone.recipe');
    expect(store.unavailableNotice).toMatch(
      /^3 recipes in this cookbook aren't available in this version: gone.recipe, newer.recipe, @x\/gone:Thing/,
    );
    store.save();
    const saved = JSON.parse(storage.data.get(STORAGE_KEY) ?? '{}');
    expect(saved.recipes).toEqual(
      expect.arrayContaining(['gone.recipe', 'newer.recipe']),
    );
    expect(saved.features).toEqual(['@x/gone:Thing']);
    // Export carries them too, and a fresh load shows the same notice.
    const again = new CookbookStore();
    expect(again.importText(JSON.stringify(store.snapshot())).ok).toBe(true);
    expect(again.unavailableNotice).toBe(store.unavailableNotice);
    expect(store.snapshot().recipes).toContain('gone.recipe');
  });

  it('removes unavailable ids only on explicit request', () => {
    const storage = fakeStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...valid, recipes: ['commerce.sales', 'gone.recipe'] }),
    );
    const store = new CookbookStore();
    store.hydrate('', storage);
    expect(store.unavailableNotice).toMatch(/1 recipe in this cookbook isn't/);
    store.removeUnavailable();
    expect(store.unavailableNotice).toBe('');
    expect(store.snapshot().recipes).not.toContain('gone.recipe');
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(
      JSON.parse(storage.data.get(STORAGE_KEY) ?? '{}').recipes,
    ).not.toContain('gone.recipe');
  });

  it('clears the notice when everything is reset', () => {
    const store = new CookbookStore();
    store.importText(JSON.stringify({ ...valid, recipes: ['gone.recipe'] }));
    expect(store.unavailableNotice).not.toBe('');
    store.reset();
    expect(store.unavailableNotice).toBe('');
  });

  it('stored cookbooks keep unknown recipes unapplied; imports do too', () => {
    const storage = fakeStorage();
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ ...valid, recipes: ['commerce.sales', 'gone.recipe'] }),
    );
    const outcome = loadCookbook(storage);
    expect(outcome.status === 'loaded' && outcome.cookbook.recipes).toEqual([
      'commerce.customers',
      'commerce.sales',
      'gone.recipe',
    ]);
    expect(
      parseCookbook({ ...valid, recipes: ['commerce.sales', 'gone.recipe'] })
        .ok,
    ).toBe(true);
  });

  it('drops options for uncovered models and keeps a __proto__ key as data', () => {
    const text = `{"version":1,"recipes":["commerce.vendors"],"policies":[{"objectRef":"${ORDER}","fieldName":"notes","scopeType":"app"}],"exposure":{"__proto__":["cli"]}}`;
    const result = parseCookbookText(text);
    expect(result.ok && result.cookbook.policies).toEqual([]);
    expect(result.ok && result.cookbook.exposure).toBeUndefined();
    expect(({} as Record<string, unknown>).cli).toBeUndefined();
  });

  it('never overwrites an unreadable value that could not be kept aside', () => {
    const storage = fakeStorage();
    storage.setItem(STORAGE_KEY, '{nope');
    const failAside = storage.setItem.bind(storage);
    storage.setItem = (k: string, v: string) => {
      if (k === UNREADABLE_KEY) throw new Error('quota');
      failAside(k, v);
    };
    const store = new CookbookStore();
    store.hydrate('', storage);
    expect(store.loadNotice).toMatch(/without overwriting/);
    store.scheduleSave();
    vi.advanceTimersByTime(SAVE_DELAY_MS);
    expect(storage.data.get(STORAGE_KEY)).toBe('{nope');
    // An import is the visitor's decision to replace it.
    const imported = store.importText(JSON.stringify(valid));
    expect(imported.ok).toBe(true);
    store.save();
    expect(storage.data.get(STORAGE_KEY)).toContain('commerce.sales');
  });

  it('keeps the legacy URL when the migrated cookbook could not be stored', () => {
    const store = new CookbookStore();
    store.hydrate('?r=commerce.vendors', fakeStorage(true));
    expect(store.keepLegacyUrl).toBe(true);
    const ok = new CookbookStore();
    ok.hydrate('?r=commerce.vendors', fakeStorage());
    expect(ok.keepLegacyUrl).toBe(false);
  });

  it('does not replace a saved cookbook when its backup cannot be written', () => {
    const storage = fakeStorage();
    const first = new CookbookStore();
    first.hydrate('', storage);
    recipeState.add('commerce.vendors');
    first.save();
    const before = storage.data.get(STORAGE_KEY);
    const real = storage.setItem.bind(storage);
    storage.setItem = (k: string, v: string) => {
      if (k === BACKUP_KEY) throw new Error('quota');
      real(k, v);
    };
    const store = new CookbookStore();
    store.hydrate('?r=commerce.sales', storage);
    expect(storage.data.get(STORAGE_KEY)).toBe(before);
    expect(store.keepLegacyUrl).toBe(true);
  });
});

describe('legacy url retention', () => {
  it('releases the legacy URL once the cookbook is stored or replaced', () => {
    vi.useFakeTimers();
    const storage = fakeStorage();
    const real = storage.setItem.bind(storage);
    let broken = true;
    storage.setItem = (k: string, v: string) => {
      if (broken) throw new Error('quota');
      real(k, v);
    };
    const store = new CookbookStore();
    store.hydrate('?r=commerce.vendors', storage);
    expect(store.keepLegacyUrl).toBe(true);
    broken = false;
    store.save();
    expect(store.keepLegacyUrl).toBe(false);
    vi.useRealTimers();
  });
});

describe('rename from blueprint', () => {
  const previousDoc = {
    ...valid,
    $schema: PREVIOUS_SCHEMA,
    theme: { preset: 'glass' },
  };

  it('uses distinct keys for the document and the library selection', () => {
    expect(STORAGE_KEY).toBe('smrt-planner:cookbook-doc:v1');
    expect(PREVIOUS_STORAGE_KEY).toBe('smrt-planner:blueprint:v1');
    expect(STORAGE_KEY).not.toBe('smrt-planner:cookbook');
  });

  it('reads the old key into the new one and keeps the old as backup', () => {
    const storage = fakeStorage();
    storage.setItem(PREVIOUS_STORAGE_KEY, JSON.stringify(previousDoc));
    const outcome = loadCookbook(storage);
    expect(outcome).toMatchObject({
      status: 'loaded',
      previousKept: true,
      cookbook: { $schema: COOKBOOK_SCHEMA, theme: { preset: 'glass' } },
    });
    // Written under the new key with the new schema; the old key is untouched.
    expect(JSON.parse(storage.data.get(STORAGE_KEY) ?? '{}').$schema).toBe(
      COOKBOOK_SCHEMA,
    );
    expect(storage.data.get(PREVIOUS_STORAGE_KEY)).toBe(
      JSON.stringify(previousDoc),
    );
  });

  it('removes the old key only after the next successful save', () => {
    const storage = fakeStorage();
    storage.setItem(PREVIOUS_STORAGE_KEY, JSON.stringify(previousDoc));
    const store = new CookbookStore();
    store.hydrate('', storage);
    expect(store.theme).toEqual({ preset: 'glass' });
    expect(recipeState.ids).toContain('commerce.sales');
    expect(storage.data.has(PREVIOUS_STORAGE_KEY)).toBe(true);
    expect(store.save()).toBe(true);
    expect(storage.data.has(PREVIOUS_STORAGE_KEY)).toBe(false);
    expect(storage.data.has(STORAGE_KEY)).toBe(true);
  });

  it('keeps the old key when the save fails', () => {
    const storage = fakeStorage();
    storage.setItem(PREVIOUS_STORAGE_KEY, JSON.stringify(previousDoc));
    const store = new CookbookStore();
    store.hydrate('', storage);
    storage.setItem = () => {
      throw new DOMException('full', 'QuotaExceededError');
    };
    expect(store.save()).toBe(false);
    expect(storage.data.has(PREVIOUS_STORAGE_KEY)).toBe(true);
  });

  it('prefers the new key when both exist, and still cleans up the old', () => {
    const storage = fakeStorage();
    storage.setItem(PREVIOUS_STORAGE_KEY, JSON.stringify(previousDoc));
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...valid,
        recipes: [],
        policies: [],
        exposure: undefined,
      }),
    );
    const store = new CookbookStore();
    store.hydrate('', storage);
    expect(recipeState.ids).toEqual([]);
    store.save();
    expect(storage.data.has(PREVIOUS_STORAGE_KEY)).toBe(false);
  });

  it('an unreadable old value is kept aside, not migrated', () => {
    const storage = fakeStorage();
    storage.setItem(PREVIOUS_STORAGE_KEY, '{nope');
    expect(loadCookbook(storage)).toMatchObject({ status: 'unreadable' });
    expect(storage.data.get(UNREADABLE_KEY)).toBe('{nope');
    expect(storage.data.has(STORAGE_KEY)).toBe(false);
  });

  it('import accepts both schema URLs and rejects others', () => {
    expect(parseCookbook({ ...valid, $schema: PREVIOUS_SCHEMA }).ok).toBe(true);
    expect(parseCookbook({ ...valid, $schema: COOKBOOK_SCHEMA }).ok).toBe(true);
    const { $schema: _omit, ...bare } = valid;
    expect(parseCookbook(bare).ok).toBe(true);
    const bad = parseCookbook({
      ...valid,
      $schema: 'https://example.com/x.json',
    });
    expect(bad.ok).toBe(false);
    // An imported old file is normalised to the new schema.
    const imported = parseCookbook({ ...valid, $schema: PREVIOUS_SCHEMA });
    expect(imported.ok && imported.cookbook.$schema).toBe(COOKBOOK_SCHEMA);
  });

  it('names the export file <name>.cookbook.json', () => {
    expect(exportFileName('Yoga studio')).toBe('yoga-studio.cookbook.json');
    expect(exportFileName(' Café & Bar! ')).toBe('cafe-bar.cookbook.json');
    expect(exportFileName()).toBe('my-app.cookbook.json');
    expect(exportFileName('***')).toBe('my-app.cookbook.json');
  });
});

describe('malformed layouts', () => {
  const doc = (layout: unknown) =>
    JSON.stringify({
      $schema: COOKBOOK_SCHEMA,
      version: 1,
      recipes: [],
      features: [],
      policies: [],
      layout,
    });

  it('rejects bad itemOrder and moved values without throwing', () => {
    for (const layout of [
      { version: 1, itemOrder: { 'section:a': 'x' } },
      { version: 1, moved: { a: 1 } },
      JSON.parse('{"version":1,"itemOrder":{"__proto__":["a"]}}'),
    ]) {
      expect(parseCookbookText(doc(layout)).ok).toBe(false);
    }
  });
});
