// Presentation only: commands and persisted engine summaries keep their contracts.
import type { Command } from '../../engine/commands.ts';
import { fieldLabel, humanize } from './fields.ts';
import type { FieldDef } from './types.ts';

export interface SummaryDefinition {
  models: Record<string, { label?: string; fields: Record<string, FieldDef> }>;
  reports?: Record<string, { label?: string; spec?: { title?: string } }>;
}

const text = (value: unknown, fallback: string) =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback;
const count = (n: number) => `${n} ${n === 1 ? 'record' : 'records'}`;

/** Label-based heading, without record IDs, storage keys or model.field paths. */
export function commandSummary(
  input: Command | Record<string, unknown>,
  before?: SummaryDefinition,
  after?: SummaryDefinition,
  preview: Record<string, unknown> = {},
): string {
  const command = input as Record<string, unknown>;
  const key = String(command.model ?? command.name ?? '');
  const model = after?.models[key] ?? before?.models[key];
  const modelName = text(
    preview.modelLabel,
    model?.label || humanize(key) || 'records',
  );
  const field = (name: unknown, definition = before) => {
    const key = String(name ?? '');
    const def =
      definition?.models[String(command.model)]?.fields[key] ??
      before?.models[String(command.model)]?.fields[key];
    return fieldLabel(key, def ?? { type: 'text' });
  };
  const fieldName = text(
    preview.fieldLabel,
    field(command.field, after ?? before),
  );
  const report =
    after?.reports?.[String(command.name ?? command.to)] ??
    before?.reports?.[String(command.name ?? command.from)];
  const reportDef = command.definition as
    | { label?: string; spec?: { title?: string } }
    | undefined;
  const reportName =
    reportDef?.label ??
    reportDef?.spec?.title ??
    report?.label ??
    report?.spec?.title ??
    'the selected report';
  switch (command.type) {
    case 'defineModel':
      return `Add model: ${text(command.label, modelName)}`;
    case 'removeModel':
      return `Remove model: ${modelName}`;
    case 'addField': {
      const def = command.definition as FieldDef | undefined;
      return `Add field: ${def ? fieldLabel(String(command.field), def) : fieldName} in ${modelName}`;
    }
    case 'removeField':
      return `Remove field: ${fieldName} in ${modelName}`;
    case 'hideField':
      return `Hide field: ${fieldName} in ${modelName}`;
    case 'renameField': {
      const from = field(command.from);
      const to = field(command.to, after);
      return `Rename field ${from} to ${from === to ? String(command.to) : to} in ${modelName}`;
    }
    case 'changeFieldType':
      return `Change field type: ${fieldName} in ${modelName}`;
    case 'setCalculation':
      return `${command.calculated === null ? 'Remove' : 'Change'} calculation: ${fieldName} in ${modelName}`;
    case 'loadRecords':
      return `Load ${count(Array.isArray(command.rows) ? command.rows.length : Number(command.count ?? 0))} into ${modelName}`;
    case 'mergeRecords':
      return `Merge ${count(Array.isArray(command.merge) ? command.merge.length : Number(preview.removed ?? command.count ?? 0))} in ${modelName}`;
    case 'extractModel':
      return `Make linked records from ${fieldName} in ${modelName}`;
    case 'defineReport':
      return `${before?.reports?.[String(command.name)] ? 'Change' : 'Add'} report: ${reportName}`;
    case 'renameReport':
      return `Change report link: ${reportName}`;
    case 'removeReport':
      return `Remove report: ${reportName}`;
    case 'addMethod':
      return `Add code to ${modelName}`;
    case 'enableRecipe':
      return `Enable recipe: ${humanize(String(command.recipe ?? ''))}`;
    case 'importTemplate':
      return 'Import app template';
    case 'exportTemplate':
      return 'Export app template';
    case 'cleanUp':
      return 'Clean up older changes';
    case 'undoTo':
      return 'Undo changes';
    case 'undo': {
      const kinds = preview.undoKinds as
        | { kind: string; modelLabel?: string; fieldLabel?: string }[]
        | undefined;
      const step = kinds?.[0];
      if (!step) return 'Undo the latest change';
      const actions: Record<string, string> = {
        loadRecords: 'load into',
        mergeRecords: 'merge in',
        extractModel: 'linked records in',
        calculation: 'calculation in',
        convertColumn: 'field type change in',
      };
      const action = actions[step.kind] ?? 'change in';
      return `Undo: ${action} ${step.modelLabel ?? 'the selected model'}`;
    }
    default:
      return 'Change your app';
  }
}

/** Old versions store text, not commands; decode only known engine grammar. */
export function versionSummary(
  raw: string,
  before?: SummaryDefinition,
  after?: SummaryDefinition,
): string {
  const summary = raw.replace(/^\[[^\]]*\]\s*/, '');
  if (summary.startsWith('undo: ')) {
    const original = versionSummary(
      summary.slice(6).split('; skipped ')[0],
      after,
      before,
    );
    return `Undo: ${original.charAt(0).toLowerCase()}${original.slice(1)}`;
  }
  let m: RegExpMatchArray | null;
  const format = (command: Record<string, unknown>) =>
    commandSummary(command, before, after);
  m = summary.match(/^load (\d+) (\w+) records$/);
  if (m)
    return format({ type: 'loadRecords', count: Number(m[1]), model: m[2] });
  m = summary.match(/^merge (\d+) (\w+) records into /);
  if (m)
    return format({ type: 'mergeRecords', count: Number(m[1]), model: m[2] });
  m = summary.match(/^extract (\w+)\.(\w+) into (\w+)$/);
  if (m)
    return format({
      type: 'extractModel',
      model: m[1],
      field: m[2],
      into: m[3],
    });
  m = summary.match(/^set calculation (\w+)\.(\w+)$/);
  if (m)
    return format({
      type: 'setCalculation',
      model: m[1],
      field: m[2],
      calculated: after?.models[m[1]]?.fields[m[2]]?.calculated ?? null,
    });
  m = summary.match(/^rename (\w+)\.(\w+) -> (\w+)$/);
  if (m)
    return format({ type: 'renameField', model: m[1], from: m[2], to: m[3] });
  m = summary.match(/^(add|remove|hide|change) (\w+)\.(\w+)(?: .*)?$/);
  if (m)
    return format({
      type: (
        {
          add: 'addField',
          remove: 'removeField',
          hide: 'hideField',
          change: 'changeFieldType',
        } as Record<string, string>
      )[m[1]],
      model: m[2],
      field: m[3],
      definition: after?.models[m[2]]?.fields[m[3]],
    });
  m = summary.match(/^(define|remove model) (\w+)$/);
  if (m)
    return format({
      type: m[1] === 'define' ? 'defineModel' : 'removeModel',
      name: m[2],
      model: m[2],
    });
  m = summary.match(/^(define|remove) report (\w+)$/);
  if (m)
    return format({
      type: m[1] === 'define' ? 'defineReport' : 'removeReport',
      name: m[2],
    });
  m = summary.match(/^rename report (\w+) -> (\w+)$/);
  if (m) return format({ type: 'renameReport', from: m[1], to: m[2] });
  m = summary.match(/^(?:add|replace) method (\w+)\./);
  if (m) return format({ type: 'addMethod', model: m[1] });
  m = summary.match(/^enable (\w+)$/);
  if (m) return format({ type: 'enableRecipe', recipe: m[1] });
  if (summary === 'empty app') return 'New app';
  if (summary.startsWith('clean up:')) return 'Clean up older changes';
  if (summary === 'import template') return 'Import app template';
  if (summary.startsWith('undo ')) return 'Undo changes';
  if (summary.includes('published ')) return 'Publish draft';
  return 'Change your app';
}
