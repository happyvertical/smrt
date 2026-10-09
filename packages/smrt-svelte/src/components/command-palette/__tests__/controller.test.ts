import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCommandPalette } from '../controller.svelte.js';
import type { PaletteItem, PaletteProvider } from '../types.js';

const item = (id: string, title: string, extra: Partial<PaletteItem> = {}) => ({
  id,
  title,
  ...extra,
});

const commands: PaletteProvider = {
  id: 'cmd',
  label: 'Commands',
  items: () => [item('a', 'Alpha'), item('b', 'Beta'), item('c', 'Gamma')],
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('CommandPaletteController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('opens with every provider row and the first row active', () => {
    const palette = createCommandPalette({ providers: [commands] });
    expect(palette.isOpen).toBe(false);
    palette.open();
    expect(palette.isOpen).toBe(true);
    expect(palette.results.map((r) => r.item.title)).toEqual([
      'Alpha',
      'Beta',
      'Gamma',
    ]);
    expect(palette.active?.item.id).toBe('a');
  });

  it('filters locally as the query changes and resets the highlight', () => {
    const palette = createCommandPalette({ providers: [commands] });
    palette.open();
    palette.moveActive(1);
    expect(palette.active?.item.id).toBe('b');
    palette.setQuery('gam');
    expect(palette.results.map((r) => r.item.id)).toEqual(['c']);
    expect(palette.active?.item.id).toBe('c');
    palette.setQuery('');
    expect(palette.active?.item.id).toBe('a');
  });

  it('moves with wraparound and skips disabled rows', () => {
    const palette = createCommandPalette({
      providers: [
        {
          id: 'p',
          label: 'P',
          items: () => [
            item('1', 'One'),
            item('2', 'Two', { disabled: true }),
            item('3', 'Three'),
          ],
        },
      ],
    });
    palette.open();
    expect(palette.active?.item.id).toBe('1');
    palette.moveActive(1);
    expect(palette.active?.item.id).toBe('3');
    palette.moveActive(1);
    expect(palette.active?.item.id).toBe('1');
    palette.moveActive(-1);
    expect(palette.active?.item.id).toBe('3');
    palette.moveActiveTo('first');
    expect(palette.active?.item.id).toBe('1');
    palette.setActive('p:2');
    expect(palette.active?.item.id).toBe('1');
    palette.setActive('p:3');
    expect(palette.active?.item.id).toBe('3');
  });

  it('awaits async items and ignores them after close', async () => {
    const late = deferred<PaletteItem[]>();
    const palette = createCommandPalette({
      providers: [{ id: 'slow', label: 'Slow', items: () => late.promise }],
    });
    palette.open();
    expect(palette.busy).toBe(true);
    expect(palette.results).toEqual([]);
    late.resolve([item('x', 'Loaded')]);
    await flush();
    expect(palette.busy).toBe(false);
    expect(palette.results.map((r) => r.item.title)).toEqual(['Loaded']);

    const stale = deferred<PaletteItem[]>();
    const second = createCommandPalette({
      providers: [{ id: 'slow', label: 'Slow', items: () => stale.promise }],
    });
    second.open();
    second.close();
    stale.resolve([item('x', 'Too late')]);
    await flush();
    expect(second.results).toEqual([]);
    expect(second.busy).toBe(false);
  });

  it('debounces search, aborts the previous query and keeps rows until replaced', async () => {
    const signals: AbortSignal[] = [];
    const search = vi.fn(async (query: string, { signal }) => {
      signals.push(signal);
      return [item(query, `Result ${query}`)];
    });
    const palette = createCommandPalette({
      providers: [{ id: 'rec', label: 'Records', search }],
      searchDebounceMs: 100,
    });
    palette.open();
    palette.setQuery('ac');
    palette.setQuery('acm');
    vi.advanceTimersByTime(99);
    expect(search).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(search).toHaveBeenCalledTimes(1);
    expect(search).toHaveBeenCalledWith(
      'acm',
      expect.objectContaining({ limit: 8 }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(palette.results.map((r) => r.item.title)).toEqual(['Result acm']);

    palette.setQuery('acme');
    // The earlier rows stay while the new search is pending.
    expect(palette.results.map((r) => r.item.title)).toEqual(['Result acm']);
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(palette.results.map((r) => r.item.title)).toEqual(['Result acme']);
  });

  it('drops a superseded search result and honours minQueryLength', async () => {
    const first = deferred<PaletteItem[]>();
    const second = deferred<PaletteItem[]>();
    const pending = [first, second];
    const search = vi.fn(() => pending.shift()?.promise ?? Promise.resolve([]));
    const palette = createCommandPalette({
      providers: [{ id: 'rec', label: 'R', search, minQueryLength: 3 }],
      searchDebounceMs: 0,
    });
    palette.open();
    palette.setQuery('ab');
    await vi.advanceTimersByTimeAsync(10);
    expect(search).not.toHaveBeenCalled();

    palette.setQuery('abc');
    await vi.advanceTimersByTimeAsync(10);
    palette.setQuery('abcd');
    await vi.advanceTimersByTimeAsync(10);
    expect(search).toHaveBeenCalledTimes(2);
    second.resolve([item('new', 'New answer')]);
    await vi.advanceTimersByTimeAsync(0);
    first.resolve([item('old', 'Old answer')]);
    await vi.advanceTimersByTimeAsync(0);
    expect(palette.results.map((r) => r.item.title)).toEqual(['New answer']);
    expect(palette.busy).toBe(false);

    palette.setQuery('ab');
    await vi.advanceTimersByTimeAsync(10);
    expect(palette.results).toEqual([]);
  });

  it('reports provider failures and keeps working', async () => {
    const onError = vi.fn();
    const palette = createCommandPalette({
      providers: [
        commands,
        {
          id: 'bad-items',
          label: 'Bad',
          items: () => {
            throw new Error('items boom');
          },
        },
        {
          id: 'bad-search',
          label: 'Bad search',
          search: async () => {
            throw new Error('search boom');
          },
        },
      ],
      searchDebounceMs: 0,
      onError,
    });
    palette.open();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'items boom' }),
      { providerId: 'bad-items', phase: 'items' },
    );
    palette.setQuery('alpha');
    await vi.advanceTimersByTimeAsync(10);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'search boom' }),
      { providerId: 'bad-search', phase: 'search' },
    );
    expect([...palette.failedProviders].sort()).toEqual([
      'bad-items',
      'bad-search',
    ]);
    expect(palette.results.map((r) => r.item.title)).toEqual(['Alpha']);
  });

  it('closes, then runs the chosen item with the query', async () => {
    const run = vi.fn();
    const navigate = vi.fn();
    const palette = createCommandPalette({
      navigate,
      providers: [
        {
          id: 'p',
          label: 'P',
          items: () => [
            item('go', 'Go home', { href: '/home' }),
            item('do', 'Do thing', { run }),
          ],
        },
      ],
    });
    palette.open();
    palette.setQuery('do');
    await palette.activate();
    expect(palette.isOpen).toBe(false);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'do', providerId: 'p' }),
    );

    palette.open();
    palette.setQuery('go');
    await palette.activate();
    expect(navigate).toHaveBeenCalledWith(
      '/home',
      expect.objectContaining({ id: 'go' }),
    );
  });

  it('does not activate a disabled row; run errors are reported', async () => {
    const onError = vi.fn();
    const palette = createCommandPalette({
      onError,
      providers: [
        {
          id: 'p',
          label: 'P',
          items: () => [
            item('x', 'Locked', { disabled: true, href: '/x' }),
            item('y', 'Explode', {
              run: () => {
                throw new Error('run boom');
              },
            }),
          ],
        },
      ],
    });
    palette.open();
    const locked = palette.results.find((r) => r.item.id === 'x');
    await palette.activate(locked);
    expect(palette.isOpen).toBe(true);
    await palette.activate();
    expect(palette.isOpen).toBe(false);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'run boom' }),
      expect.objectContaining({ providerId: 'p', phase: 'run' }),
    );
  });

  it('registers and replaces providers, also while open', () => {
    const palette = createCommandPalette();
    palette.open();
    const dispose = palette.registerProvider({
      id: 'late',
      label: 'Late',
      items: () => [item('1', 'First')],
    });
    expect(palette.results.map((r) => r.item.title)).toEqual(['First']);
    const replacement: PaletteProvider = {
      id: 'late',
      label: 'Late',
      items: () => [item('2', 'Second')],
    };
    const disposeReplacement = palette.registerProvider(replacement);
    expect(palette.providers).toHaveLength(1);
    expect(palette.results.map((r) => r.item.title)).toEqual(['Second']);
    dispose(); // the replaced registration no longer owns the id
    expect(palette.providers).toHaveLength(1);
    disposeReplacement();
    expect(palette.providers).toHaveLength(0);
    expect(palette.results).toEqual([]);
  });

  it('wraps page-sized moves on short lists without a negative index', () => {
    const palette = createCommandPalette({ providers: [commands] });
    palette.open();
    // (0 - 5) mod 3 must wrap to index 1, not -2.
    palette.moveActive(-5);
    expect(palette.active?.item.id).toBe('b');
    palette.moveActive(5);
    expect(palette.active?.item.id).toBe('a');
    palette.moveActive(-100);
    expect(palette.active?.item.id).toBe('c');
    palette.moveActive(100);
    expect(palette.active?.item.id).toBe('a');

    const two = createCommandPalette({
      providers: [
        {
          id: 'two',
          label: 'Two',
          items: () => [item('a', 'Alpha'), item('b', 'Beta')],
        },
      ],
    });
    two.open();
    two.moveActive(-5);
    expect(two.active?.item.id).toBe('b');
    two.moveActive(5);
    expect(two.active?.item.id).toBe('a');
  });

  it('drops a late items result from a replaced provider and clears its rows', async () => {
    const oldLoad = deferred<PaletteItem[]>();
    const newLoad = deferred<PaletteItem[]>();
    const palette = createCommandPalette({
      providers: [{ id: 'p', label: 'P', items: () => oldLoad.promise }],
    });
    palette.open();
    palette.registerProvider({
      id: 'p',
      label: 'P',
      items: () => newLoad.promise,
    });
    newLoad.resolve([item('new', 'New command')]);
    await flush();
    expect(palette.results.map((r) => r.item.id)).toEqual(['new']);
    oldLoad.resolve([item('old', 'Obsolete command', { run: () => {} })]);
    await flush();
    expect(palette.results.map((r) => r.item.id)).toEqual(['new']);
  });

  it('keeps no cached rows when a provider is replaced', async () => {
    const palette = createCommandPalette({
      providers: [{ id: 'p', label: 'P', items: () => [item('old', 'Old')] }],
    });
    palette.open();
    expect(palette.results.map((r) => r.item.id)).toEqual(['old']);
    const pending = deferred<PaletteItem[]>();
    palette.registerProvider({
      id: 'p',
      label: 'P',
      items: () => pending.promise,
    });
    expect(palette.results).toEqual([]);
    pending.resolve([item('new', 'New')]);
    await flush();
    expect(palette.results.map((r) => r.item.id)).toEqual(['new']);
  });

  it('ignores a late items failure from a replaced provider', async () => {
    const oldLoad = deferred<PaletteItem[]>();
    const onError = vi.fn();
    const palette = createCommandPalette({
      onError,
      providers: [{ id: 'p', label: 'P', items: () => oldLoad.promise }],
    });
    palette.open();
    palette.registerProvider({
      id: 'p',
      label: 'P',
      items: () => [item('new', 'New command')],
    });
    oldLoad.reject(new Error('stale boom'));
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expect(palette.failedProviders.has('p')).toBe(false);
    expect(palette.results.map((r) => r.item.id)).toEqual(['new']);
  });

  it('drops a late search result from a replaced provider', async () => {
    const oldSearch = deferred<PaletteItem[]>();
    const palette = createCommandPalette({
      searchDebounceMs: 10,
      providers: [{ id: 's', label: 'S', search: () => oldSearch.promise }],
    });
    palette.open();
    palette.setQuery('abc');
    await vi.advanceTimersByTimeAsync(10);
    palette.registerProvider({
      id: 's',
      label: 'S',
      search: () => [item('fresh', 'Fresh abc')],
    });
    await vi.advanceTimersByTimeAsync(10);
    oldSearch.resolve([item('stale', 'Stale abc')]);
    await flush();
    expect(palette.results.map((r) => r.item.id)).toEqual(['fresh']);
  });

  it('toggles and clears state on close', () => {
    const palette = createCommandPalette({ providers: [commands] });
    palette.toggle();
    palette.setQuery('beta');
    expect(palette.isOpen).toBe(true);
    palette.toggle();
    expect(palette.isOpen).toBe(false);
    expect(palette.query).toBe('');
    palette.open();
    expect(palette.query).toBe('');
  });
});
