// Owner-only engine catalog adapters. Presentation summaries carry human labels;
// the existing catalog policy and builder remain the execution and approval gates.
import type { RuntimeReportSpec } from '@happyvertical/smrt-reports';
import type { Command } from '../../engine/index.ts';
import { toolSummary } from '../assistant/tool-summary.ts';
import { fieldLabel, recordLabel } from '../ui/fields.ts';
import type { RecordRow } from '../ui/types.ts';
import { runCommand } from './builder.ts';
import { hostFor } from './host.ts';
import { assertOwner } from './owner.ts';
import type { CallScope } from './target.ts';

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
      report: { type: ['string', 'object'] },
      maxRows: { type: 'integer', minimum: 1, maximum: 1000 },
      timeoutMs: { type: 'integer', minimum: 1, maximum: 10000 },
    },
    required: ['report'],
  },
] as const;

export function isEngineTool(name: string) {
  return ENGINE_TOOLS.some((t) => t.name === name);
}

export async function runEngineTool(
  name: string,
  args: Record<string, unknown>,
  scope: CallScope,
) {
  const owner = await assertOwner();
  if (name === 'app_runreport') {
    const host = await hostFor(scope.records);
    const result = await host.runReport(
      args.report as string | RuntimeReportSpec,
      {
        maxRows: args.maxRows as number | undefined,
        timeoutMs: args.timeoutMs as number | undefined,
      },
    );
    const saved = typeof args.report === 'string' ? args.report : undefined;
    const title = saved
      ? (host.describe().reports?.[saved]?.label ?? result.title)
      : result.title;
    return {
      ...result,
      summary: toolSummary(
        name,
        `Ran ${title}: ${result.rowCount} ${result.rowCount === 1 ? 'row' : 'rows'}`,
      ),
      ...(saved ? { reportName: saved } : {}),
    };
  }
  const types: Record<string, Command['type']> = {
    app_mergerecords: 'mergeRecords',
    app_extractmodel: 'extractModel',
    app_loadrecords: 'loadRecords',
    app_setcalculation: 'setCalculation',
    app_definereport: 'defineReport',
    app_renamereport: 'renameReport',
    app_removereport: 'removeReport',
  };
  const type = types[name];
  if (!type) throw new Error('unknown engine tool');
  // The caller cannot override the command discriminant or supply approval.
  const host = await hostFor(scope.structure);
  const description = host.describe();
  const model = description.models[String(args.model)];
  const report = description.reports?.[String(args.name ?? args.from)];
  let summary = '';
  switch (name) {
    case 'app_definereport': {
      const definition = args.definition as
        | { label?: string; spec?: { title?: string } }
        | undefined;
      summary = `Made the report ${definition?.label ?? definition?.spec?.title ?? 'you asked for'}`;
      break;
    }
    case 'app_renamereport':
      summary = `Renamed the report ${report?.label ?? report?.spec.title ?? 'you chose'} to ${String(args.to)}`;
      break;
    case 'app_removereport':
      summary = `Removed the report ${report?.label ?? report?.spec.title ?? 'you chose'}`;
      break;
    case 'app_setcalculation': {
      const field = model?.fields[String(args.field)];
      summary = `${args.calculated === null ? 'Cleared the calculation for' : 'Calculated'} ${field ? fieldLabel(String(args.field), field) : 'the field'}`;
      break;
    }
    case 'app_loadrecords':
      summary = `Loaded ${Array.isArray(args.rows) ? args.rows.length : 0} ${model?.label ?? 'records'}`;
      break;
    case 'app_extractmodel':
      summary = `Made linked records from ${model?.fields[String(args.field)] ? fieldLabel(String(args.field), model.fields[String(args.field)]) : 'the selected field'}`;
      break;
    case 'app_mergerecords': {
      const keep = await host.get(String(args.model), String(args.keep));
      const label = keep && model ? recordLabel(model, keep as RecordRow) : '';
      summary = `Merged ${Array.isArray(args.merge) ? args.merge.length : 0} ${model?.label ?? 'records'} into ${label && label !== String(args.keep) && !label.endsWith('…') ? label : 'the selected record'}`;
      break;
    }
  }
  const result = await runCommand(
    { ...args, type } as Command,
    owner.id,
    scope.structure,
  );
  if ('status' in result && result.status === 'pending_approval') return result;
  return { ...result, summary: toolSummary(name, summary) };
}
