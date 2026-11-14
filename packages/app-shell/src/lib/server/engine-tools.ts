import {
  ENGINE_COMMAND_TYPES,
  ENGINE_TOOLS,
  EngineError,
} from '../../engine/index.ts';

export { ENGINE_TOOLS, isEngineTool } from '../../engine/index.ts';

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
import { reportFailure } from './report-display.ts';
import type { CallScope } from './target.ts';

function own<T>(
  values: Record<string, T> | undefined,
  name: unknown,
): T | undefined {
  return values && typeof name === 'string' && Object.hasOwn(values, name)
    ? values[name]
    : undefined;
}

function validateArgs(name: string, args: Record<string, unknown>) {
  const tool = ENGINE_TOOLS.find((tool) => tool.name === name);
  if (!tool) throw new EngineError('unknown engine tool');
  if (!args || typeof args !== 'object' || Array.isArray(args))
    throw new EngineError('tool arguments must be an object');
  const properties = tool.properties as Record<
    string,
    { type: string | readonly string[]; enum?: readonly unknown[] }
  >;
  for (const required of tool.required) {
    if (!Object.hasOwn(args, required))
      throw new EngineError(`${required} is required`);
  }
  for (const [key, value] of Object.entries(args)) {
    const spec = own(properties, key);
    if (!spec) continue;
    const types = Array.isArray(spec.type) ? spec.type : [spec.type];
    const type =
      value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (
      !types.includes(type) &&
      !(types.includes('integer') && Number.isInteger(value))
    )
      throw new EngineError(`${key} has an invalid type`);
    if (spec.enum && !spec.enum.includes(value))
      throw new EngineError(`${key} has an invalid value`);
    if (typeof value === 'string' && !value.trim())
      throw new EngineError(`${key} must be a non-empty string`);
  }
}

export async function runEngineTool(
  name: string,
  args: Record<string, unknown>,
  scope: CallScope,
) {
  const owner = await assertOwner();
  validateArgs(name, args);
  if (name === 'app_runreport') {
    const host = await hostFor(scope.records);
    const result = await host
      .runReport(args.report as string | RuntimeReportSpec, {
        maxRows: args.maxRows as number | undefined,
        timeoutMs: args.timeoutMs as number | undefined,
      })
      .catch((error) => {
        const report =
          typeof args.report === 'string'
            ? own(host.def.reports, args.report)
            : { spec: args.report as RuntimeReportSpec };
        throw reportFailure(error, host.def, report);
      });
    const saved = typeof args.report === 'string' ? args.report : undefined;
    const title = saved
      ? (own(host.describe().reports, saved)?.label ?? result.title)
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
  const type = own(ENGINE_COMMAND_TYPES, name);
  if (!type) throw new Error('unknown engine tool');
  // The caller cannot override the command discriminant or supply approval.
  const host = await hostFor(scope.structure);
  await host.plan({ ...args, type } as Command);
  const description = host.describe();
  const model = own(description.models, args.model);
  const report = own(description.reports, args.name ?? args.from);
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
      summary = `Changed the link of report ${report?.label ?? report?.spec.title ?? 'you chose'}.`;
      break;
    case 'app_removereport':
      summary = `Removed the report ${report?.label ?? report?.spec.title ?? 'you chose'}`;
      break;
    case 'app_setcalculation': {
      const field = own(model?.fields, args.field);
      summary = `${args.calculated === null ? 'Cleared the calculation for' : 'Calculated'} ${field ? fieldLabel(String(args.field), field) : 'the field'}`;
      break;
    }
    case 'app_loadrecords':
      summary = `Loaded ${Array.isArray(args.rows) ? args.rows.length : 0} ${model?.label ?? 'records'}`;
      break;
    case 'app_extractmodel': {
      const field = own(model?.fields, args.field);
      summary = `Made linked records from ${field ? fieldLabel(String(args.field), field) : 'the selected field'}`;
      break;
    }
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
  if (
    name === 'app_loadrecords' &&
    'loadCounts' in result &&
    result.loadCounts
  ) {
    const counts = result.loadCounts;
    summary = `Loaded ${counts.insert + counts.update} ${model?.label ?? 'records'}: ${counts.insert} inserted, ${counts.update} updated, ${counts.unchanged} unchanged`;
  }
  return { ...result, summary: toolSummary(name, summary) };
}
