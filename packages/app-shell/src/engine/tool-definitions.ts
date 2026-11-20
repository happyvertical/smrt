import {
  parseRuntimeReportSpec,
  RUNTIME_REPORT_FILTER_OPS,
} from '@happyvertical/smrt-reports';
import type { Command } from './commands.ts';

// Keep the advertised example checked by the owning grammar, rather than asking
// an assistant to guess the shape of an untyped object.
const reportExample = parseRuntimeReportSpec({
  title: 'Open orders',
  source: 'Orders',
  measures: [
    { fn: 'count', as: 'order_count' },
    { fn: 'sum', field: 'total', as: 'order_total' },
  ],
  filters: [{ field: 'status', op: 'eq', value: 'Open' }],
});

// Transport-neutral engine tool schemas. Hosts own authorization and dispatch.
const string = { type: 'string' };
const object = { type: 'object' };
export const ENGINE_TOOLS = [
  {
    name: 'app_mergerecords',
    description:
      'Merge records and repoint every app reference. Always needs live approval.',
    properties: {
      model: string,
      keep: string,
      merge: { type: 'array', items: string, minItems: 1, maxItems: 1000 },
      fields: { type: 'object', additionalProperties: string },
    },
    required: ['model', 'keep', 'merge'],
  },
  {
    name: 'app_extractmodel',
    description: 'Extract distinct text values into referenced records.',
    properties: {
      model: string,
      field: string,
      into: string,
      titleField: string,
      normalize: { type: 'boolean' },
    },
    required: ['model', 'field', 'into'],
  },
  {
    name: 'app_loadrecords',
    description:
      'Load rows atomically with optional key upsert and reference lookup.',
    properties: {
      model: string,
      rows: { type: 'array', items: object, maxItems: 10000 },
      mode: { type: 'string', enum: ['insert', 'upsert'] },
      key: { type: 'array', items: string },
      references: object,
    },
    required: ['model', 'rows', 'mode'],
  },
  {
    name: 'app_setcalculation',
    description: 'Set or clear a database-calculated field.',
    properties: {
      model: string,
      field: string,
      calculated: { type: ['object', 'null'] },
    },
    required: ['model', 'field', 'calculated'],
  },
  {
    name: 'app_definereport',
    description: 'Create or replace a saved declarative report.',
    properties: { name: string, definition: object },
    required: ['name', 'definition'],
  },
  {
    name: 'app_renamereport',
    description: 'Rename a saved report.',
    properties: { from: string, to: string },
    required: ['from', 'to'],
  },
  {
    name: 'app_removereport',
    description: 'Remove a saved report definition.',
    properties: { name: string },
    required: ['name'],
  },
  {
    name: 'app_runreport',
    description: 'Run a saved report name or an ad-hoc declarative spec.',
    properties: {
      report: {
        type: ['string', 'object'],
        description: `A saved report name or a report object. For an object, source is the exact model name from app_describe (case-sensitive), never a table or REST route. Fields are the exact camelCase field names. Use measures with fn/as and optional field; omit field for count. IMPORTANT: as is an output alias, not a source field. Output aliases must be unique lowercase_snake_case, at most 40 characters (for example order_count and order_total, NEVER orderCount or orderTotal). You may omit as to let the report choose safe aliases. Only source field names use camelCase. Filters use field/op/value, where op is one of ${RUNTIME_REPORT_FILTER_OPS.join(', ')} (ne means not equal, for example status ne Cancelled; use eq, ne, gt, gte, lt, lte, never = or !=; isNull and isNotNull take no value; in and notIn take a list). To group by time, give a dimension a bucket (one of minute, hour, day, week, month, quarter, year) on a date field, for example dimensions: [{"field":"orderDate","bucket":"month","as":"month"}]; the dimension as alias defaults to the field plus the bucket. To sort, use sort: [{"by":"month","direction":"asc"}] where by is an output alias from dimensions or measures and direction is asc or desc; never field or dir. Example: ${JSON.stringify(reportExample)}`,
      },
      maxRows: { type: 'integer', minimum: 1, maximum: 1000 },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
    },
    required: ['report'],
  },
] as const;

export function isEngineTool(name: string) {
  return ENGINE_TOOLS.some((t) => t.name === name);
}

export const ENGINE_COMMAND_TYPES: Record<string, Command['type']> = {
  app_mergerecords: 'mergeRecords',
  app_extractmodel: 'extractModel',
  app_loadrecords: 'loadRecords',
  app_setcalculation: 'setCalculation',
  app_definereport: 'defineReport',
  app_renamereport: 'renameReport',
  app_removereport: 'removeReport',
};
