import { expect, it } from 'vitest';
import { applyOverviewOverride } from '../model.js';
import { sectionOverviewDefaults } from '../section-defaults.js';

const base = {
  dataWidgets: true,
  lead: { id: '@shop:Order', name: 'Order', plural: 'Orders' },
};
it('defaults to full-width shortcuts and records with no count or summaries', () => {
  expect(sectionOverviewDefaults(base).map((w) => [w.id, w.span])).toEqual([
    ['shortcuts', 4],
    ['latest', 4],
  ]);
  expect(sectionOverviewDefaults(base)[1]?.options.summaries).toBe(false);
});
it('projects only explicitly edited legacy counts without rewriting their sparse override', () => {
  for (const patch of [
    { span: 2 },
    { version: 1 },
    { options: { title: 'My count', model: '@shop:Order', measure: 'count' } },
  ]) {
    const override = { version: 1 as const, changed: { count: patch } };
    const raw = JSON.stringify(override);
    const defaults = sectionOverviewDefaults({ ...base, override });
    expect(defaults.map((w) => w.id)).toEqual(['shortcuts', 'count', 'latest']);
    expect(defaults[1]).toMatchObject({
      span: 1,
      options: { title: 'Orders', model: '@shop:Order', measure: 'count' },
    });
    const applied = applyOverviewOverride({ widgets: defaults }, override);
    expect(applied.widgets.find((w) => w.id === 'count')).toMatchObject(patch);
    expect(JSON.stringify(override)).toBe(raw);
  }
  for (const override of [
    { version: 1, order: ['count', 'latest'] },
    { version: 1, changed: { latest: { span: 2 } } },
    { version: 1, changed: { count: { span: 2 } }, removed: ['count'] },
  ])
    expect(
      sectionOverviewDefaults({ ...base, override }).some(
        (w) => w.id === 'count',
      ),
    ).toBe(false);
});
