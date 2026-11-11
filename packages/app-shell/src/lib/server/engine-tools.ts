// Engine-only additions to the existing owner-only shell catalog. Keep these
// server-side: no assistant policy or UI contract is introduced here.
import type { RuntimeReportSpec } from '@happyvertical/smrt-reports';
import type { Command } from '../../engine/index.ts';
import { runCommand } from './builder.ts';
import { hostFor } from './host.ts';
import { assertOwner } from './owner.ts';
import type { CallScope } from './target.ts';

const string = { type: 'string' };
const object = { type: 'object' };
export const ENGINE_TOOLS = [
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
    return host.runReport(args.report as string | RuntimeReportSpec, {
      maxRows: args.maxRows as number | undefined,
      timeoutMs: args.timeoutMs as number | undefined,
    });
  }
  const types: Record<string, Command['type']> = {
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
  return runCommand({ ...args, type } as Command, owner.id, scope.structure);
}
