import { describe, expect, it, vi } from 'vitest';
import { loadOverview } from '../load.js';
import { resolveOverview } from '../model.js';
import { createWidgetRegistry, resolveWidgetComponents } from '../registry.js';
import { definition, makeRegistry, w } from './fixtures.js';

describe('loadOverview', () => {
  it('runs loaders with validated options and the request context', async () => {
    const registry = makeRegistry();
    const load = vi.fn((_options, ctx) => ({
      user: ctx.userId,
      id: ctx.overviewId,
    }));
    registry.register({
      type: 'probe',
      title: 'P',
      options: [{ key: 'model', type: 'model', label: 'M' }],
      load,
    });
    const def = { ...definition, allowed: undefined, models: undefined };
    const out = await loadOverview(
      {
        widgets: [
          w('a', 'probe', 1, { model: 'A' }),
          w('b', 'probe', 1, { model: 'bad model' }),
        ],
      },
      def,
      registry,
      { userId: 'u1' },
    );
    expect(load).toHaveBeenCalledTimes(1);
    expect(load.mock.calls[0][0]).toEqual({ model: 'A' });
    expect(out.widgets).toEqual([
      {
        id: 'a',
        type: 'probe',
        span: 1,
        options: { model: 'A' },
        version: 1,
        status: 'ready',
        data: { user: 'u1', id: 'events.home' },
      },
    ]);
    expect(out.issues[0].code).toBe('invalid_options');
    expect(JSON.parse(JSON.stringify(out))).toEqual(out);
  });

  it('isolates a failing, slow or non-serializable loader', async () => {
    const registry = createWidgetRegistry();
    const onError = vi.fn();
    registry.register({
      type: 'fails',
      title: 'F',
      options: [],
      load: () => {
        throw new Error('secret db detail');
      },
    });
    registry.register({
      type: 'slow',
      title: 'S',
      options: [],
      load: () => new Promise(() => {}),
    });
    registry.register({
      type: 'cyclic',
      title: 'C',
      options: [],
      load: () => {
        const a: Record<string, unknown> = {};
        a.a = a;
        return a;
      },
    });
    registry.register({ type: 'fine', title: 'OK', options: [] });
    const out = await loadOverview(
      {
        widgets: [
          w('a', 'fails'),
          w('b', 'slow'),
          w('c', 'cyclic'),
          w('d', 'fine'),
        ],
      },
      { id: 'p', defaults: [] },
      registry,
      {},
      { timeoutMs: 20, onError },
    );
    expect(out.widgets.map((x) => [x.id, x.status, x.error?.code])).toEqual([
      ['a', 'error', 'load_failed'],
      ['b', 'error', 'timeout'],
      ['c', 'error', 'invalid_data'],
      ['d', 'ready', undefined],
    ]);
    expect(JSON.stringify(out)).not.toContain('secret db detail');
    expect(onError).toHaveBeenCalledWith(
      { id: 'a', type: 'fails' },
      expect.any(Error),
    );
  });

  it('aborts the signal handed to a loader on timeout', async () => {
    const registry = createWidgetRegistry();
    let aborted = false;
    registry.register({
      type: 'slow',
      title: 'S',
      options: [],
      load: (_o, ctx) =>
        new Promise(() => {
          ctx.signal?.addEventListener('abort', () => {
            aborted = true;
          });
        }),
    });
    await loadOverview(
      { widgets: [w('a', 'slow')] },
      { id: 'p', defaults: [] },
      registry,
      {},
      { timeoutMs: 10 },
    );
    expect(aborted).toBe(true);
  });

  it('never loads a widget whose default model is outside the page-confined list', async () => {
    const registry = createWidgetRegistry();
    const load = vi.fn(() => ({ ok: true }));
    registry.register({
      type: 'defaulted',
      title: 'D',
      options: [
        {
          key: 'model',
          type: 'model',
          label: 'M',
          default: 'events:Secret',
        },
      ],
      load,
    });
    const def = { ...definition, allowed: undefined, models: ['events:Event'] };
    for (const options of [{}, { model: '' }, { model: null }] as const) {
      const out = await loadOverview(
        { widgets: [w('a', 'defaulted', 1, options)] },
        def,
        registry,
        {},
      );
      expect(out.widgets).toEqual([]);
      expect(out.issues).toMatchObject([
        { widgetId: 'a', code: 'invalid_options' },
      ]);
    }
    expect(load).not.toHaveBeenCalled();

    // A default inside the confined list still loads.
    const allowed = { ...def, models: ['events:Secret'] };
    const ok = await loadOverview(
      { widgets: [w('b', 'defaulted', 1, {})] },
      allowed,
      registry,
      {},
    );
    expect(ok.widgets.map((x) => x.status)).toEqual(['ready']);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('loads what resolveOverview produced and never loads a dropped widget', async () => {
    const registry = makeRegistry();
    const resolved = resolveOverview(
      definition,
      {
        version: 1,
        added: [w('w9', 'metric', 1, { model: 'attacker:Table' })],
      },
      registry,
    );
    const out = await loadOverview(resolved.document, definition, registry, {});
    expect(out.widgets.map((x) => x.id)).toEqual(['w1', 'w2', 'w3']);
  });
});

describe('resolveWidgetComponents', () => {
  it('resolves eager and lazy components, skipping failures', async () => {
    const registry = createWidgetRegistry();
    const Eager = (() => {}) as never;
    const Lazy = (() => {}) as never;
    registry.register({
      type: 'eager',
      title: 'E',
      options: [],
      component: Eager,
    });
    registry.register({
      type: 'lazy',
      title: 'L',
      options: [],
      loadComponent: async () => ({ default: Lazy }),
    });
    registry.register({
      type: 'broken',
      title: 'B',
      options: [],
      loadComponent: async () => {
        throw new Error('chunk');
      },
    });
    const map = await resolveWidgetComponents(
      ['eager', 'lazy', 'broken', 'nope'],
      registry,
    );
    expect([...map.keys()].sort()).toEqual(['eager', 'lazy']);
    expect(map.get('lazy')).toBe(Lazy);
  });
});
