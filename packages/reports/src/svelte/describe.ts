/**
 * Words and numbers for a report, shared by every runtime-report screen (the
 * saved-report cards, a report's page, the assistant's proposal card), so they
 * name a report the same way: its source by label, groupings, the period with
 * its dates, measures by their column labels, and headline figures from a run.
 * Pure: it formats with the caller's `t`, locale and currency.
 */
import { formatWidgetValue } from '@happyvertical/smrt-ui/charts';
import { reportCell } from './result.js';
import type { RuntimeReportResult, RuntimeReportSpec } from './types.js';

/** A source field as a report screen names and formats it (its descriptor's `fields`). */
export interface ReportFieldInfo {
  name: string;
  label: string;
  /** `datetime`, `integer`, `decimal`, `text`... */
  type?: string;
  /** `money`, `date`... */
  format?: string;
}

/** A source by label, with its fields (a `reports.runtime.sources` descriptor). */
export interface ReportSourceInfo {
  id: string;
  label: string;
  fields?: readonly ReportFieldInfo[];
}

type Translate = (key: string, values?: Record<string, unknown>) => string;
type Column = RuntimeReportResult['columns'][number];

export function humanizeName(name: string): string {
  return name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/^./, (c) => c.toUpperCase());
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function asDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const date = new Date(
    /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value,
  );
  return Number.isNaN(date.getTime()) ? null : date;
}

export interface ReportPeriod {
  /** The field the period is on ("Issue date"). */
  field: string;
  /** The dates it covers ("1 Dec 2025 – 31 Dec 2025"), in UTC. */
  range: string;
  /** The indexes of the filters it consumed. */
  filters: number[];
}

/**
 * The spec's period: a lower (`gte`/`gt`) and/or upper (`lt`/`lte`) bound on
 * one date field. An exclusive upper bound at midnight reads as the day
 * before, so "last month" reads 1–31 December.
 */
export function reportPeriod(
  spec: RuntimeReportSpec,
  options: {
    locale: string;
    label: (field: string) => string;
    t: Translate;
  },
): ReportPeriod | null {
  const bounds = new Map<
    string,
    { from?: Date; to?: Date; filters: number[] }
  >();
  spec.filters.forEach((filter, index) => {
    const date = asDate(filter.value);
    if (!date) return;
    const entry = bounds.get(filter.field) ?? { filters: [] };
    if (filter.op === 'gte' || filter.op === 'gt') entry.from = date;
    else if (filter.op === 'lt' || filter.op === 'lte') {
      const to = new Date(date);
      const midnight =
        to.getUTCHours() === 0 &&
        to.getUTCMinutes() === 0 &&
        to.getUTCSeconds() === 0;
      if (filter.op === 'lt' && midnight) to.setUTCDate(to.getUTCDate() - 1);
      entry.to = to;
    } else return;
    entry.filters.push(index);
    bounds.set(filter.field, entry);
  });
  const [field, found] = [...bounds.entries()][0] ?? [];
  if (!field || !found) return null;
  let tag = 'en';
  try {
    tag = Intl.getCanonicalLocales(options.locale)[0] ?? 'en';
  } catch {
    // keep `en`
  }
  const format = new Intl.DateTimeFormat(tag, {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const range =
    found.from && found.to
      ? format.formatRange(found.from, found.to)
      : found.from
        ? options.t('reports.period.since', { date: format.format(found.from) })
        : found.to
          ? options.t('reports.period.until', {
              date: format.format(found.to as Date),
            })
          : '';
  return { field: options.label(field), range, filters: found.filters };
}

export interface ReportDescription {
  source: string;
  /** "Issue date by month", or "" for an ungrouped report. */
  groupings: string;
  period: ReportPeriod | null;
  measures: string[];
  /** Conditions other than the period. */
  filters: string[];
  having: string[];
  /** One line for a card: source · groupings · period. */
  line: string;
}

/** Describe a spec in the source's own words. */
export function describeReport(
  spec: RuntimeReportSpec,
  options: {
    t: Translate;
    locale: string;
    currency: string;
    source?: ReportSourceInfo;
    /** A result's columns, for measure labels ("Total amount"). */
    columns?: readonly Column[];
  },
): ReportDescription {
  const { t, locale, currency, source, columns } = options;
  const fieldOf = (name: string) =>
    source?.fields?.find((f) => f.name === name);
  const label = (name: string) => fieldOf(name)?.label ?? humanizeName(name);
  const sourceLabel = source?.label ?? humanizeName(spec.source);
  const groupings = spec.dimensions
    .map((d) =>
      d.bucket
        ? t('reports.dimension_bucket', {
            field: label(d.field),
            bucket: t(`reports.bucket_unit.${d.bucket}`),
          })
        : label(d.field),
    )
    .join(', ');
  const period = reportPeriod(spec, { locale, label, t });
  const measures = spec.measures.map(
    (m) =>
      columns?.find((c) => c.id === m.as)?.label ??
      (m.field
        ? t(`reports.aggregate.${m.fn}`, { field: label(m.field) })
        : t('reports.aggregate.rows', { source: sourceLabel })),
  );
  const value = (field: string, raw: unknown) => {
    const show = (v: unknown) =>
      fieldOf(field)?.format === 'money' && typeof v === 'number'
        ? formatWidgetValue(v, { format: 'money', currency, locale })
        : String(v ?? '');
    return Array.isArray(raw) ? raw.map(show).join(', ') : show(raw);
  };
  const filters = spec.filters
    .filter((_, index) => !period?.filters.includes(index))
    .map((f) =>
      `${label(f.field)} ${t(`reports.operator.${f.op}`)} ${value(f.field, f.value)}`.trim(),
    );
  const measureLabel = (alias: string) =>
    columns?.find((c) => c.id === alias)?.label ?? humanizeName(alias);
  const having = spec.having.map(
    (h) =>
      `${measureLabel(h.measure)} ${t(`reports.operator.${h.op}`)} ${h.value}`,
  );
  const line = [sourceLabel, groupings, period?.range]
    .filter((part): part is string => Boolean(part))
    .join(' · ');
  return {
    source: sourceLabel,
    groupings,
    period,
    measures,
    filters,
    having,
    line,
  };
}

const BUCKETS = new Set([
  'minute',
  'hour',
  'day',
  'week',
  'month',
  'quarter',
  'year',
]);

/** Does the result's x axis run over time buckets? */
export function timeAxis(result: RuntimeReportResult): Column | undefined {
  const x = result.chart.x
    ? result.columns.find((c) => c.id === result.chart.x)
    : result.columns.find((c) => c.role === 'dimension');
  return x?.bucket && BUCKETS.has(x.bucket) ? x : undefined;
}

/** The measure columns a result charts, in order. */
/** The measure columns, the charted ones (`chart.y`) first. */
export function measureColumns(result: RuntimeReportResult): Column[] {
  const measures = result.columns.filter((c) => c.role === 'measure');
  const charted = result.chart.y ?? [];
  return [
    ...measures.filter((c) => charted.includes(c.id)),
    ...measures.filter((c) => !charted.includes(c.id)),
  ];
}

/** A measure's chart format. */
export function measureFormat(column: Column): 'money' | 'integer' | 'decimal' {
  return column.format === 'money'
    ? 'money'
    : column.type === 'integer'
      ? 'integer'
      : 'decimal';
}

export interface ReportFigure {
  /** What the figure is ("Total", "Average per month", "Peak"). */
  label: string;
  value: string;
  /** Where the peak was ("Sep 2025"). */
  detail?: string;
}

/**
 * Headline figures for one measure: the total (only for an additive measure:
 * a sum or a row count), the average per group, and the peak with its group.
 * An ungrouped report has one value, its own figure.
 */
export function reportFigures(
  result: RuntimeReportResult,
  measure: Column,
  options: {
    t: Translate;
    locale: string;
    currency: string;
    /** How a group reads ("Sep 2025" for a time bucket). */
    groupLabel: (row: RuntimeReportResult['rows'][number]) => string;
    /** The measure's function, when the spec is known. */
    fn?: string;
  },
): ReportFigure[] {
  const { t, locale, currency } = options;
  const values = result.rows
    .map((row) => ({ row, value: row[measure.id] }))
    .filter(
      (entry): entry is { row: typeof entry.row; value: number } =>
        typeof entry.value === 'number' && Number.isFinite(entry.value),
    );
  if (values.length === 0) return [];
  const show = (value: number) =>
    reportCell(
      measure.type === 'integer' && !Number.isInteger(value)
        ? Math.round(value * 100) / 100
        : value,
      measure.type === 'integer' && !Number.isInteger(value)
        ? { ...measure, type: 'decimal' }
        : measure,
      locale,
      currency,
    );
  const grouped = result.columns.some((c) => c.role === 'dimension');
  if (!grouped || values.length === 1) {
    return [{ label: measure.label, value: show(values[0].value) }];
  }
  const sum = values.reduce((total, entry) => total + entry.value, 0);
  const peak = values.reduce((best, entry) =>
    entry.value > best.value ? entry : best,
  );
  const axis = timeAxis(result);
  const figures: ReportFigure[] = [];
  if (options.fn === 'sum' || options.fn === 'count') {
    figures.push({ label: t('reports.figure.total'), value: show(sum) });
  }
  figures.push({
    label: axis?.bucket
      ? t('reports.figure.average_per', {
          bucket: t(`reports.bucket_unit.${axis.bucket}`),
        })
      : t('reports.figure.average'),
    value: show(sum / values.length),
  });
  figures.push({
    label: t('reports.figure.peak'),
    value: show(peak.value),
    detail: options.groupLabel(peak.row),
  });
  return figures;
}

/** "3 days ago", "in 2 hours", "just now": a time relative to `now`. */
export function relativeTime(
  iso: string,
  locale: string,
  now: Date = new Date(),
  /** What under a minute reads as ("just now"); default the locale's "now". */
  justNow?: string,
): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return iso;
  let tag = 'en';
  try {
    tag = Intl.getCanonicalLocales(locale)[0] ?? 'en';
  } catch {
    // keep `en`
  }
  const seconds = Math.round((then.getTime() - now.getTime()) / 1000);
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_536_000],
    ['month', 2_592_000],
    ['week', 604_800],
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  const format = new Intl.RelativeTimeFormat(tag, { numeric: 'auto' });
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) {
      return format.format(Math.round(seconds / size), unit);
    }
  }
  return justNow ?? format.format(0, 'second');
}

/**
 * A cell as CSV text: quoted when needed, and a text cell is never read as a
 * formula. A number column's cell ("-$5.00", "-3") is left as a number.
 */
function csvCell(text: string, numeric = false): string {
  const safe = !numeric && /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The result as CSV with the screen's own formatting (labels, buckets, money). */
export function reportCsv(
  result: RuntimeReportResult,
  cell: (value: unknown, column: Column) => string,
): string {
  const lines = [
    result.columns.map((column) => csvCell(column.label)).join(','),
    ...result.rows.map((row) =>
      result.columns
        .map((column) =>
          csvCell(
            cell(row[column.id], column),
            (column.type === 'integer' || column.type === 'decimal') &&
              typeof row[column.id] === 'number',
          ),
        )
        .join(','),
    ),
  ];
  return `${lines.join('\r\n')}\r\n`;
}
