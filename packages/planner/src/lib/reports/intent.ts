/**
 * A report request as the assistant's model states it, and the spec the
 * planner's code builds from it (#4100).
 *
 * The on-device model is small, so it never writes a `RuntimeReportSpec`. It
 * names an intent in its structured-JSON answer (which records, what to
 * measure, how to group, which period); this module resolves the names
 * against the source's fields, fills the gaps a person leaves ("a summary" is
 * a count and the main amount; a period uses the business date) and builds the
 * spec, which `parseRuntimeReportSpec` then validates. Anything it cannot
 * resolve becomes a follow-up question, never a guess.
 */

import {
  describeRuntimeReportMemorySource,
  parseRuntimeReportSpec,
  RUNTIME_REPORT_LIMITS,
  RuntimeReportError,
  type RuntimeReportMeasureFn,
  type RuntimeReportSourceDescription,
  type RuntimeReportSpec,
} from '@happyvertical/smrt-reports/spec';
import type { PlannerReportSource } from './sources.ts';

export const REPORT_PERIODS = [
  'today',
  'yesterday',
  'this_week',
  'last_week',
  'this_month',
  'last_month',
  'this_quarter',
  'last_quarter',
  'this_year',
  'last_year',
  'all_time',
] as const;
export type ReportPeriod = (typeof REPORT_PERIODS)[number];

export const REPORT_BUCKETS = [
  'day',
  'week',
  'month',
  'quarter',
  'year',
] as const;
export type ReportBucket = (typeof REPORT_BUCKETS)[number];

export const REPORT_MEASURES = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type ReportMeasure = (typeof REPORT_MEASURES)[number];

export const REPORT_FILTER_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
] as const;
export type ReportFilterOp = (typeof REPORT_FILTER_OPS)[number];

/** Most measures and filters an intent may name; the schema caps them too. */
const MAX_MEASURES = 4;
const MAX_FILTERS = 3;
const MAX_NAME = 64;

/** What the model says it wants. Everything but `source` is optional. */
export interface ReportIntent {
  source: string;
  measures?: { fn: ReportMeasure; field?: string }[];
  /** A field to group by (a status, a customer). */
  groupBy?: string;
  /** Group by time on the date field instead (or as well). */
  bucket?: ReportBucket;
  period?: ReportPeriod;
  /** The date a period and a time grouping use; defaults to the source's. */
  dateField?: string;
  filters?: {
    field: string;
    op: ReportFilterOp;
    value: string | number | boolean;
  }[];
  title?: string;
}

/** The JSON Schema of the `report` property of one assistant turn. */
export function reportIntentSchema(
  sourceIds: readonly string[],
): Record<string, unknown> {
  const name = { type: 'string', maxLength: MAX_NAME };
  return {
    type: ['object', 'null'],
    properties: {
      // A host builds its schema before it knows the plan: any id, checked
      // against the offered sources when the planner builds the spec.
      source: sourceIds.length
        ? { enum: [...sourceIds] }
        : {
            type: 'string',
            maxLength: RUNTIME_REPORT_LIMITS.maxSourceIdLength,
          },
      measures: {
        type: 'array',
        maxItems: MAX_MEASURES,
        items: {
          type: 'object',
          properties: { fn: { enum: [...REPORT_MEASURES] }, field: name },
          required: ['fn'],
          additionalProperties: false,
        },
      },
      groupBy: name,
      bucket: { enum: [...REPORT_BUCKETS] },
      period: { enum: [...REPORT_PERIODS] },
      dateField: name,
      filters: {
        type: 'array',
        maxItems: MAX_FILTERS,
        items: {
          type: 'object',
          properties: {
            field: name,
            op: { enum: [...REPORT_FILTER_OPS] },
            value: { type: ['string', 'number', 'boolean'] },
          },
          required: ['field', 'op', 'value'],
          additionalProperties: false,
        },
      },
      title: {
        type: 'string',
        maxLength: RUNTIME_REPORT_LIMITS.maxTitleLength,
      },
    },
    required: ['source'],
    additionalProperties: false,
  };
}

const oneOf = <T extends string>(value: unknown, list: readonly T[]) =>
  typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : undefined;

const shortText = (value: unknown, max = MAX_NAME) =>
  typeof value === 'string' && value.trim() && value.trim().length <= max
    ? value.trim()
    : undefined;

/**
 * Read the model's `report` property. Structure only: names are kept as the
 * model wrote them and resolved by `specFromIntent`. A `source` outside the
 * offered ids is kept too, so the follow-up can say what is offered.
 */
export function parseReportIntent(value: unknown): ReportIntent | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const source = shortText(raw.source, RUNTIME_REPORT_LIMITS.maxSourceIdLength);
  if (!source) return null;
  const measures = Array.isArray(raw.measures)
    ? raw.measures.slice(0, MAX_MEASURES).flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const m = entry as Record<string, unknown>;
        const fn = oneOf(m.fn, REPORT_MEASURES);
        if (!fn) return [];
        const field = shortText(m.field);
        return [{ fn, ...(field ? { field } : {}) }];
      })
    : [];
  const filters = Array.isArray(raw.filters)
    ? raw.filters.slice(0, MAX_FILTERS).flatMap((entry) => {
        if (!entry || typeof entry !== 'object') return [];
        const f = entry as Record<string, unknown>;
        const field = shortText(f.field);
        const op = oneOf(f.op, REPORT_FILTER_OPS);
        const v = f.value;
        if (
          !field ||
          !op ||
          !(
            (typeof v === 'string' && v.length <= 256) ||
            (typeof v === 'number' && Number.isFinite(v)) ||
            typeof v === 'boolean'
          )
        ) {
          return [];
        }
        return [{ field, op, value: v }];
      })
    : [];
  const groupBy = shortText(raw.groupBy);
  const bucket = oneOf(raw.bucket, REPORT_BUCKETS);
  const period = oneOf(raw.period, REPORT_PERIODS);
  const dateField = shortText(raw.dateField);
  const title = shortText(raw.title, RUNTIME_REPORT_LIMITS.maxTitleLength);
  return {
    source,
    ...(measures.length ? { measures } : {}),
    ...(groupBy ? { groupBy } : {}),
    ...(bucket ? { bucket } : {}),
    ...(period ? { period } : {}),
    ...(dateField ? { dateField } : {}),
    ...(filters.length ? { filters } : {}),
    ...(title ? { title } : {}),
  };
}

// ---------------------------------------------------------------------------
// Periods. UTC, like the runner's buckets; relative to the caller's clock.

const DAY = 86_400_000;
const ymd = (time: number) => new Date(time).toISOString().slice(0, 10);

/** `[from, to)` as `YYYY-MM-DD`, or null for all time. */
export function periodRange(
  period: ReportPeriod,
  now: Date,
): { from: string; to: string } | null {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const d = now.getUTCDate();
  const today = Date.UTC(y, m, d);
  const monday = today - ((now.getUTCDay() + 6) % 7) * DAY;
  const quarter = Math.floor(m / 3) * 3;
  const range = (from: number, to: number) => ({
    from: ymd(from),
    to: ymd(to),
  });
  switch (period) {
    case 'today':
      return range(today, today + DAY);
    case 'yesterday':
      return range(today - DAY, today);
    case 'this_week':
      return range(monday, monday + 7 * DAY);
    case 'last_week':
      return range(monday - 7 * DAY, monday);
    case 'this_month':
      return range(Date.UTC(y, m, 1), Date.UTC(y, m + 1, 1));
    case 'last_month':
      return range(Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1));
    case 'this_quarter':
      return range(Date.UTC(y, quarter, 1), Date.UTC(y, quarter + 3, 1));
    case 'last_quarter':
      return range(Date.UTC(y, quarter - 3, 1), Date.UTC(y, quarter, 1));
    case 'this_year':
      return range(Date.UTC(y, 0, 1), Date.UTC(y + 1, 0, 1));
    case 'last_year':
      return range(Date.UTC(y - 1, 0, 1), Date.UTC(y, 0, 1));
    case 'all_time':
      return null;
  }
}

/** "last month" for a title. */
export const periodLabel = (period: ReportPeriod): string =>
  period.replace(/_/g, ' ');

// ---------------------------------------------------------------------------
// Names. A small model writes "total", "Total amount" or "totalAmount".

const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, '');

type DescribedField = RuntimeReportSourceDescription['fields'][number];

function resolveField(
  name: string,
  fields: readonly DescribedField[],
  accept: (field: DescribedField) => boolean = () => true,
): DescribedField | undefined {
  const wanted = squash(name);
  const candidates = fields.filter(accept);
  return (
    candidates.find((f) => f.name === name) ??
    candidates.find((f) => squash(f.name) === wanted) ??
    candidates.find((f) => squash(f.label) === wanted)
  );
}

/** "A, B or C" for a question. At most six, the rest elided. */
function choices(labels: readonly string[]): string {
  const shown = labels.slice(0, 6);
  const more = labels.length > shown.length ? ', …' : '';
  if (shown.length <= 1) return `${shown.join('')}${more}`;
  return `${shown.slice(0, -1).join(', ')}${more} or ${shown[shown.length - 1]}`;
}

export type IntentResult =
  | { ok: true; spec: RuntimeReportSpec; source: PlannerReportSource }
  | { ok: false; question: string };

const ask = (question: string): IntentResult => ({ ok: false, question });

/** The question for records no source offers. */
export function whichSourceQuestion(
  sources: readonly {
    label: string;
    amountField?: string;
    dateField?: string;
  }[],
): string {
  // Records with amounts (invoices, orders, payments) are what reports are
  // usually about, so they are named first.
  const weight = (s: { amountField?: string; dateField?: string }) =>
    (s.amountField ? 2 : 0) + (s.dateField ? 1 : 0);
  const ordered = [...sources].sort((a, b) => weight(b) - weight(a));
  return ordered.length
    ? `Which records should the report cover: ${choices(ordered.map((s) => s.label))}?`
    : 'Which records should the report cover? Add a recipe with records first, such as invoicing?';
}

/** A readable output alias: `number_of_invoices`, `total_amount`, `average_subtotal`. */
function measureAlias(
  fn: ReportMeasure,
  field: string | undefined,
  sourceId: string,
): string {
  const snake = (text: string) =>
    text
      .replace(/([a-z\d])([A-Z])/g, '$1_$2')
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_');
  const alias =
    fn === 'count' || !field
      ? `number_of_${snake(sourceId)}`
      : fn === 'sum'
        ? snake(field).startsWith('total')
          ? snake(field)
          : `total_${snake(field)}`
        : `${{ avg: 'average', min: 'lowest', max: 'highest' }[fn]}_${snake(field)}`;
  return alias
    .slice(0, RUNTIME_REPORT_LIMITS.maxAliasLength)
    .replace(/_+$/, '');
}

const OP_WORDS: Record<ReportFilterOp, string> = {
  eq: 'is',
  ne: 'is not',
  gt: 'over',
  gte: 'at least',
  lt: 'under',
  lte: 'at most',
  contains: 'contains',
};

/** A money amount in currency units ("500", "$1,250.50", 500) as integer minor units. */
function moneyAmount(value: string | number | boolean): number | null {
  const units =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && /\d/.test(value)
        ? Number(value.replace(/[^0-9.-]/g, ''))
        : Number.NaN;
  return Number.isFinite(units) ? Math.round(units * 100) : null;
}

const isNumeric = (field: DescribedField) =>
  field.type === 'integer' || field.type === 'decimal';

/**
 * Build a spec from an intent over the offered sources. `now` is the clock a
 * period is relative to (the planner passes its sample-data clock).
 */
export function specFromIntent(
  intent: ReportIntent,
  sources: readonly PlannerReportSource[],
  now: Date,
): IntentResult {
  const source = sources.find((s) => s.id === intent.source);
  if (!source) return ask(whichSourceQuestion(sources));
  const { fields } = describeRuntimeReportMemorySource(sources, source.id);
  const noun = source.label;

  // Measures: "a summary" is how many and how much.
  const requested = intent.measures?.length
    ? intent.measures
    : [
        { fn: 'count' as const },
        ...(source.amountField
          ? [{ fn: 'sum' as const, field: source.amountField }]
          : []),
      ];
  const measures: {
    fn: RuntimeReportMeasureFn;
    field?: string;
    as?: string;
  }[] = [];
  for (const measure of requested) {
    if (measure.fn === 'count') {
      if (!measures.some((m) => m.fn === 'count')) {
        measures.push({
          fn: 'count',
          as: measureAlias('count', undefined, source.id),
        });
      }
      continue;
    }
    const named = measure.field ?? source.amountField;
    const field = named
      ? resolveField(named, fields, (f) =>
          measure.fn === 'min' || measure.fn === 'max'
            ? isNumeric(f) || f.type === 'datetime'
            : isNumeric(f),
        )
      : undefined;
    if (!field) {
      const numeric = fields.filter(isNumeric).map((f) => f.label);
      return ask(
        numeric.length
          ? `Which amount on ${noun} should I ${measure.fn === 'sum' ? 'total' : `take the ${measure.fn} of`}: ${choices(numeric)}?`
          : `${noun} have no amounts to total. Should I count them instead?`,
      );
    }
    measures.push({
      fn: measure.fn,
      field: field.name,
      as: measureAlias(measure.fn, field.name, source.id),
    });
  }

  // The business date, for a period and for time grouping.
  const needsDate = Boolean(
    intent.bucket || (intent.period && intent.period !== 'all_time'),
  );
  let dateField: DescribedField | undefined;
  if (needsDate) {
    const named = intent.dateField ?? source.dateField;
    dateField = named
      ? resolveField(named, fields, (f) => f.type === 'datetime')
      : undefined;
    if (!dateField) {
      const dates = fields.filter((f) => f.type === 'datetime');
      return ask(
        dates.length
          ? `Which date on ${noun} should the period use: ${choices(dates.map((f) => f.label))}?`
          : `${noun} have no date to filter by. Should the report cover all of them?`,
      );
    }
  }

  const dimensions: { field: string; bucket?: ReportBucket; as?: string }[] =
    [];
  if (intent.groupBy) {
    const field = resolveField(intent.groupBy, fields);
    if (!field) {
      const groupable = fields
        .filter((f) => f.type === 'string' || f.type === 'boolean')
        .map((f) => f.label);
      return ask(
        `Group ${noun} by what: ${choices(groupable.length ? groupable : fields.map((f) => f.label))}?`,
      );
    }
    dimensions.push({ field: field.name });
  }
  if (intent.bucket && dateField) {
    dimensions.push({ field: dateField.name, bucket: intent.bucket });
  }

  const filters: { field: string; op: string; value: unknown }[] = [];
  const range =
    intent.period && dateField ? periodRange(intent.period, now) : null;
  if (range && dateField) {
    filters.push({ field: dateField.name, op: 'gte', value: range.from });
    filters.push({ field: dateField.name, op: 'lt', value: range.to });
  }
  const stated: string[] = [];
  for (const filter of intent.filters ?? []) {
    const field = resolveField(filter.field, fields);
    if (!field) {
      return ask(
        `Which field on ${noun} should "${filter.field}" filter: ${choices(fields.map((f) => f.label))}?`,
      );
    }
    if (field.format === 'money') {
      // People state amounts in currency units ("over $500"); money is stored
      // in integer minor units, so the threshold is scaled, never guessed.
      const amount = moneyAmount(filter.value);
      if (amount === null) {
        return ask(`What amount should ${field.label} be compared with?`);
      }
      filters.push({ field: field.name, op: filter.op, value: amount });
      stated.push(
        `${field.label} ${OP_WORDS[filter.op]} ${(amount / 100).toFixed(2)}`,
      );
      continue;
    }
    filters.push({ field: field.name, op: filter.op, value: filter.value });
    stated.push(
      `${field.label} ${OP_WORDS[filter.op]} ${String(filter.value)}`,
    );
  }

  const title =
    intent.title ??
    [
      noun,
      intent.period && intent.period !== 'all_time'
        ? periodLabel(intent.period)
        : '',
    ]
      .filter(Boolean)
      .join(', ');
  // The description states every condition, so a saved report says what it
  // counts (a threshold included), not only its period.
  const description =
    [
      range
        ? `${dateField?.label ?? 'Date'} from ${range.from} up to ${range.to}`
        : '',
      ...stated,
    ]
      .filter(Boolean)
      .join('; ') || undefined;
  const measureAliases = (spec: RuntimeReportSpec) =>
    spec.measures.map((m) => m.as);
  try {
    const draft = parseRuntimeReportSpec({
      title,
      ...(description ? { description } : {}),
      source: source.id,
      dimensions,
      measures,
      filters,
    });
    const amounts = draft.measures.filter((m) => m.fn !== 'count');
    const lead = (amounts[0] ?? draft.measures[0]).as;
    const time = draft.dimensions.find((d) => d.bucket);
    const category = draft.dimensions.find((d) => !d.bucket);
    const spec = parseRuntimeReportSpec({
      ...draft,
      // A category reads best largest first; time reads in order.
      sort: category && !time ? [{ by: lead, direction: 'desc' }] : [],
      chart: draft.dimensions.length
        ? {
            type: time && !category ? 'line' : 'bar',
            x: (category ?? time)?.as,
            y: amounts.length
              ? amounts.map((m) => m.as)
              : measureAliases(draft),
          }
        : {
            type: 'stat',
            y: measureAliases(draft),
          },
    });
    return { ok: true, spec, source };
  } catch (error) {
    if (error instanceof RuntimeReportError) {
      return ask(
        `I could not build that report (${error.message}). What should it show?`,
      );
    }
    throw error;
  }
}

/**
 * A follow-up for a spec the runner rejected (a filter value of the wrong
 * type, an operator a field does not take): what to change, as a question.
 */
export function questionForError(
  error: RuntimeReportError,
  source: PlannerReportSource,
): string {
  if (error.code === 'invalid_value') {
    return `That value does not fit ${source.label} (${error.message}). What value did you mean?`;
  }
  if (error.code === 'invalid_operation') {
    return `I cannot use that on ${source.label} (${error.message}). What should the report show instead?`;
  }
  return `I could not build that report (${error.message}). What should it show?`;
}
