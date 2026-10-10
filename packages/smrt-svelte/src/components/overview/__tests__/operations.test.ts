import { describe, expect, it, vi } from 'vitest';
import { createOverviewAssistantSurface } from '../assistant-surface.js';
import { checkOverviewOverride, resolveOverview } from '../model.js';
import {
  describeOverview,
  OVERVIEW_MAX_OPERATIONS,
  planOverviewOperations,
} from '../operations.js';
import { coreRegistry, definition as fixture } from './app-fixtures.js';

/** The fixture page without `shortcuts`, so a disallowed type exists. */
const definition = {
  ...fixture,
  allowed: ['metric', 'chart', 'records', 'note'],
};

const registry = coreRegistry();
const plan = (operations: unknown, override: unknown = null) =>
  planOverviewOperations({ definition, registry, override, operations });

describe('planOverviewOperations', () => {
  it('applies a valid batch and returns a canonical override', () => {
    const result = plan([
      {
        op: 'add',
        type: 'chart',
        options: { model: 'events:Event', groupBy: 'status', period: '90d' },
      },
      {
        op: 'configure',
        id: 'w1',
        options: { measure: 'sum', field: 'total' },
      },
      { op: 'move', id: 'w4', index: 0 },
      { op: 'resize', id: 'w3', span: 3 },
      { op: 'remove', id: 'w2' },
    ]);
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.results).toEqual([
      { index: 0, op: 'add', id: 'w5' },
      { index: 1, op: 'configure', id: 'w1' },
      { index: 2, op: 'move', id: 'w4' },
      { index: 3, op: 'resize', id: 'w3' },
      { index: 4, op: 'remove', id: 'w2' },
    ]);
    expect(result.document.widgets.map((w) => w.id)).toEqual([
      'w4',
      'w1',
      'w3',
      'w5',
    ]);
    const added = result.document.widgets.find((w) => w.id === 'w5');
    expect(added).toMatchObject({
      type: 'chart',
      span: 2,
      options: {
        model: 'events:Event',
        groupBy: 'status',
        period: '90d',
        measure: 'count',
        style: 'bar',
      },
    });
    // What the save endpoint accepts, unchanged.
    expect(
      checkOverviewOverride(definition, result.override, registry),
    ).toEqual({ ok: true, override: result.override });
    expect(result.unchanged).toBe(false);
  });

  it('merges configure options and clears a key with null', () => {
    const first = plan([
      {
        op: 'configure',
        id: 'w1',
        options: { title: 'Events', measure: 'sum' },
      },
    ]);
    if (!first.ok) throw new Error('expected ok');
    const second = plan(
      [{ op: 'configure', id: 'w1', options: { title: null } }],
      first.override,
    );
    if (!second.ok) throw new Error('expected ok');
    const w1 = second.document.widgets.find((w) => w.id === 'w1');
    expect(w1?.options.title).toBeUndefined();
    expect(w1?.options.measure).toBe('sum');
    expect(w1?.options.model).toBe('events:Event');
  });

  it('places an add at an index and later ops see earlier ones', () => {
    const result = plan([
      { op: 'add', type: 'note', options: { body: 'Hi' }, index: 0 },
      { op: 'resize', id: 'w1', span: 4 },
    ]);
    if (!result.ok) throw new Error('expected ok');
    expect(result.document.widgets[0]).toMatchObject({
      id: 'w5',
      type: 'note',
    });
  });

  it.each([
    [
      'a type the page does not allow',
      { op: 'add', type: 'shortcuts' },
      'type_not_allowed',
    ],
    ['an unregistered type', { op: 'add', type: 'map' }, 'unknown_type'],
    [
      'bad options',
      {
        op: 'add',
        type: 'chart',
        options: { model: 'events:Event', style: 'pie' },
      },
      'invalid_options',
    ],
    [
      'an unknown option key',
      { op: 'add', type: 'note', options: { body: 'x', sql: 'select 1' } },
      'invalid_options',
    ],
    [
      'a model outside the page',
      { op: 'add', type: 'metric', options: { model: 'billing:Invoice' } },
      'invalid_options',
    ],
    [
      'a forbidden model through configure',
      { op: 'configure', id: 'w1', options: { model: 'billing:Invoice' } },
      'invalid_options',
    ],
    ['an unknown widget id', { op: 'remove', id: 'w99' }, 'unknown_widget'],
    [
      'a span out of range',
      { op: 'resize', id: 'w1', span: 5 },
      'invalid_span',
    ],
    ['a negative index', { op: 'move', id: 'w1', index: -1 }, 'invalid_index'],
    ['an unknown op', { op: 'query', sql: 'select 1' }, 'malformed'],
    ['an extra field', { op: 'remove', id: 'w1', where: 'x' }, 'malformed'],
  ])('rejects %s', (_label, operation, code) => {
    const result = plan([operation]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]).toMatchObject({ index: 0, code });
  });

  it('names the forbidden model option', () => {
    const result = plan([
      { op: 'add', type: 'metric', options: { model: 'billing:Invoice' } },
    ]);
    if (result.ok) throw new Error('expected rejection');
    expect(result.issues[0]?.options).toEqual([
      { key: 'model', code: 'not_allowed' },
    ]);
  });

  it('is atomic: one bad operation rejects the whole batch', () => {
    const result = plan([
      { op: 'add', type: 'note', options: { body: 'ok' } },
      { op: 'remove', id: 'w1' },
      { op: 'add', type: 'shortcuts' },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({
      index: 2,
      code: 'type_not_allowed',
    });
  });

  it('bounds the batch and refuses an empty one', () => {
    expect(plan([])).toMatchObject({ ok: false });
    const many = Array.from({ length: OVERVIEW_MAX_OPERATIONS + 1 }, () => ({
      op: 'move',
      id: 'w1',
      index: 0,
    }));
    const result = plan(many);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('too_many_operations');
  });

  it('enforces the widget cap', () => {
    const capped = { ...definition, maxWidgets: 4 };
    const result = planOverviewOperations({
      definition: capped,
      registry,
      override: null,
      operations: [{ op: 'add', type: 'note' }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.code).toBe('limit');
  });

  it('reports a batch that changes nothing', () => {
    const result = plan([{ op: 'move', id: 'w1', index: 0 }]);
    expect(result).toMatchObject({ ok: true, override: null, unchanged: true });
  });

  it('never reuses the id of a removed default', () => {
    const removed = plan([{ op: 'remove', id: 'w4' }]);
    if (!removed.ok) throw new Error('expected ok');
    const added = plan([{ op: 'add', type: 'note' }], removed.override);
    if (!added.ok) throw new Error('expected ok');
    expect(added.results[0]?.id).toBe('w5');
  });
});

describe('describeOverview', () => {
  it('lists allowed types with option fields and the current widgets', () => {
    const described = describeOverview({
      definition,
      registry,
      override: { version: 1, removed: ['w2'] },
      canCustomize: true,
      translate: (key) =>
        key === 'ui.overview.widget.chart.title' ? 'Chart' : key,
    });
    expect(described.widgetTypes.map((t) => t.type)).toEqual([
      'note',
      'metric',
      'chart',
      'records',
    ]);
    const chart = described.widgetTypes.find((t) => t.type === 'chart');
    expect(chart?.title).toBe('Chart');
    expect(chart?.span).toEqual({ default: 2, min: 1, max: 4 });
    expect(chart?.options.find((o) => o.key === 'model')).toMatchObject({
      type: 'model',
      required: true,
      models: ['events:Event', 'events:Venue'],
    });
    expect(chart?.options.find((o) => o.key === 'style')?.choices).toEqual([
      'bar',
      'line',
    ]);
    expect(described.widgets.map((w) => [w.id, w.index])).toEqual([
      ['w1', 0],
      ['w3', 1],
      ['w4', 2],
    ]);
    expect(described.customized).toBe(true);
  });
});

describe('createOverviewAssistantSurface', () => {
  it('plans against the current override and follows what it persists', async () => {
    const persist = vi.fn();
    const surface = createOverviewAssistantSurface({
      definition,
      registry,
      override: { version: 1, removed: ['w3'] },
      canCustomize: true,
      persist,
    });
    expect(surface.pageId).toBe('events.home');
    expect(surface.current()).toEqual({ version: 1, removed: ['w3'] });
    const result = surface.plan([{ op: 'remove', id: 'w2' }]);
    if (!result.ok) throw new Error('expected ok');
    await surface.persist(result.override);
    expect(persist).toHaveBeenCalledWith(result.override);
    expect(surface.current()).toEqual(result.override);
    expect(surface.describe().widgets.map((w) => w.id)).toEqual(['w1', 'w4']);
  });

  it('canonicalizes a stored override that no longer validates', () => {
    const surface = createOverviewAssistantSurface({
      definition,
      registry,
      override: {
        version: 1,
        added: [{ id: 'w9', type: 'shortcuts', span: 1, options: {} }],
        removed: ['w1'],
      },
      canCustomize: true,
      persist: () => {},
    });
    const resolved = resolveOverview(definition, surface.current(), registry);
    expect(resolved.overrideIssues).toEqual([]);
    expect(surface.current()).toEqual({ version: 1, removed: ['w1'] });
  });

  it('checks an override like a save', () => {
    const surface = createOverviewAssistantSurface({
      definition,
      registry,
      override: null,
      canCustomize: true,
      persist: () => {},
    });
    expect(
      surface.check({
        version: 1,
        added: [{ id: 'w9', type: 'shortcuts', span: 1, options: {} }],
      }).ok,
    ).toBe(false);
  });
});
