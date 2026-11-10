/**
 * Grouping and time hints for a report source (#4100): which fields read as a
 * time axis, which one is the source's natural date, and which are worth
 * grouping by, most useful first.
 *
 * Both runners' source descriptions (`describeRuntimeReportSource()`,
 * `describeRuntimeReportMemorySource()`) carry these, so an assistant or a
 * report builder offers "Issue date by month", "Status" and "Customer", never
 * an id, a hash or internal bookkeeping. A source definition may declare them
 * (`timeField`, `dimensions`); otherwise they are derived from field metadata
 * in this order:
 *
 * - time fields: every datetime field except a soft-delete stamp;
 * - the natural date: a business date (`@field({ ui: { format: 'date' } })`),
 *   else the first datetime that is not bookkeeping (`createdAt`, `updatedAt`,
 *   `syncedAt`, `last…At`), else `createdAt`;
 * - groupings: closed text fields (declared `enum`) and booleans as
 *   categories, foreign keys as relations; never `id`, free text, or a field
 *   whose name marks it internal (`…Hash`, `…Json`, `…Token`, `…Authority`,
 *   `…Snapshot`, `external…`, `historical…`), ranked status, then kind/type,
 *   then people and things (customer, vendor, product), then other categories,
 *   other relations, then flags.
 *
 * These are hints for choosing, not authority: a spec may still group by any
 * field the source exposes, and the compiler's field policy is unchanged.
 * Browser-safe: no Node built-ins, no registry.
 */

import type {
  RuntimeReportDimensionHints,
  RuntimeReportDimensionKind,
  RuntimeReportPlanField,
  RuntimeReportSourceDescription,
} from './runtime-plan.js';
import {
  RUNTIME_REPORT_OPERATORS_BY_TYPE,
  runtimeReportAggregatesFor,
} from './runtime-plan.js';

/** Names that mark plumbing, never a grouping a person asks for. */
const INTERNAL_NAME =
  /^(?:id|_.*)$|(?:Hash|Json|Token|Secret|Signature|Authority|Snapshot|Checksum|Cursor|Etag)$|^(?:external|historical)[A-Z]/;
/** Timestamps a framework or a sync writes; never the natural date. */
const BOOKKEEPING_TIME =
  /^(?:created|updated|deleted|synced|archived)At$|^last[A-Z]\w*At$/;
const STATUS_NAME = /^(?:status|state)$|(?:Status|State)$/;
const KIND_NAME =
  /^(?:kind|type|category|method|channel|stage|priority|segment|tier|source)$|(?:Kind|Type|Category|Method|Channel|Stage|Priority|Segment|Tier)$/;
const PARTY_RELATION =
  /^(?:customer|vendor|supplier|client|member|employee|owner|assignee|product|location|project|account|contact)Id$/;
/** More distinct values than this is not a category anyone groups by. */
const MAX_CATEGORY_VALUES = 50;

function kindOf(
  field: RuntimeReportPlanField,
): RuntimeReportDimensionKind | undefined {
  if (field.type === 'datetime') {
    return field.name === 'deletedAt' ? undefined : 'time';
  }
  if (INTERNAL_NAME.test(field.name)) return undefined;
  if (field.type === 'boolean') return 'category';
  if (
    field.type === 'string' &&
    field.enum &&
    field.enum.length > 0 &&
    field.enum.length <= MAX_CATEGORY_VALUES
  ) {
    return 'category';
  }
  if (field.type === 'id' && /Id$/.test(field.name)) return 'relation';
  return undefined;
}

function rank(field: RuntimeReportPlanField): number {
  if (field.type === 'boolean') return 10;
  if (field.type === 'id') return PARTY_RELATION.test(field.name) ? 70 : 30;
  if (STATUS_NAME.test(field.name)) return 100;
  if (KIND_NAME.test(field.name)) return 80;
  return 50;
}

export interface RuntimeReportDimensionPlan {
  kinds: Map<string, RuntimeReportDimensionKind>;
  timeFields: string[];
  defaultTimeField?: string;
  dimensions: string[];
}

/**
 * Plan the time and grouping hints for resolved fields. Declared hints that
 * name a field this principal cannot see are dropped (the field set already
 * hides it), never reported.
 */
export function planRuntimeReportDimensions(
  fields: ReadonlyMap<string, RuntimeReportPlanField>,
  hints: RuntimeReportDimensionHints = {},
): RuntimeReportDimensionPlan {
  const all = [...fields.values()];
  const kinds = new Map<string, RuntimeReportDimensionKind>();
  for (const field of all) {
    const kind = kindOf(field);
    if (kind) kinds.set(field.name, kind);
  }

  const times = all.filter((field) => kinds.get(field.name) === 'time');
  const declaredTime =
    hints.timeField && fields.get(hints.timeField)?.type === 'datetime'
      ? hints.timeField
      : undefined;
  const defaultTimeField =
    declaredTime ??
    times.find((field) => field.businessDate)?.name ??
    times.find((field) => !BOOKKEEPING_TIME.test(field.name))?.name ??
    times.find((field) => field.name === 'createdAt')?.name ??
    times[0]?.name;
  const timeFields = [
    ...(defaultTimeField ? [defaultTimeField] : []),
    ...times.map((f) => f.name).filter((name) => name !== defaultTimeField),
  ];

  let dimensions: string[];
  if (hints.dimensions) {
    dimensions = hints.dimensions.filter(
      (name) => fields.has(name) && fields.get(name)?.type !== 'datetime',
    );
    for (const name of dimensions) {
      if (!kinds.has(name)) {
        kinds.set(
          name,
          fields.get(name)?.type === 'id' ? 'relation' : 'category',
        );
      }
    }
    // Declared groupings replace the derived ones; time stays time.
    for (const [name, kind] of [...kinds]) {
      if (kind !== 'time' && !dimensions.includes(name)) kinds.delete(name);
    }
  } else {
    dimensions = all
      .filter((field) => {
        const kind = kinds.get(field.name);
        return kind === 'category' || kind === 'relation';
      })
      .map((field, index) => ({ field, index }))
      .sort((a, b) => rank(b.field) - rank(a.field) || a.index - b.index)
      .map(({ field }) => field.name);
  }
  return {
    kinds,
    timeFields,
    ...(defaultTimeField ? { defaultTimeField } : {}),
    dimensions,
  };
}

/** The described fields and grouping hints of a source with these fields. */
export function describeRuntimeReportSourceFields(
  fields: ReadonlyMap<string, RuntimeReportPlanField>,
  hints: RuntimeReportDimensionHints = {},
): Pick<
  RuntimeReportSourceDescription,
  'fields' | 'timeFields' | 'defaultTimeField' | 'dimensions'
> {
  const plan = planRuntimeReportDimensions(fields, hints);
  return {
    fields: [...fields.values()].map((field) => {
      const dimension = plan.kinds.get(field.name);
      return {
        name: field.name,
        label: field.label,
        type: field.type,
        ...(field.format ? { format: field.format } : {}),
        ...(field.enum ? { enum: field.enum } : {}),
        ...(dimension ? { dimension } : {}),
        filterOperators: RUNTIME_REPORT_OPERATORS_BY_TYPE[field.type],
        aggregates: runtimeReportAggregatesFor(field.type),
      };
    }),
    timeFields: plan.timeFields,
    ...(plan.defaultTimeField
      ? { defaultTimeField: plan.defaultTimeField }
      : {}),
    dimensions: plan.dimensions,
  };
}
