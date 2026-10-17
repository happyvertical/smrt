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
  parseRuntimeReportTime,
  RUNTIME_REPORT_LIMITS,
  RuntimeReportError,
  type RuntimeReportMeasureFn,
  type RuntimeReportSourceDescription,
  type RuntimeReportSpec,
  type RuntimeReportTimeRange,
  resolveRuntimeReportTimeRange,
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
  'minute',
  'hour',
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
const MAX_UNREADABLE = 8;

/** What the model says it wants. Everything but `source` is optional. */
export interface ReportIntent {
  source: string;
  measures?: { fn: ReportMeasure; field?: string }[];
  /** A field to group by (a status, a customer). */
  groupBy?: string;
  /** Group by time on the date field instead (or as well). */
  bucket?: ReportBucket;
  period?: ReportPeriod;
  /** A period in words ("last 90 days", "Q3", "December"); code resolves it. */
  range?: string;
  /** The date a period and a time grouping use; defaults to the source's. */
  dateField?: string;
  filters?: {
    field: string;
    op: ReportFilterOp;
    value: string | number | boolean;
  }[];
  title?: string;
  /** Parts the model stated that could not be read; a follow-up asks about them. */
  unreadable?: string[];
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
      range: { type: 'string', maxLength: 40 },
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
  // A part the model stated but that cannot be read is recorded, never
  // dropped: dropping a filter or a period would silently broaden the report.
  const stated = (key: string) => raw[key] !== undefined && raw[key] !== null;
  // A host server parses the model's reply first and passes on what it could
  // not read; keep that (bounded) so the browser still asks about it.
  const unreadable: string[] = Array.isArray(raw.unreadable)
    ? raw.unreadable
        .filter(
          (entry): entry is string =>
            typeof entry === 'string' && entry.trim().length > 0,
        )
        .slice(0, MAX_UNREADABLE)
        .map((entry) => entry.trim().slice(0, MAX_NAME))
    : [];
  if (stated('measures') && !Array.isArray(raw.measures)) {
    unreadable.push('the measures');
  }
  if (stated('filters') && !Array.isArray(raw.filters)) {
    unreadable.push('the filters');
  }
  const measures = Array.isArray(raw.measures)
    ? raw.measures.slice(0, MAX_MEASURES).flatMap((entry) => {
        const m = (entry && typeof entry === 'object' ? entry : {}) as Record<
          string,
          unknown
        >;
        const fn = oneOf(m.fn, REPORT_MEASURES);
        if (!fn) {
          unreadable.push('a measure');
          return [];
        }
        const field = shortText(m.field);
        return [{ fn, ...(field ? { field } : {}) }];
      })
    : [];
  const filters = Array.isArray(raw.filters)
    ? raw.filters.slice(0, MAX_FILTERS).flatMap((entry) => {
        const f = (entry && typeof entry === 'object' ? entry : {}) as Record<
          string,
          unknown
        >;
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
          unreadable.push(field ? `the ${field} filter` : 'a filter');
          return [];
        }
        return [{ field, op, value: v }];
      })
    : [];
  if (Array.isArray(raw.measures) && raw.measures.length > MAX_MEASURES) {
    unreadable.push(`more than ${MAX_MEASURES} measures`);
  }
  if (Array.isArray(raw.filters) && raw.filters.length > MAX_FILTERS) {
    unreadable.push(`more than ${MAX_FILTERS} filters`);
  }
  const groupBy = shortText(raw.groupBy);
  const bucket = oneOf(raw.bucket, REPORT_BUCKETS);
  const period = oneOf(raw.period, REPORT_PERIODS);
  const dateField = shortText(raw.dateField);
  const range = shortText(raw.range, 40);
  const title = shortText(raw.title, RUNTIME_REPORT_LIMITS.maxTitleLength);
  if (stated('range') && !range) unreadable.push('the period');
  if (stated('groupBy') && !groupBy) unreadable.push('the grouping');
  if (stated('bucket') && !bucket) unreadable.push('the time grouping');
  if (stated('period') && !period) unreadable.push('the period');
  if (stated('dateField') && !dateField) unreadable.push('the date');
  return {
    source,
    ...(measures.length ? { measures } : {}),
    ...(groupBy ? { groupBy } : {}),
    ...(bucket ? { bucket } : {}),
    ...(period ? { period } : {}),
    ...(range ? { range } : {}),
    ...(dateField ? { dateField } : {}),
    ...(filters.length ? { filters } : {}),
    ...(title ? { title } : {}),
    ...(unreadable.length ? { unreadable } : {}),
  };
}

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

/** One option of a follow-up: picking it merges `apply` into the intent. */
export interface ReportFollowUpOption {
  value: string;
  label: string;
  /** Extra words a typed answer may use ("monthly", "date"). */
  keywords?: string[];
  apply: Partial<ReportIntent>;
}

/**
 * A follow-up question built by code from the source descriptor (its human
 * dimensions, time fields and amounts), never from a model's prose. The
 * transport renders it as a form and merges the pick into the pending intent.
 */
export interface ReportFollowUp {
  /** The intent slot it fills: `groupBy`, `source`, `measure`, `dateField`, `period`. */
  field: string;
  /** The form field's label ("Group by"). */
  label: string;
  /** The question ("Group Invoices by…"). */
  prompt: string;
  options: ReportFollowUpOption[];
  /** The sensible pick, preselected and used after a second miss. */
  default: string;
}

export type IntentResult =
  | { ok: true; spec: RuntimeReportSpec; source: PlannerReportSource }
  | { ok: false; question: string; followUp?: ReportFollowUp };

const ask = (question: string): IntentResult => ({ ok: false, question });

const follow = (followUp: Omit<ReportFollowUp, 'default'>): IntentResult => ({
  ok: false,
  question: followUp.prompt,
  followUp: { ...followUp, default: followUp.options[0].value },
});

/** Most options a follow-up offers. */
const MAX_OPTIONS = 8;

/** Records with amounts and dates (invoices, orders, payments) first. */
function rankSources<T extends { amountField?: string; dateField?: string }>(
  sources: readonly T[],
): T[] {
  const weight = (s: T) => (s.amountField ? 2 : 0) + (s.dateField ? 1 : 0);
  return [...sources].sort((a, b) => weight(b) - weight(a));
}

/** "Which records should the report cover?", with the sources as options. */
export function sourceFollowUp(
  sources: readonly PlannerReportSource[],
): ReportFollowUp | null {
  const ranked = rankSources(sources).slice(0, MAX_OPTIONS);
  if (!ranked.length) return null;
  return {
    field: 'source',
    label: 'Records',
    prompt: 'Which records should the report cover?',
    options: ranked.map((source) => ({
      value: source.id,
      label: source.label,
      apply: { source: source.id },
    })),
    default: ranked[0].id,
  };
}

/** The question for records no source offers. */
export function whichSourceQuestion(
  sources: readonly PlannerReportSource[],
): string {
  return sources.length
    ? 'Which records should the report cover?'
    : 'Which records should the report cover? Add a recipe with records first, such as invoicing?';
}

const BUCKET_WORDS: Record<string, ReportBucket> = {
  minute: 'minute',
  minutely: 'minute',
  hour: 'hour',
  hourly: 'hour',
  day: 'day',
  daily: 'day',
  week: 'week',
  weekly: 'week',
  month: 'month',
  monthly: 'month',
  quarter: 'quarter',
  quarterly: 'quarter',
  year: 'year',
  yearly: 'year',
  annual: 'year',
  annually: 'year',
};
const TIME_FILLER = new Set([
  'by',
  'per',
  'the',
  'each',
  'every',
  'a',
  'over',
  'time',
  'date',
  'dates',
  'in',
]);

/**
 * A grouping the model wrote as time ("month", "by month", "the date month",
 * "issue date monthly"): its bucket, and what is left once the time words go
 * (a date field's name, or nothing).
 */
function timeGrouping(text: string): {
  bucket?: ReportBucket;
  rest: string;
  time: boolean;
} {
  const words = text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let bucket: ReportBucket | undefined;
  let time = false;
  const rest: string[] = [];
  for (const word of words) {
    const singular = word.endsWith('s') ? word.slice(0, -1) : word;
    const found = BUCKET_WORDS[word] ?? BUCKET_WORDS[singular];
    if (found) {
      bucket ??= found;
      time = true;
    } else if (TIME_FILLER.has(word)) {
      if (word === 'date' || word === 'dates' || word === 'time') time = true;
    } else rest.push(word);
  }
  return { ...(bucket ? { bucket } : {}), rest: rest.join(' '), time };
}

const PERIOD_OPTIONS: { value: string; label: string }[] = [
  { value: 'this month', label: 'This month' },
  { value: 'last month', label: 'Last month' },
  { value: 'this quarter', label: 'This quarter' },
  { value: 'last quarter', label: 'Last quarter' },
  { value: 'this year', label: 'This year' },
  { value: 'last year', label: 'Last year' },
  { value: 'all time', label: 'All time' },
];

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

/**
 * One amount in currency units, written plainly ("500", "$1,250.50", "-20",
 * 500), as integer minor units. Anything else ("$1k", "1e3", "500 or 600") is
 * not read at all: a guessed threshold would save the wrong report.
 */
const MONEY_TEXT = /^-?\s*[$€£¥]?\s*-?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;
function moneyAmount(value: string | number | boolean): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.round(value * 100) : null;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!MONEY_TEXT.test(text)) return null;
  const units = Number(text.replace(/[^0-9.-]/g, ''));
  return Number.isFinite(units) ? Math.round(units * 100) : null;
}

const isNumeric = (field: DescribedField) =>
  field.type === 'integer' || field.type === 'decimal';

/**
 * Build a spec from an intent over the offered sources. `now` is the clock a
 * period is relative to (the planner passes its sample-data clock); `text` is
 * what the person said, whose time words ("by month", "last quarter", "over
 * time") fill what the model left out. Anything else unresolved is a
 * follow-up built from the source descriptor.
 */
export function specFromIntent(
  intent: ReportIntent,
  sources: readonly PlannerReportSource[],
  now: Date,
  text = '',
): IntentResult {
  const source = sources.find((s) => s.id === intent.source);
  if (!source) {
    const followUp = sourceFollowUp(sources);
    return followUp
      ? { ok: false, question: followUp.prompt, followUp }
      : ask(whichSourceQuestion(sources));
  }
  const described = describeRuntimeReportMemorySource(sources, source.id);
  const { fields } = described;
  const noun = source.label;
  const labelOf = (name: string) =>
    fields.find((f) => f.name === name)?.label ?? name;
  if (intent.unreadable?.length) {
    return ask(
      `I could not read ${choices(intent.unreadable).replace(/ or ([^,]+)$/, ' and $1')} for the ${noun} report. Can you say that again?`,
    );
  }
  const said = parseRuntimeReportTime(text, now);

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
    const accept = (f: DescribedField) =>
      measure.fn === 'min' || measure.fn === 'max'
        ? isNumeric(f) || f.type === 'datetime'
        : isNumeric(f);
    const field = named ? resolveField(named, fields, accept) : undefined;
    if (!field) {
      const numeric = fields.filter((f) => isNumeric(f) && f.name !== 'id');
      if (!numeric.length) {
        return ask(
          `${noun} have no amounts to total. Should I count them instead?`,
        );
      }
      // The document total first, then money: "how much" is an amount.
      const ranked = [
        ...numeric.filter((f) => f.name === source.amountField),
        ...numeric.filter(
          (f) => f.format === 'money' && f.name !== source.amountField,
        ),
        ...numeric.filter((f) => f.format !== 'money'),
      ].slice(0, MAX_OPTIONS);
      return follow({
        field: 'measure',
        label: measure.fn === 'sum' ? 'Total' : 'Amount',
        prompt: `Which amount on ${noun} should I ${measure.fn === 'sum' ? 'total' : `take the ${measure.fn} of`}?`,
        options: ranked.map((f) => ({
          value: f.name,
          label: f.label,
          apply: { measures: [{ fn: measure.fn, field: f.name }] },
        })),
      });
    }
    measures.push({
      fn: measure.fn,
      field: field.name,
      as: measureAlias(measure.fn, field.name, source.id),
    });
  }

  // Time: a grouping the model wrote as time words, else the person's words.
  let groupBy = intent.groupBy;
  let dateName = intent.dateField;
  let bucket = intent.bucket;
  if (groupBy) {
    const timed = timeGrouping(groupBy);
    const asDate = resolveField(groupBy, fields, (f) => f.type === 'datetime');
    if (asDate) {
      // "Group by issue date": its months.
      dateName ??= asDate.name;
      bucket ??= 'month';
      groupBy = undefined;
    } else if (timed.time) {
      const restDate = timed.rest
        ? resolveField(timed.rest, fields, (f) => f.type === 'datetime')
        : undefined;
      if (!timed.rest || restDate) {
        if (restDate) dateName ??= restDate.name;
        bucket ??= timed.bucket ?? said.bucket ?? 'month';
        groupBy = undefined;
      }
    }
  }
  bucket ??= said.bucket;

  let range: RuntimeReportTimeRange | null = null;
  if (intent.range) {
    range = resolveRuntimeReportTimeRange(intent.range, now);
    if (!range && !/\ball\s*time\b|\bever\b/i.test(intent.range)) {
      return follow({
        field: 'period',
        label: 'Period',
        prompt: `Which period should the ${noun} report cover?`,
        options: PERIOD_OPTIONS.map((p) => ({
          ...p,
          apply: { range: p.value, period: undefined },
        })),
      });
    }
  } else if (intent.period && intent.period !== 'all_time') {
    range = resolveRuntimeReportTimeRange(intent.period, now);
  } else if (!intent.period) {
    range = said.range ?? null;
  }

  // The natural date (the descriptor's default) for a period or time grouping.
  let dateField: DescribedField | undefined;
  if (bucket || range) {
    dateField = dateName
      ? resolveField(dateName, fields, (f) => f.type === 'datetime')
      : described.defaultTimeField
        ? fields.find((f) => f.name === described.defaultTimeField)
        : undefined;
    if (!dateField) {
      const dates = described.timeFields.slice(0, MAX_OPTIONS);
      if (!dates.length) {
        return ask(
          `${noun} have no date to group or filter by. Should the report cover all of them?`,
        );
      }
      return follow({
        field: 'dateField',
        label: 'Date',
        prompt: `Which date on ${noun} should the report use?`,
        options: dates.map((name) => ({
          value: name,
          label: labelOf(name),
          apply: { dateField: name },
        })),
      });
    }
  }

  const dimensions: { field: string; bucket?: ReportBucket; as?: string }[] =
    [];
  if (groupBy) {
    const groupable = new Set(described.dimensions);
    const field =
      resolveField(groupBy, fields, (f) => groupable.has(f.name)) ??
      resolveField(groupBy, fields, (f) => f.type !== 'datetime');
    if (field) dimensions.push({ field: field.name });
    // A word the time grouping already covers ("sales by month" read as
    // groupBy "sales"): the bucket answers it. Otherwise ask, from the
    // descriptor's human groupings.
    else if (!(bucket && dateField)) {
      return follow(
        groupingFollowUp(described, noun, labelOf, said.mentionsTime),
      );
    }
  }
  if (bucket && dateField) {
    dimensions.push({ field: dateField.name, bucket });
  }

  const filters: { field: string; op: string; value: unknown }[] = [];
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
      [
        noun,
        ...dimensions.map((d) =>
          d.bucket ? `by ${d.bucket}` : `by ${labelOf(d.field).toLowerCase()}`,
        ),
      ].join(' '),
      range?.label ?? '',
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
 * "Group Invoices by…": the descriptor's human groupings, never ids, hashes
 * or plumbing. When time came up, the natural date by month leads.
 */
function groupingFollowUp(
  described: RuntimeReportSourceDescription,
  noun: string,
  labelOf: (name: string) => string,
  timeFirst: boolean,
): Omit<ReportFollowUp, 'default'> {
  const date = described.defaultTimeField;
  const time: ReportFollowUpOption[] = date
    ? (['month', 'week', 'quarter'] as const).map((bucket) => ({
        value: `${date}:${bucket}`,
        label: `${labelOf(date)} by ${bucket}`,
        keywords: [`${bucket}ly`, 'date', 'time', 'per', bucket],
        apply: { groupBy: undefined, bucket, dateField: date },
      }))
    : [];
  const categories: ReportFollowUpOption[] = described.dimensions.map(
    (name) => ({
      value: name,
      label: labelOf(name),
      apply: { groupBy: name },
    }),
  );
  const options = timeFirst
    ? [...time, ...categories]
    : [
        ...categories.slice(0, 4),
        ...time.slice(0, 1),
        ...categories.slice(4),
        ...time.slice(1),
      ];
  return {
    field: 'groupBy',
    label: 'Group by',
    prompt: `Group ${noun} by…`,
    options: options.slice(0, MAX_OPTIONS),
  };
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
