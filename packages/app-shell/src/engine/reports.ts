import {
  compileRuntimeReportSpec,
  parseRuntimeReportSpec,
  type RuntimeReportResult,
  type RuntimeReportSpec,
  runRuntimeReport,
} from '@happyvertical/smrt-reports';
import {
  type AppDefinition,
  builtInFields,
  classNameFor,
  snake,
  tableFor,
  USER_PKG,
  visible,
} from './definition.ts';

export interface ReportDef {
  label?: string;
  description?: string;
  spec: RuntimeReportSpec;
}
export interface ReportOptions {
  maxRows?: number;
  timeoutMs?: number;
}
export type AppReportResult = Omit<RuntimeReportResult, 'columns'> & {
  columns: (RuntimeReportResult['columns'][number] & {
    choices?: string[];
    reference?: string;
    labelColumn?: string;
  })[];
};

/** The same first-visible-text convention used by the shell's record labels. */
export function titleField(
  def: AppDefinition,
  model: string,
): string | undefined {
  const md = def.models[model];
  return (
    md.titleField ??
    Object.entries({ ...builtInFields(model, md), ...visible(md.fields) }).find(
      ([, f]) => f.type === 'text',
    )?.[0]
  );
}

export function reportSources(def: AppDefinition) {
  return Object.entries(def.models).map(([model, md]) => ({
    id: model,
    className: `${USER_PKG}:${classNameFor(model, md)}`,
    fields: Object.keys({ ...builtInFields(model, md), ...visible(md.fields) }),
    label: md.label ?? model,
  }));
}
export function compileReport(def: AppDefinition, input: unknown) {
  return compileRuntimeReportSpec(parseRuntimeReportSpec(input), {
    sources: reportSources(def),
    tenantId: null,
  });
}

const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
export async function runAppReport(
  def: AppDefinition,
  db: any,
  input: string | RuntimeReportSpec,
  options: ReportOptions = {},
): Promise<AppReportResult> {
  const raw = typeof input === 'string' ? def.reports?.[input]?.spec : input;
  if (!raw) throw new Error('unknown report');
  const compiled = await compileReport(def, raw);
  const result: AppReportResult = await runRuntimeReport(compiled, {
    db,
    maxRows: options.maxRows ?? 1000,
  });
  const fields = {
    ...builtInFields(compiled.spec.source, def.models[compiled.spec.source]),
    ...visible(def.models[compiled.spec.source].fields),
  };
  // At most one lookup query per linked model, for all reference dimensions.
  const lookups = new Map<string, { ids: Set<string>; columns: string[] }>();
  for (const column of result.columns) {
    const fd = column.field ? fields[column.field] : undefined;
    if (!fd) continue;
    if (fd.type === 'money' || fd.type === 'date') column.format = fd.type;
    if (fd.choices) column.choices = fd.choices;
    if (column.role !== 'dimension' || fd.type !== 'reference' || !fd.ref)
      continue;
    column.reference = fd.ref;
    let labelColumn = `${column.id}Label`;
    while (result.columns.some((c) => c.id === labelColumn))
      labelColumn += 'Label';
    column.labelColumn = labelColumn;
    const batch = lookups.get(fd.ref) ?? {
      ids: new Set<string>(),
      columns: [],
    };
    for (const row of result.rows)
      if (row[column.id] != null) batch.ids.add(String(row[column.id]));
    batch.columns.push(column.id);
    lookups.set(fd.ref, batch);
  }
  for (const [model, batch] of lookups) {
    const label = titleField(def, model);
    const ids = [...batch.ids];
    const names = new Map<string, string>();
    if (ids.length) {
      const rows = (
        await db.query(
          `SELECT id, ${label ? q(snake(label)) : 'id'} AS label FROM ${q(tableFor(model, def.models[model]))} WHERE id IN (${ids.map(() => '?').join(',')})`,
          ids,
        )
      ).rows;
      for (const row of rows)
        names.set(
          String(row.id),
          row.label == null ? String(row.id) : String(row.label),
        );
    }
    for (const id of batch.columns) {
      const column = result.columns.find((c) => c.id === id);
      if (!column?.labelColumn) continue;
      for (const row of result.rows)
        row[column.labelColumn] =
          row[id] == null
            ? null
            : (names.get(String(row[id])) ?? String(row[id]));
    }
  }
  return result;
}
