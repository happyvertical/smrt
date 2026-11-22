import type { RuntimeReportSpec } from '@happyvertical/smrt-reports/svelte';
import {
  formatTimeBucket,
  type TimeBucketUnit,
} from '@happyvertical/smrt-ui/charts/format';
import { cellText } from './columns.ts';
import { fieldLabel } from './fields.ts';
import { formulaWords } from './formula.ts';
import { modelHref } from './menu.ts';
import type { AppReportResult, ModelInfo, ReportDef } from './types.ts';

export const reportHref = (name: string) =>
  `/reports/${encodeURIComponent(name)}`;
export const reportApi = (name: string) =>
  `/api/shell/reports/${encodeURIComponent(name)}`;

/** One display path for chart labels, table cells, assistant results and CSV. */
export function reportCell(
  value: unknown,
  column: AppReportResult['columns'][number],
  row: AppReportResult['rows'][number],
): string {
  if (column.labelColumn) return String(row[column.labelColumn] ?? '');
  if (column.bucket && typeof value === 'string')
    return formatTimeBucket(value, column.bucket as TimeBucketUnit, 'en-US');
  return cellText(
    {
      ...(column.money ? { money: column.money } : {}),
      type:
        column.format === 'money'
          ? 'money'
          : column.format === 'date' || column.type === 'datetime'
            ? 'date'
            : column.type === 'boolean'
              ? 'boolean'
              : 'text',
    },
    value,
  );
}
/** Columns the chat shows: a 400px column fits three without scrolling. */
export const CHAT_KEY_COLUMNS = 3;

/**
 * The report's key columns for the chat: the ones the report itself charts
 * (its category and measures), else the first few, up to `max`, in result
 * order. Rows stay whole (a reference column's label lives in a row key);
 * only what the table shows is trimmed. `hidden` counts the rest.
 */
export function keyColumns(
  result: AppReportResult,
  max = CHAT_KEY_COLUMNS,
): { result: AppReportResult; hidden: number } {
  const picked = new Set(
    [result.chart.x, ...(result.chart.y ?? [])].filter(
      (id): id is string => typeof id === 'string',
    ),
  );
  const wanted = result.columns.filter((c) => picked.has(c.id));
  const key = (wanted.length > 0 ? wanted : result.columns).slice(0, max);
  return {
    result: { ...result, columns: key, chart: { type: 'table' } },
    hidden: result.columns.length - key.length,
  };
}

export function reportCellHref(
  column: AppReportResult['columns'][number],
  row: AppReportResult['rows'][number],
) {
  return column.reference && row[column.id] != null
    ? `${modelHref(column.reference)}/${encodeURIComponent(String(row[column.id]))}`
    : undefined;
}
const operators: Record<string, string> = {
  eq: 'is',
  ne: 'is not',
  gt: 'is more than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  in: 'is one of',
  notIn: 'is not one of',
  contains: 'contains',
  isNull: 'is empty',
  isNotNull: 'is not empty',
};
const measures: Record<string, string> = {
  count: 'Count',
  countDistinct: 'Distinct count',
  sum: 'Sum',
  avg: 'Average',
  min: 'Lowest',
  max: 'Highest',
};
/** Explain the saved spec, including calculated inputs, without asking a model. */
export function reportWords(
  report: ReportDef,
  models: Record<string, ModelInfo>,
): string {
  const spec: RuntimeReportSpec = report.spec;
  const model = models[spec.source];
  const fields = model?.fields ?? {};
  const label = (name: string) => {
    const field = fields[name];
    return field ? fieldLabel(name, field) : 'Removed field';
  };
  // A calculated field is named plainly; how it is worked out follows once.
  const calculated = new Set<string>();
  const note = (name: string) => {
    if (fields[name]?.calculated) calculated.add(name);
    return label(name);
  };
  const conditions = spec.filters.map((f) =>
    `${note(f.field)} ${operators[f.op]} ${f.value === undefined ? '' : (Array.isArray(f.value) ? f.value : [f.value]).map((v) => (fields[f.field]?.type === 'reference' ? 'the selected record' : cellText(fields[f.field] ?? { type: 'text' }, v))).join(', ')}`.trim(),
  );
  conditions.push(
    ...spec.having.map((h) => {
      const measure = spec.measures.find((m) => m.as === h.measure);
      const name = measure
        ? `${measures[measure.fn]}${measure.field ? ` of ${note(measure.field)}` : ' of records'}`
        : 'Removed measure';
      return `${name} ${operators[h.op]} ${measure?.field && fields[measure.field] ? cellText(fields[measure.field], h.value) : h.value}`;
    }),
  );
  const text = `${spec.measures.map((m) => `${measures[m.fn]}${m.field ? ` of ${note(m.field)}` : ' of records'}`).join(', ')} from ${model?.label ?? 'a removed model'}${spec.dimensions.length ? `, grouped by ${spec.dimensions.map((d) => `${note(d.field)}${d.bucket ? ` by ${d.bucket}` : ''}`).join(', ')}` : ''}${conditions.length ? `, where ${conditions.join(' and ')}` : ''}.`;
  const how = [...calculated].flatMap((name) => {
    const formula = fields[name]?.calculated;
    return formula
      ? [`${label(name)} is ${formulaWords(formula, fields)}.`]
      : [];
  });
  return [text, ...how].join(' ');
}

export interface ReportChange {
  kind: 'added' | 'changed' | 'removed';
  text: string;
}
export function reportChanges(
  before: Record<string, ReportDef>,
  after: Record<string, ReportDef>,
  summary = '',
): ReportChange[] {
  const rename = /rename report (\w+) -> (\w+)/.exec(summary);
  const label = (name: string, reports: Record<string, ReportDef>) =>
    reports[name]?.label ?? reports[name]?.spec.title ?? 'Untitled report';
  if (rename && before[rename[1]] && after[rename[2]])
    return [
      {
        kind: 'changed',
        text:
          label(rename[1], before) === label(rename[2], after)
            ? `Changed the link of report ${label(rename[1], before)}.`
            : `Renamed report ${label(rename[1], before)} to ${label(rename[2], after)}.`,
      },
    ];
  return [
    ...Object.keys(after)
      .filter((n) => !Object.hasOwn(before, n))
      .map((n) => ({
        kind: 'added' as const,
        text: `Added report ${label(n, after)}.`,
      })),
    ...Object.keys(before)
      .filter((n) => !Object.hasOwn(after, n))
      .map((n) => ({
        kind: 'removed' as const,
        text: `Removed report ${label(n, before)}.`,
      })),
    ...Object.keys(after)
      .filter(
        (n) =>
          Object.hasOwn(before, n) &&
          JSON.stringify(before[n]) !== JSON.stringify(after[n]),
      )
      .map((n) => ({
        kind: 'changed' as const,
        text:
          before[n].label !== after[n].label &&
          JSON.stringify(before[n].spec) === JSON.stringify(after[n].spec)
            ? `Renamed report ${label(n, before)} to ${label(n, after)}.`
            : `Changed report ${label(n, after)}.`,
      })),
  ];
}
