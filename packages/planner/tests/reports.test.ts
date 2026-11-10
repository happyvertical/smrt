import { runtimeReportSpecDigest } from '@happyvertical/smrt-reports/spec';
import { describe, expect, it } from 'vitest';
import { getModelByQualifiedName } from '../src/lib/catalog/index.ts';
import { EPOCH } from '../src/lib/data/fakes.ts';
import { createMemoryDataSource } from '../src/lib/data/source.ts';
import { getLibraryCookbook } from '../src/lib/library/index.ts';
import { recipes } from '../src/lib/recipes/index.ts';
import {
  parseReportIntent,
  specFromIntent,
} from '../src/lib/reports/intent.ts';
import {
  plannerReportSources,
  REPORTS_RECIPE,
  RUNTIME_REPORT_MODEL,
} from '../src/lib/reports/sources.ts';
import {
  createPlannerReports,
  PLANNER_REPORT_AUTHOR,
} from '../src/lib/reports/store.ts';

const NOW = new Date(EPOCH); // the sample clock: 1 Jan 2026
const mechanic = () => {
  const cookbook = getLibraryCookbook('mechanic');
  if (!cookbook) throw new Error('mechanic');
  return [...cookbook.document.recipes, REPORTS_RECIPE];
};

function setup() {
  const data = createMemoryDataSource({
    empty: [RUNTIME_REPORT_MODEL],
  });
  const reports = createPlannerReports({
    data,
    recipeIds: mechanic,
    recipes,
    now: () => NOW,
  });
  return { data, reports };
}

describe('report sources (#4100)', () => {
  it('are the menu models of the recipes that are on, never saved reports', () => {
    const sources = plannerReportSources(mechanic(), recipes);
    const invoices = sources.find((s) => s.id === 'invoices');
    expect(invoices).toMatchObject({
      label: expect.any(String),
      dateField: 'issueDate',
      amountField: 'totalAmount',
    });
    expect(invoices?.schema.find((f) => f.name === 'totalAmount')?.format).toBe(
      'money',
    );
    // System plumbing (tenant, snapshots) is not reportable.
    expect(invoices?.schema.some((f) => f.name === 'tenantId')).toBe(false);
    expect(sources.some((s) => s.model.id === RUNTIME_REPORT_MODEL)).toBe(
      false,
    );
    expect(new Set(sources.map((s) => s.id)).size).toBe(sources.length);
  });
});

describe('report intents', () => {
  it('keep structure only, and list what is not readable', () => {
    expect(parseReportIntent(null)).toBeNull();
    expect(parseReportIntent({ period: 'last_month' })).toBeNull();
    expect(
      parseReportIntent({
        source: 'invoices',
        period: 'last_fortnight',
        measures: [{ fn: 'median' }, { fn: 'sum', field: 'total' }],
        filters: [{ field: 'status', op: 'like', value: 'x' }],
      }),
    ).toEqual({
      source: 'invoices',
      measures: [{ fn: 'sum', field: 'total' }],
      unreadable: ['a measure', 'the status filter', 'the period'],
    });
  });

  it('build "a summary of sales last month" as a count and total over the business date', () => {
    const built = specFromIntent(
      { source: 'invoices', period: 'last_month' },
      plannerReportSources(mechanic(), recipes),
      NOW,
    );
    if (!built.ok) throw new Error(built.question);
    expect(built.spec).toMatchObject({
      source: 'invoices',
      dimensions: [],
      measures: [
        { fn: 'count', as: 'number_of_invoices' },
        { fn: 'sum', field: 'totalAmount', as: 'total_amount' },
      ],
      filters: [
        { field: 'issueDate', op: 'gte', value: '2025-12-01' },
        { field: 'issueDate', op: 'lt', value: '2026-01-01' },
      ],
      chart: { type: 'stat' },
    });
  });

  it('resolve loosely written names and group by them', () => {
    const built = specFromIntent(
      {
        source: 'invoices',
        measures: [{ fn: 'sum', field: 'Total amount' }],
        groupBy: 'STATUS',
        bucket: 'month',
      },
      plannerReportSources(mechanic(), recipes),
      NOW,
    );
    if (!built.ok) throw new Error(built.question);
    expect(built.spec.dimensions.map((d) => [d.field, d.bucket])).toEqual([
      ['status', undefined],
      ['issueDate', 'month'],
    ]);
    expect(built.spec.chart).toMatchObject({ type: 'bar', x: 'status' });
  });

  it('group "by month" on the date itself as one time grouping', () => {
    const built = specFromIntent(
      { source: 'invoices', groupBy: 'issueDate', bucket: 'month' },
      plannerReportSources(mechanic(), recipes),
      NOW,
    );
    if (!built.ok) throw new Error(built.question);
    expect(built.spec.dimensions).toEqual([
      { field: 'issueDate', bucket: 'month', as: 'issue_date_month' },
    ]);
  });

  it.each([
    [
      'sales last quarter by week',
      'week',
      '2025-10-01',
      '2026-01-01',
      'Invoices by week, last quarter',
    ],
    [
      'sales over the last 90 days',
      undefined,
      '2025-10-04',
      '2026-01-02',
      'Invoices, last 90 days',
    ],
    [
      'sales this year',
      undefined,
      '2026-01-01',
      '2027-01-01',
      'Invoices, this year',
    ],
    ['sales in Q3', undefined, '2025-07-01', '2025-10-01', 'Invoices, Q3 2025'],
    [
      'monthly sales for 2025',
      'month',
      '2025-01-01',
      '2026-01-01',
      'Invoices by month, 2025',
    ],
  ])('reads "%s" against the sample clock', (text, bucket, from, to, title) => {
    const built = specFromIntent(
      { source: 'invoices' },
      plannerReportSources(mechanic(), recipes),
      NOW,
      text,
    );
    if (!built.ok) throw new Error(built.question);
    expect(built.spec.title).toBe(title);
    expect(built.spec.filters).toEqual([
      { field: 'issueDate', op: 'gte', value: from },
      { field: 'issueDate', op: 'lt', value: to },
    ]);
    expect(built.spec.dimensions.find((d) => d.bucket)?.bucket).toBe(bucket);
  });

  it('a range the code cannot read asks for a period, as choices', () => {
    const built = specFromIntent(
      { source: 'invoices', range: 'around easter' },
      plannerReportSources(mechanic(), recipes),
      NOW,
    );
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.followUp?.field).toBe('period');
      expect(built.followUp?.options.map((o) => o.label)).toContain(
        'Last month',
      );
    }
  });

  it('an amount follow-up changes only the unresolved measure', () => {
    const built = specFromIntent(
      {
        source: 'invoices',
        measures: [{ fn: 'count' }, { fn: 'sum', field: 'mileage' }],
      },
      plannerReportSources(mechanic(), recipes),
      NOW,
    );
    if (built.ok || !built.followUp) throw new Error('expected a follow-up');
    expect(built.followUp.options[0].apply.measures).toEqual([
      { fn: 'count' },
      { fn: 'sum', field: 'totalAmount' },
    ]);
  });

  it('a grouping follow-up with nothing to offer is a plain question', () => {
    const source = {
      id: 'things',
      label: 'Things',
      schema: [
        { name: 'id', type: 'string' as const },
        { name: 'note', type: 'string' as const },
      ],
      model: plannerReportSources(mechanic(), recipes)[0].model,
    };
    expect(
      specFromIntent({ source: 'things', groupBy: 'flavour' }, [source], NOW),
    ).toEqual({ ok: false, question: 'Group Things by what?' });
  });

  it('records what it could not read instead of dropping it', () => {
    const intent = parseReportIntent({
      source: 'invoices',
      period: 'last_fortnight',
      filters: [{ field: 'status', op: 'like', value: 'paid' }],
    });
    expect(intent?.unreadable).toEqual(['the status filter', 'the period']);
    const built = specFromIntent(
      intent as NonNullable<typeof intent>,
      plannerReportSources(mechanic(), recipes),
      NOW,
    );
    expect(built).toEqual({
      ok: false,
      question:
        'I could not read the status filter and the period for the Invoices report. Can you say that again?',
    });
  });

  it.each([
    [{ source: 'orders_of_cake' }, /Which records should the report cover/],
    [
      {
        source: 'invoices',
        measures: [{ fn: 'sum' as const, field: 'colour' }],
      },
      /Which amount on .+ should I total/,
    ],
    [{ source: 'invoices', groupBy: 'flavour' }, /Group Invoices by…/],
    [
      {
        source: 'invoices',
        period: 'last_month' as const,
        dateField: 'birthday',
      },
      /Which date on .+ should the report use/,
    ],
  ])('ask a follow-up instead of guessing (%#)', (intent, question) => {
    const built = specFromIntent(
      intent,
      plannerReportSources(mechanic(), recipes),
      NOW,
    );
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.question).toMatch(question);
      expect(built.question).toMatch(/[?…]$/);
    }
  });
});

describe('planner reports store', () => {
  it('names sources for the report screens and keeps when a report was saved, with real run times', async () => {
    const { reports } = setup();
    const invoices = reports.sourceInfo().find((s) => s.id === 'invoices');
    expect(invoices?.label).toBeTruthy();
    expect(invoices?.fields?.find((f) => f.name === 'issueDate')).toMatchObject(
      {
        type: 'datetime',
      },
    );
    const defined = await reports.define({
      source: 'invoices',
      period: 'last_month',
    });
    if (!defined.ok) throw new Error(defined.question);
    // The description holds conditions beyond the period, none here.
    expect(defined.proposal.spec.description).toBeUndefined();
    const before = Date.now();
    const saved = await reports.save(defined.proposal);
    expect(Date.parse(saved.savedAt ?? '')).toBeGreaterThanOrEqual(before);
    // A run is stamped with the real time, not the sample clock.
    const ran = await reports.client.run(saved.id);
    expect(Date.parse(ran.ranAt)).toBeGreaterThanOrEqual(before);
  });

  it('previews, then saves only on save, then runs the saved report afresh', async () => {
    const { data, reports } = setup();
    const defined = await reports.define({
      source: 'invoices',
      period: 'last_month',
    });
    if (!defined.ok) throw new Error(defined.question);
    const { proposal } = defined;
    expect(proposal.status).toBe('awaiting_confirmation');
    expect(proposal.specHash).toBe(
      await runtimeReportSpecDigest(proposal.spec),
    );
    const model = getModelByQualifiedName(RUNTIME_REPORT_MODEL)?.model;
    if (!model) throw new Error('RuntimeReport');
    expect(await data.list(model)).toEqual([]);

    const saved = await reports.save(proposal);
    expect(saved).toMatchObject({
      title: 'Invoices, last month',
      sourceId: 'invoices',
      status: 'active',
      createdByUserId: PLANNER_REPORT_AUTHOR,
    });
    // A retried approval saves once.
    expect((await reports.save(proposal)).id).toBe(saved.id);
    expect(await data.list(model)).toHaveLength(1);

    const listed = await reports.client.list({
      onlyMine: true,
      includeArchived: false,
    });
    expect(listed.map((r) => r.id)).toEqual([saved.id]);
    const result = await reports.client.run(saved.id);
    expect(result.rows).toEqual(proposal.preview.rows);

    await reports.client.archive(saved.id, true);
    expect(
      await reports.client.list({ onlyMine: false, includeArchived: false }),
    ).toEqual([]);
    await expect(reports.client.run(saved.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it('refuses a proposal whose hash does not match its spec', async () => {
    const { reports } = setup();
    const defined = await reports.define({ source: 'invoices' });
    if (!defined.ok) throw new Error(defined.question);
    await expect(
      reports.save({
        ...defined.proposal,
        spec: { ...defined.proposal.spec, title: 'Something else' },
      }),
    ).rejects.toMatchObject({ code: 'spec_hash_mismatch' });
  });

  it('reads money filter amounts in currency units and states them', async () => {
    const { data, reports } = setup();
    const defined = await reports.define({
      source: 'invoices',
      filters: [{ field: 'totalAmount', op: 'gt', value: '$500' }],
    });
    if (!defined.ok) throw new Error(defined.question);
    const { spec, preview } = defined.proposal;
    expect(spec.filters).toEqual([
      { field: 'totalAmount', op: 'gt', value: 50000 },
    ]);
    expect(spec.description).toBe('Total amount over 500.00');
    const model = getModelByQualifiedName(
      '@happyvertical/smrt-commerce:Invoice',
    )?.model;
    if (!model) throw new Error('Invoice');
    const over = (await data.list(model)).filter(
      (row) => typeof row.totalAmount === 'number' && row.totalAmount > 50000,
    );
    expect(preview.rows).toEqual([
      {
        number_of_invoices: over.length,
        total_amount: over.length
          ? over.reduce((sum, row) => sum + (row.totalAmount as number), 0)
          : null,
      },
    ]);
    for (const value of ['a lot', '$1k', '1e3', '500 or 600']) {
      expect(
        await reports.define({
          source: 'invoices',
          filters: [{ field: 'totalAmount', op: 'gt', value }],
        }),
      ).toEqual({
        ok: false,
        question: 'What amount should Total amount be compared with?',
      });
    }
    const written = await reports.define({
      source: 'invoices',
      filters: [{ field: 'totalAmount', op: 'gte', value: '$1,250.50' }],
    });
    if (!written.ok) throw new Error(written.question);
    expect(written.proposal.spec.filters[0].value).toBe(125050);
  });

  it('turns a value the field cannot take into a question', async () => {
    const { reports } = setup();
    const defined = await reports.define({
      source: 'invoices',
      filters: [{ field: 'issueDate', op: 'gte', value: 'last spring' }],
    });
    expect(defined.ok).toBe(false);
    if (!defined.ok) expect(defined.question).toMatch(/\?$/);
  });
});
