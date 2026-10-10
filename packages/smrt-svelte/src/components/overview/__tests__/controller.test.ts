import { describe, expect, it, vi } from 'vitest';
import { createOverview } from '../controller.svelte.js';
import { coreRegistry, definition, loadedFor } from './app-fixtures.js';

const make = (extra: Record<string, unknown> = {}) =>
  createOverview({ definition, registry: coreRegistry(), ...extra });

describe('OverviewController', () => {
  it('starts on the defaults', () => {
    const c = make();
    expect(c.document.widgets.map((w) => w.id)).toEqual([
      'w1',
      'w2',
      'w3',
      'w4',
    ]);
    expect(c.customized).toBe(false);
    expect(c.override).toBeNull();
  });

  it('keeps an override in memory and reports each edit', () => {
    const onchange = vi.fn();
    const c = make({ onchange });
    expect(c.resize('w1', 3)).toEqual({ ok: true, id: 'w1' });
    expect(c.move('w4', 0).ok).toBe(true);
    expect(c.remove('w3').ok).toBe(true);
    expect(c.override).toEqual({
      version: 1,
      order: ['w4', 'w1', 'w2'],
      removed: ['w3'],
      changed: { w1: { span: 3 } },
    });
    expect(onchange).toHaveBeenCalledTimes(3);
    expect(c.reset().ok).toBe(true);
    expect(c.customized).toBe(false);
    expect(onchange).toHaveBeenLastCalledWith(null);
    expect(c.reset()).toEqual({ ok: false, reason: 'unchanged' });
  });

  it('follows a host-owned override and only reports edits', () => {
    const stored: unknown = { version: 1, removed: ['w2'] };
    const onchange = vi.fn();
    const c = make({ override: () => stored, onchange });
    expect(c.document.widgets.map((w) => w.id)).toEqual(['w1', 'w3', 'w4']);
    c.resize('w1', 2);
    // the host has not fed the edit back, so the document is unchanged
    expect(c.document.widgets[0].span).toBe(1);
    expect(onchange).toHaveBeenCalledWith({
      version: 1,
      removed: ['w2'],
      changed: { w1: { span: 2 } },
    });
  });

  it('refuses everything when the viewer may not customize', () => {
    const onchange = vi.fn();
    const c = make({ canCustomize: () => false, onchange });
    for (const result of [
      c.add('note'),
      c.remove('w1'),
      c.move('w1', 1),
      c.resize('w1', 2),
      c.setOptions('w3', { body: 'x' }),
      c.reset(),
    ]) {
      expect(result).toEqual({ ok: false, reason: 'not_allowed' });
    }
    expect(onchange).not.toHaveBeenCalled();
  });

  it('adds with stable, never-reused ids', () => {
    const c = make();
    c.remove('w4');
    const added = c.add('note', { body: 'hi' });
    expect(added).toEqual({ ok: true, id: 'w5' });
    expect(c.document.widgets.at(-1)).toMatchObject({
      id: 'w5',
      type: 'note',
      span: 2,
    });
    // an id a removed default carries stays reserved
    c.remove('w1');
    expect(c.add('note')).toEqual({ ok: true, id: 'w6' });
    expect(c.override?.removed).toEqual(['w1', 'w4']);
  });

  it('only adds allowed, registered types and validates their options', () => {
    const c = make();
    expect(c.add('unknown-type')).toEqual({
      ok: false,
      reason: 'unknown_type',
    });
    expect(c.add('metric')).toMatchObject({
      ok: false,
      reason: 'invalid_options',
      issues: [{ key: 'model', code: 'required' }],
    });
    expect(c.add('metric', { model: 'secret:Table' })).toMatchObject({
      ok: false,
      reason: 'invalid_options',
      issues: [{ key: 'model', code: 'not_allowed' }],
    });
    expect(c.add('metric', { model: 'events:Venue' }).ok).toBe(true);
    const narrow = createOverview({
      definition: { ...definition, allowed: ['note'] },
      registry: coreRegistry(),
    });
    expect(narrow.addable.map((d) => d.type)).toEqual(['note']);
    expect(narrow.add('metric', { model: 'events:Event' })).toEqual({
      ok: false,
      reason: 'unknown_type',
    });
  });

  it('enforces the widget cap', () => {
    const c = createOverview({
      definition: { ...definition, maxWidgets: 4 },
      registry: coreRegistry(),
    });
    expect(c.full).toBe(true);
    expect(c.add('note')).toEqual({ ok: false, reason: 'limit' });
  });

  it('rejects invalid option edits without changing anything', () => {
    const c = make();
    expect(
      c.setOptions('w4', { model: 'events:Event', limit: 99 }),
    ).toMatchObject({ ok: false, reason: 'invalid_options' });
    expect(
      c.setOptions('w4', { model: 'events:Event', sql: 'x' }),
    ).toMatchObject({ ok: false });
    expect(c.setOptions('ghost', {})).toEqual({
      ok: false,
      reason: 'unknown_widget',
    });
    expect(c.customized).toBe(false);
  });

  it('clamps spans, reports no-ops and resets a single widget', () => {
    const c = make();
    expect(c.resize('w1', 99).ok).toBe(true);
    expect(c.document.widgets[0].span).toBe(4);
    expect(c.resize('w1', 4)).toEqual({ ok: false, reason: 'unchanged' });
    expect(c.resetWidget('w1').ok).toBe(true);
    expect(c.document.widgets[0].span).toBe(1);
    expect(c.customized).toBe(false);
  });

  it('restores a previous override (the undo hook)', () => {
    const c = make();
    const before = c.override;
    c.remove('w1');
    const edited = c.override;
    expect(c.restore(before).ok).toBe(true);
    expect(c.document.widgets).toHaveLength(4);
    expect(c.restore(edited).ok).toBe(true);
    expect(c.document.widgets).toHaveLength(3);
    // junk restores to the defaults rather than throwing
    expect(c.restore({ version: 9 }).ok).toBe(true);
    expect(c.document.widgets).toHaveLength(4);
  });

  it('ignores a stored override that tries to smuggle in an unregistered or foreign widget', () => {
    const c = make({
      override: () => ({
        version: 1,
        added: [
          { id: 'x1', type: 'sql', span: 1, options: { query: 'select 1' } },
          {
            id: 'x2',
            type: 'metric',
            span: 1,
            options: { model: 'secret:Table' },
          },
        ],
      }),
    });
    expect(c.document.widgets.map((w) => w.id)).toEqual([
      'w1',
      'w2',
      'w3',
      'w4',
    ]);
    expect(c.issues.map((i) => i.code).sort()).toEqual([
      'invalid_options',
      'unknown_type',
    ]);
  });
});

describe('OverviewController data', () => {
  it('requests data for added widgets, drops stale results and aborts removed ones', async () => {
    const calls: {
      id: string;
      signal: AbortSignal;
      resolve: (v: unknown) => void;
    }[] = [];
    const c = make({
      loaded: await loadedFor(),
      loadWidget: (widget: { id: string }, signal: AbortSignal) =>
        new Promise((resolve) =>
          calls.push({ id: widget.id, signal, resolve }),
        ),
    });
    c.add('note', { body: 'x' });
    const added = c.document.widgets.at(-1);
    expect(c.entry(added as never).status).toBe('loading');
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    c.setOptions('w5', { body: 'y' });
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[0].signal.aborted).toBe(true);
    calls[0].resolve({ stale: true });
    calls[1].resolve({ fresh: true });
    await vi.waitFor(() =>
      expect(c.entry(c.document.widgets.at(-1) as never).status).toBe('ready'),
    );
    expect(c.entry(c.document.widgets.at(-1) as never)).toMatchObject({
      status: 'ready',
      data: { fresh: true },
    });
    c.remove('w5');
    expect(
      c.entry({
        id: 'w5',
        type: 'note',
        span: 1,
        options: { body: 'y' },
      } as never).status,
    ).toBe('loading');
  });

  it('records a failed load as an error entry', async () => {
    const c = make({
      loadWidget: async () => {
        throw new Error('boom');
      },
    });
    c.add('note', { body: 'x' });
    await new Promise((r) => setTimeout(r, 0));
    expect(c.entry(c.document.widgets.at(-1) as never)).toMatchObject({
      status: 'error',
      error: 'load_failed',
    });
  });
});
