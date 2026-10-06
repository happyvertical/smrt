import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blueprintFromLegacySearch } from '../src/lib/blueprint/legacy.ts';
import {
  BACKUP_KEY,
  loadBlueprint,
  STORAGE_KEY,
  saveBlueprint,
  UNREADABLE_KEY,
} from '../src/lib/blueprint/storage.ts';
import {
  BlueprintStore,
  SAVE_DELAY_MS,
} from '../src/lib/blueprint/store.svelte.ts';
import { BLUEPRINT_SCHEMA } from '../src/lib/blueprint/types.ts';
import {
  parseBlueprint,
  parseBlueprintText,
} from '../src/lib/blueprint/validate.ts';
import { selection } from '../src/lib/planner/selection.svelte.ts';
import { recipeState } from '../src/lib/recipes/state.svelte.ts';

const ORDER = '@happyvertical/smrt-commerce:Order';
// `?o=` as the planner encoded it before the blueprint: one Order `notes` row
// (hidden, label "Memo é", help null, default '"hi"', order 4) and `cli`, `mcp`
// narrowed on Order.
const LEGACY_O =
  'eyJyIjp7IkBoYXBweXZlcnRpY2FsL3NtcnQtY29tbWVyY2U6T3JkZXIiOnsibm90ZXMiOnsidiI6ImhpZGRlbiIsImwiOiJNZW1vIMOpIiwiaCI6bnVsbCwiZCI6IlwiaGlcIiIsIm8iOjR9fX0sIngiOnsiQGhhcHB5dmVydGljYWwvc21ydC1jb21tZXJjZTpPcmRlciI6WyJjbGkiLCJtY3AiXX19';

const valid = {
  $schema: BLUEPRINT_SCHEMA,
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
  } as unknown as Storage & { data: Map<string, string> };
}

describe('parseBlueprint', () => {
  it('accepts a valid blueprint and pulls in required recipes', () => {
    const result = parseBlueprint(valid);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.blueprint.recipes).toEqual([
      'commerce.customers',
      'commerce.sales',
    ]);
    expect(result.blueprint.policies).toEqual(valid.policies);
    expect(result.blueprint.exposure).toEqual({ [ORDER]: ['cli'] });
    expect(result.blueprint.layout).toBeUndefined();
  });

  it('accepts a layout in the ShellLayout shape and keeps it', () => {
    const layout = {
      version: 1,
      hidden: ['x'],
      panels: { left: { visible: false } },
    };
    const result = parseBlueprint({ ...valid, layout });
    expect(result.ok && result.blueprint.layout).toEqual(layout);
  });

  it.each([
    ['not an object', [], /expected a JSON object/],
    ['null', null, /expected a JSON object/],
    ['no version', { recipes: [], policies: [] }, /no "version"/],
    ['string version', { ...valid, version: '1' }, /whole number/],
    ['newer version', { ...valid, version: 2 }, /newer than this planner/],
    ['old version', { ...valid, version: 0 }, /not supported/],
    ['recipes not a list', { ...valid, recipes: 'x' }, /"recipes"/],
    [
      'unknown recipe',
      { ...valid, recipes: ['nope'] },
      /unknown recipes: nope/,
    ],
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
    const result = parseBlueprint(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(message);
  });

  it('rejects non-JSON text', () => {
    const result = parseBlueprintText('{oops');
    expect(result).toEqual({
      ok: false,
      error: 'This file is not valid JSON.',
    });
  });
});

describe('storage', () => {
  it('round-trips through a Storage', () => {
    const storage = fakeStorage();
    const parsed = parseBlueprint(valid);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(saveBlueprint(storage, parsed.blueprint)).toBe(true);
    expect(loadBlueprint(storage)).toEqual({
      status: 'loaded',
      blueprint: parsed.blueprint,
    });
  });

  it('reports empty, and unavailable without throwing', () => {
    expect(loadBlueprint(fakeStorage()).status).toBe('empty');
    expect(loadBlueprint(null).status).toBe('unavailable');
    expect(loadBlueprint(fakeStorage(true)).status).toBe('unavailable');
    const parsed = parseBlueprint(valid);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(saveBlueprint(fakeStorage(true), parsed.blueprint)).toBe(false);
    expect(saveBlueprint(null, parsed.blueprint)).toBe(false);
  });

  it('keeps an unreadable value aside instead of losing it', () => {
    const storage = fakeStorage();
    storage.setItem(STORAGE_KEY, JSON.stringify({ ...valid, version: 9 }));
    const outcome = loadBlueprint(storage);
    expect(outcome.status).toBe('unreadable');
    expect(storage.data.get(UNREADABLE_KEY)).toContain('"version":9');
  });
});

describe('legacy url migration', () => {
  it('imports ?r= and ?o= into a blueprint', () => {
    const bp = blueprintFromLegacySearch(
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
    expect(parseBlueprint(bp).ok).toBe(true);
  });

  it('survives garbage options', () => {
    const bp = blueprintFromLegacySearch('?r=commerce.vendors&o=%%%');
    expect(bp.recipes).toEqual(['commerce.vendors']);
    expect(bp.policies).toEqual([]);
  });
});

describe('BlueprintStore', () => {
  let store: BlueprintStore;
  beforeEach(() => {
    vi.useFakeTimers();
    recipeState.clear();
    selection.clear();
    store = new BlueprintStore();
  });
  afterEach(() => vi.useRealTimers());

  it('does not save before the saved blueprint is read', () => {
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
    const fresh = new BlueprintStore();
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
    const first = new BlueprintStore();
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

    // A later plain load reads the blueprint and migrates nothing.
    const again = new BlueprintStore();
    expect(again.hydrate('', storage)).toBe(false);
    expect(recipeState.ids).toEqual(['commerce.customers', 'commerce.sales']);
  });

  it('starts empty with a notice when the saved blueprint is unreadable', () => {
    const storage = fakeStorage();
    storage.setItem(STORAGE_KEY, '{nope');
    store.hydrate('', storage);
    expect(store.loadNotice).toMatch(/could not be read/);
    expect(recipeState.ids).toEqual([]);
    expect(storage.data.get(UNREADABLE_KEY)).toBe('{nope');
  });

  it('export then import reproduces the same blueprint; bad import changes nothing', () => {
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
