/**
 * The chart widget's in-browser loader (the stand-in for a runtime report):
 * grouping by a field, bucketing a date field over the widget's period, and
 * money sums that stay integer minor units.
 */
import { describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { CookbookStore } from '../src/lib/cookbook/store.svelte.ts';
import { COOKBOOK_SCHEMA } from '../src/lib/cookbook/types.ts';
import { parseCookbook } from '../src/lib/cookbook/validate.ts';
import { EPOCH } from '../src/lib/data/fakes.ts';
import type { DataSource, ModelRecord } from '../src/lib/data/source.ts';
import { sectionOverview } from '../src/lib/overviews/definitions.ts';
import {
  createSectionOverview,
  loadSectionWidget,
} from '../src/lib/overviews/page.ts';
import { plannerLoaders } from '../src/lib/overviews/registry.ts';
import { recipesById } from '../src/lib/recipes/index.ts';
import { navSectionOf } from '../src/lib/recipes/sections.ts';

const ORDER = '@happyvertical/smrt-commerce:Order';
const sales = recipesById.get('commerce.sales');
if (!sales) throw new Error('commerce.sales recipe missing');
const SALES = `section:${navSectionOf(sales).id}`;
const def = (() => {
  const found = sectionOverview(SALES);
  if (!found) throw new Error('no sales overview');
  return found;
})();

const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number) => new Date(EPOCH - days * DAY).toISOString();

/** A source over fixed rows; the loader only lists. */
function sourceOf(rows: ModelRecord[]): DataSource {
  return { list: async () => rows } as unknown as DataSource;
}

function chart(options: Record<string, unknown>) {
  return {
    id: 'w1',
    type: 'chart',
    span: 2,
    options: { model: ORDER, ...options },
  };
}

async function load(rows: ModelRecord[], options: Record<string, unknown>) {
  return (await loadSectionWidget(
    def,
    {
      source: sourceOf(rows),
      sections: [],
      entryIndex: new Map(),
      href: (p) => p,
    },
    chart(options),
  )) as {
    points: { label: string; value: number }[];
    format?: string;
    currency?: string;
    href?: string;
  };
}

const order = (
  id: number,
  status: string,
  issued: string,
  totalAmount: number,
): ModelRecord => ({ id: `o${id}`, status, issueDate: issued, totalAmount });

const ROWS = [
  order(1, 'sent', daysAgo(2), 1000),
  order(2, 'accepted', daysAgo(5), 2500),
  order(3, 'accepted', daysAgo(40), 999),
  order(4, 'draft', daysAgo(100), 1),
  order(5, 'accepted', daysAgo(400), 50000),
];

describe('chart loader', () => {
  it('is one of the loaders the mounted planner hands the shell', () => {
    expect(Object.keys(plannerLoaders).sort()).toEqual([
      'chart',
      'metric',
      'records',
      'shortcuts',
    ]);
    expect(getModelByQualifiedName(ORDER)?.model.name).toBe('Order');
  });

  it('groups by a plain field, largest first, within the period window', async () => {
    const all = await load(ROWS, { groupBy: 'status', period: 'all' });
    expect(all.points).toEqual([
      { label: 'accepted', value: 3 },
      { label: 'draft', value: 1 },
      { label: 'sent', value: 1 },
    ]);
    expect(all.format).toBe('integer');
    expect(all.href).toBe('/m/commerce/Order/');
    // `30d` keeps the orders issued in the last 30 days by the lead date.
    const recent = await load(ROWS, { groupBy: 'status', period: '30d' });
    expect(recent.points).toEqual([
      { label: 'accepted', value: 1 },
      { label: 'sent', value: 1 },
    ]);
  });

  it('buckets a date field by the period, keeping empty buckets in order', async () => {
    const week = await load(ROWS, { groupBy: 'issueDate', period: '7d' });
    expect(week.points.map((p) => p.label)).toEqual([
      '2025-12-25',
      '2025-12-26',
      '2025-12-27',
      '2025-12-28',
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
    ]);
    expect(week.points.map((p) => p.value)).toEqual([0, 0, 1, 0, 0, 1, 0, 0]);
    const year = await load(ROWS, { period: '12m' });
    // Absent `groupBy`, the lead date field, by month.
    expect(year.points[0]?.label).toBe('2025-01');
    expect(year.points.at(-1)?.label).toBe('2026-01');
    expect(year.points).toHaveLength(13);
    expect(year.points.reduce((n, p) => n + p.value, 0)).toBe(4);
    const quarter = await load(ROWS, { groupBy: 'issueDate', period: '90d' });
    expect(
      quarter.points.every((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.label)),
    ).toBe(true);
    expect(quarter.points).toHaveLength(14);
  });

  it('sums and averages money as integer minor units', async () => {
    const sum = await load(ROWS, {
      groupBy: 'status',
      measure: 'sum',
      field: 'totalAmount',
      period: 'all',
    });
    expect(sum.points).toEqual([
      { label: 'accepted', value: 53499 },
      { label: 'sent', value: 1000 },
      { label: 'draft', value: 1 },
    ]);
    expect(sum).toMatchObject({ format: 'money', currency: 'USD' });
    const avg = await load(ROWS, {
      groupBy: 'status',
      measure: 'avg',
      field: 'totalAmount',
      period: 'all',
    });
    expect(avg.points.find((p) => p.label === 'accepted')?.value).toBe(17833);
    expect(avg.points.every((p) => Number.isInteger(p.value))).toBe(true);
  });

  it('refuses what the sample data cannot answer', async () => {
    await expect(load(ROWS, { groupBy: 'nope' })).rejects.toThrow();
    await expect(
      load(ROWS, { measure: 'sum', field: 'status' }),
    ).rejects.toThrow();
    await expect(load(ROWS, { filter: 'overdue' })).rejects.toThrow();
  });

  it('is an allowed widget on every section overview, saved to the cookbook', () => {
    const store = new CookbookStore();
    const controller = createSectionOverview(def, store);
    const added = controller.add('chart', { model: ORDER, groupBy: 'status' });
    expect(added.ok).toBe(true);
    const snapshot = store.snapshot();
    expect(snapshot.overviews?.[SALES]?.added?.[0]).toMatchObject({
      type: 'chart',
      options: { model: ORDER, groupBy: 'status' },
    });
    // The same cookbook imports with the chart intact.
    const result = parseCookbook({
      $schema: COOKBOOK_SCHEMA,
      version: 1,
      recipes: ['commerce.sales'],
      policies: [],
      overviews: snapshot.overviews,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dropped).toBeUndefined();
      expect(result.cookbook.overviews?.[SALES]?.added?.[0]?.type).toBe(
        'chart',
      );
    }
    controller.destroy();
  });
});
