import { describe, expect, it } from 'vitest';
import {
  applyOverviewOverride,
  checkOverviewOverride,
  defineOverview,
  diffOverview,
  nextWidgetId,
  parseOverviewDocument,
  parseOverviewOverride,
  resolveOverview,
  sanitizeOverview,
} from '../model.js';
import { definition, makeRegistry, w } from './fixtures.js';

const registry = makeRegistry();
const base = { widgets: definition.defaults.map((x) => ({ ...x })) };

describe('parseOverviewDocument', () => {
  it('keeps well-formed widgets and reports the rest', () => {
    const { document, issues } = parseOverviewDocument({
      widgets: [
        { id: 'a', type: 'note', span: 2, options: { body: 'x' } },
        { id: 'a', type: 'note', span: 1, options: {} },
        { id: 'b', type: 'note', span: 9, options: {} },
        { id: 'c', type: 'note', span: 1, options: { nested: { x: 1 } } },
        { id: 'bad id!', type: 'note', span: 1 },
        'nope',
      ],
    });
    expect(document.widgets.map((x) => x.id)).toEqual(['a']);
    expect(issues.map((i) => i.code)).toEqual([
      'duplicate_id',
      'invalid_span',
      'invalid_options',
      'malformed',
      'malformed',
    ]);
  });

  it('never throws on junk', () => {
    for (const junk of [null, 1, 'x', [], { widgets: 'no' }]) {
      expect(() => parseOverviewDocument(junk)).not.toThrow();
    }
  });
});

describe('parseOverviewOverride', () => {
  it('rejects unknown versions and junk', () => {
    expect(parseOverviewOverride({ version: 2 }).override).toBeNull();
    expect(parseOverviewOverride('x').override).toBeNull();
    expect(parseOverviewOverride(null)).toEqual({ override: null, issues: [] });
  });

  it('keeps only well-formed parts', () => {
    const { override } = parseOverviewOverride({
      version: 1,
      order: ['w2', 7, 'w1'],
      removed: ['w3', 'bad id'],
      added: [{ id: 'w9', type: 'note', span: 1, options: {} }, { id: 1 }],
      changed: {
        w1: { span: 3, options: { model: 'A' }, junk: true },
        w2: { span: 99 },
      },
    });
    expect(override).toEqual({
      version: 1,
      order: ['w2', 'w1'],
      removed: ['w3'],
      added: [{ id: 'w9', type: 'note', span: 1, options: {} }],
      changed: { w1: { span: 3, options: { model: 'A' } } },
    });
  });
});

describe('applyOverviewOverride / diffOverview', () => {
  it('is a no-op for an empty override', () => {
    expect(applyOverviewOverride(base, null)).toEqual(base);
    expect(applyOverviewOverride(base, { version: 1 })).toEqual(base);
  });

  it('applies removal, addition, change and order', () => {
    const doc = applyOverviewOverride(base, {
      version: 1,
      removed: ['w2'],
      added: [w('w4', 'note', 1, { body: 'new' })],
      changed: { w3: { span: 2 } },
      order: ['w4', 'w3', 'w1'],
    });
    expect(doc.widgets.map((x) => [x.id, x.span])).toEqual([
      ['w4', 1],
      ['w3', 2],
      ['w1', 1],
    ]);
  });

  it('keeps unlisted widgets in their slots and ignores unknown ids', () => {
    const doc = applyOverviewOverride(base, {
      version: 1,
      order: ['w3', 'ghost', 'w1'],
    });
    // w1 and w3 swap; w2 (unlisted) keeps the middle slot.
    expect(doc.widgets.map((x) => x.id)).toEqual(['w3', 'w2', 'w1']);
  });

  it('skips an added widget whose id collides with the base', () => {
    const doc = applyOverviewOverride(base, {
      version: 1,
      added: [w('w1', 'note')],
    });
    expect(doc.widgets).toHaveLength(3);
    expect(doc.widgets[0].type).toBe('metric');
  });

  it('round-trips: apply(base, diff(base, next)) equals next', () => {
    const nexts = [
      base,
      { widgets: [base.widgets[2], base.widgets[0], base.widgets[1]] },
      { widgets: [base.widgets[0]] },
      {
        widgets: [
          { ...base.widgets[0], span: 2 },
          { ...base.widgets[1], options: { body: 'Edited' } },
          w('w7', 'note', 3, { body: 'z' }),
          base.widgets[2],
        ],
      },
      { widgets: [] },
    ];
    for (const next of nexts) {
      const override = diffOverview(base, next);
      expect(applyOverviewOverride(base, override)).toEqual(next);
    }
    expect(diffOverview(base, base)).toBeNull();
  });
});

describe('nextWidgetId', () => {
  it('never reuses a reserved id (removed defaults stay reserved)', () => {
    expect(nextWidgetId(['w1', 'w2', 'w3'])).toBe('w4');
    expect(nextWidgetId(['w1', 'w5'])).toBe('w6');
    expect(nextWidgetId([])).toBe('w1');
    expect(nextWidgetId(['custom'])).toBe('w1');
  });
});

describe('sanitizeOverview', () => {
  const run = (widgets: ReturnType<typeof w>[], def = definition) =>
    sanitizeOverview({ widgets }, { registry, definition: def });

  it('drops unknown, disallowed and allowedIn-restricted types', () => {
    const { document, issues } = run([
      w('a', 'nope'),
      w('b', 'secret'),
      w('c', 'note'),
    ]);
    expect(document.widgets.map((x) => x.id)).toEqual(['c']);
    expect(issues.map((i) => i.code)).toEqual([
      'unknown_type',
      'type_not_allowed',
    ]);
    // allowedIn lets 'secret' in only on its own overview
    expect(
      run([w('b', 'secret')], { ...definition, id: 'admin.home' }).document
        .widgets,
    ).toHaveLength(1);
    // the page's own allow-list can exclude a registered type
    expect(
      run([w('c', 'note')], { ...definition, allowed: ['metric'] }).document
        .widgets,
    ).toHaveLength(0);
  });

  it('validates options and applies defaults and the current version', () => {
    const { document, issues } = run([
      w('a', 'metric', 1, { model: 'events:Event' }),
      w('b', 'metric', 1, { model: 'other:Thing' }),
      w('c', 'metric', 1, { model: 'events:Event', extra: 1 }),
    ]);
    expect(document.widgets).toEqual([
      {
        id: 'a',
        type: 'metric',
        span: 1,
        options: { model: 'events:Event', measure: 'count' },
        version: 2,
      },
    ]);
    expect(issues).toHaveLength(2);
    expect(issues[0]).toMatchObject({
      widgetId: 'b',
      code: 'invalid_options',
      options: [{ key: 'model', code: 'not_allowed' }],
    });
  });

  it('migrates older versions and drops failures and newer ones', () => {
    const old = {
      ...w('a', 'metric', 1, { model: 'events:Event', agg: 'sum' }),
      version: 1,
    };
    const future = {
      ...w('b', 'metric', 1, { model: 'events:Event' }),
      version: 3,
    };
    const { document, issues } = run([old, future]);
    expect(document.widgets).toHaveLength(1);
    expect(document.widgets[0].options).toEqual({
      model: 'events:Event',
      measure: 'sum',
    });
    expect(issues.map((i) => i.code)).toEqual(['future_version']);

    const noMigration = registry;
    noMigration.register(
      { type: 'v2only', title: 'V', version: 2, options: [] },
      { replace: true },
    );
    const broken = sanitizeOverview(
      { widgets: [w('z', 'v2only')] },
      { registry: noMigration, definition: { id: 'x' } },
    );
    expect(broken.issues[0].code).toBe('migration_failed');
  });

  it('clamps spans to the widget range, caps the count, and is idempotent', () => {
    const wide = run([w('a', 'metric', 4, { model: 'events:Event' })]);
    expect(wide.document.widgets[0].span).toBe(2);
    const many = run([w('a', 'note'), w('b', 'note'), w('c', 'note')], {
      ...definition,
      maxWidgets: 2,
    });
    expect(many.document.widgets).toHaveLength(2);
    expect(many.issues[0].code).toBe('too_many');
    expect(run(wide.document.widgets).document).toEqual(wide.document);
  });

  it('survives a migration that throws', () => {
    const reg = makeRegistry();
    reg.register({
      type: 'boom',
      title: 'B',
      version: 2,
      options: [],
      migrate: () => {
        throw new Error('x');
      },
    });
    const out = sanitizeOverview(
      { widgets: [{ ...w('a', 'boom'), version: 1 }] },
      { registry: reg, definition: { id: 'x' } },
    );
    expect(out.issues[0].code).toBe('migration_failed');
  });
});

describe('resolveOverview / checkOverviewOverride', () => {
  it('merges a stored override onto the defaults and reports the junk', () => {
    const resolved = resolveOverview(
      definition,
      {
        version: 1,
        removed: ['w2'],
        added: [w('w4', 'secret')],
        changed: { w1: { options: { model: 'attacker:Table' } } },
      },
      registry,
    );
    // w4 (disallowed here) and w1's invalid change are dropped, w2 removed
    expect(resolved.document.widgets.map((x) => x.id)).toEqual(['w3']);
    expect(resolved.overrideIssues.map((i) => i.code).sort()).toEqual([
      'invalid_options',
      'type_not_allowed',
    ]);
  });

  it('resets to the defaults with no override', () => {
    const resolved = resolveOverview(definition, null, registry);
    expect(resolved.document.widgets.map((x) => x.id)).toEqual([
      'w1',
      'w2',
      'w3',
    ]);
    expect(resolved.override).toBeNull();
  });

  it('rejects a bad save strictly and returns a canonical override otherwise', () => {
    const bad = checkOverviewOverride(
      definition,
      { version: 1, added: [w('w4', 'metric', 1, { model: 'x:Y' })] },
      registry,
    );
    expect(bad.ok).toBe(false);
    const good = checkOverviewOverride(
      definition,
      { version: 1, changed: { w2: { span: 4 } }, order: [] },
      registry,
    );
    expect(good).toEqual({
      ok: true,
      override: { version: 1, changed: { w2: { span: 4 } } },
    });
  });

  it('does not let a broken default block saving', () => {
    const broken = defineOverview({
      ...definition,
      defaults: [w('w1', 'metric', 1, { model: 'bad:Model' }), w('w2', 'note')],
    });
    expect(
      checkOverviewOverride(broken, { version: 1, removed: ['w2'] }, registry)
        .ok,
    ).toBe(true);
  });
});

describe('defineOverview', () => {
  it('rejects bad ids', () => {
    expect(() => defineOverview({ ...definition, id: 'bad id' })).toThrow();
    expect(() =>
      defineOverview({
        ...definition,
        defaults: [w('a', 'note'), w('a', 'note')],
      }),
    ).toThrow(/duplicate/);
  });
});
