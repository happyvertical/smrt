import { ENGINE_COMMAND_TYPES } from '../../engine/index.ts';

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

export async function runEngineTool(
  name: string,
  args: Record<string, unknown>,
  scope: CallScope,
) {
  const owner = await assertOwner();
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
            ? host.def.reports?.[args.report]
            : { spec: args.report as RuntimeReportSpec };
        throw reportFailure(error, host.def, report);
      });
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
  const type = ENGINE_COMMAND_TYPES[name];
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
      summary = `Changed the link of report ${report?.label ?? report?.spec.title ?? 'you chose'}.`;
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
