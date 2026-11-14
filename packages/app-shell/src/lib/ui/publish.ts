import { fieldLabel, humanize } from './fields.ts';
import { formulaWords } from './formula.ts';
import type { FieldDef, PublishPreview, VersionInfo } from './types.ts';

function modelLabel(model: string, preview: PublishPreview) {
  return preview.modelLabels?.[model] ?? model;
}
function fieldName(model: string, field: string, preview: PublishPreview) {
  const def = preview.fields?.[model]?.[field];
  return def ? fieldLabel(field, def) : field;
}
function fieldSubject(model: string, field: string, preview: PublishPreview) {
  return preview.fields?.[model]?.[field]
    ? `${fieldName(model, field, preview)} in ${modelLabel(model, preview)}`
    : `${model}.${field}`;
}
function renames(preview: PublishPreview) {
  return preview.fieldRenames ?? [];
}
function renameLines(preview: PublishPreview) {
  return renames(preview).map((rename) => {
    const from =
      rename.fromLabel === rename.from
        ? humanize(rename.from)
        : rename.fromLabel;
    const to =
      rename.fromLabel === rename.toLabel
        ? rename.to
        : rename.toLabel === rename.to
          ? humanize(rename.to)
          : rename.toLabel;
    return `Rename field ${from}${from === to ? '' : ` to ${to}`} in ${modelLabel(rename.model, preview)}.`;
  });
}
function renamed(
  preview: PublishPreview,
  model: string,
  field: string,
  side: 'from' | 'to',
) {
  return renames(preview).some(
    (rename) => rename.model === model && rename[side] === field,
  );
}
function rewriteRenamedOperands(
  value: unknown,
  model: string,
  preview: PublishPreview,
): unknown {
  if (Array.isArray(value))
    return value.map((item) => rewriteRenamedOperands(item, model, preview));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === 'col' && typeof item === 'string'
        ? renames(preview)
            .filter((r) => r.model === model)
            .reduce((name, r) => (name === r.from ? r.to : name), item)
        : rewriteRenamedOperands(item, model, preview),
    ]),
  );
}
function meaningfulChange(
  model: string,
  from: FieldDef,
  to: FieldDef,
  preview: PublishPreview,
) {
  return (
    JSON.stringify(rewriteRenamedOperands(from, model, preview)) !==
    JSON.stringify(to)
  );
}
/** Data-command undo journals are not removed app values; show archive decisions only. */
function archiveItems(preview: PublishPreview) {
  const steps = preview.versions.flatMap((v) => v.steps);
  if (
    !steps.some(
      (s) =>
        ['dropColumn', 'convertColumn', 'archiveTable'].includes(s.op) ||
        (s.op === 'calculation' &&
          !(s.from as FieldDef | undefined)?.calculated),
    )
  )
    return [];
  const subjects = [
    ...preview.definition.modelsRemoved.map((model) =>
      modelLabel(model, preview),
    ),
    ...Object.entries(preview.definition.models).flatMap(([model, diff]) => [
      ...diff.fieldsRemoved
        .filter((field) => !renamed(preview, model, field, 'from'))
        .map((field) => `${fieldSubject(model, field, preview)}`),
      ...diff.fieldsChanged
        .filter(
          (field) =>
            field.from.type !== field.to.type ||
            (!field.from.calculated && field.to.calculated),
        )
        .map(
          (field) =>
            `${fieldName(model, field.field, preview)} in ${modelLabel(model, preview)}`,
        ),
    ]),
  ];
  if (
    steps.some((s) =>
      ['loadRecords', 'extractModel', 'mergeRecords'].includes(s.op),
    )
  )
    subjects.push('data-command undo journals');
  return [
    ...(preview.archives.values
      ? [
          `Archived values: ${preview.archives.values}${subjects.length ? ` (${subjects.join('; ')})` : ' (original values retained for undo)'}.`,
        ]
      : []),
    ...(preview.archives.tables
      ? [
          `Archived tables: ${preview.archives.tables}${preview.definition.modelsRemoved.length ? ` (${preview.definition.modelsRemoved.map((m) => modelLabel(m, preview)).join(', ')})` : ' (removed tables retained for undo)'}.`,
        ]
      : []),
  ];
}

function fieldChange(
  model: string,
  field: string,
  from: FieldDef,
  to: FieldDef,
  preview: PublishPreview,
) {
  const fields = preview.fields?.[model] ?? { [field]: to };
  if (to.calculated)
    return `Change ${fieldSubject(model, field, preview)}: calculated as ${formulaWords(to.calculated, fields)}.`;
  if (from.calculated)
    return `Change ${fieldSubject(model, field, preview)}: remove calculation; use ${to.type} values.`;
  return `Change ${fieldSubject(model, field, preview)}: ${from.type} to ${to.type}.`;
}
function addedField(model: string, field: string, preview: PublishPreview) {
  const fields = preview.fields?.[model] ?? {};
  const calculation = fields[field]?.calculated;
  return `Add field ${fieldSubject(model, field, preview)}${calculation ? `: calculated as ${formulaWords(calculation, fields)}` : ''}.`;
}

/** Every replayed data step is counted against the current live rehearsal. */
export function publishDataLines(preview: PublishPreview): string[] {
  return preview.versions.flatMap((v) =>
    (v.dataSteps ?? []).map((step) => {
      const c = step.counts;
      const model = preview.modelLabels?.[step.model] ?? step.model;
      if (step.op === 'loadRecords')
        return `Load records into ${model} (${step.mode}): ${c.insert} inserted, ${c.update} updated, ${c.unchanged} unchanged, ${c.rejected} rejected.`;
      if (step.op === 'extractModel')
        return `Extract from ${model}: ${c.rows} records, ${c.distinct} distinct values, ${c.folded} folded, ${c.create} created, ${c.matched} matched.`;
      const references =
        Object.entries((c.references ?? {}) as Record<string, number>)
          .map(
            ([model, count]) =>
              `${count} ${count === 1 ? 'reference' : 'references'} in ${preview.modelLabels?.[model] ?? model}`,
          )
          .join(', ') || 'none';
      return `Merge ${c.removed} ${c.removed === 1 ? 'record' : 'records'} in ${model}; references repointed (${references}).`;
    }),
  );
}

/** Only calculation changes in this publish, including models and fields added. */
export function publishCalculations(preview: PublishPreview): string[] {
  const lines: string[] = [];
  for (const model of preview.definition.modelsAdded) {
    for (const [name, field] of Object.entries(preview.fields?.[model] ?? {}))
      if (field.calculated) lines.push(addedField(model, name, preview));
  }
  for (const [model, diff] of Object.entries(preview.definition.models)) {
    for (const field of diff.fieldsAdded.filter(
      (field) => !renamed(preview, model, field, 'to'),
    ))
      if (preview.fields?.[model]?.[field]?.calculated)
        lines.push(addedField(model, field, preview));
    for (const field of diff.fieldsChanged)
      if (
        JSON.stringify(
          rewriteRenamedOperands(field.from.calculated, model, preview),
        ) !== JSON.stringify(field.to.calculated)
      )
        lines.push(
          fieldChange(model, field.field, field.from, field.to, preview),
        );
  }
  return lines;
}

/** Summarise the definition and replay: intermediate conversions matter too. */
export function publishLines(preview: PublishPreview): string[] {
  const d = preview.definition;
  const added = Object.entries(d.models).reduce(
    (n, [model, diff]) =>
      n +
      diff.fieldsAdded.filter((field) => !renamed(preview, model, field, 'to'))
        .length,
    0,
  );
  const removed = Object.entries(d.models).reduce(
    (n, [model, diff]) =>
      n +
      diff.fieldsRemoved.filter(
        (field) => !renamed(preview, model, field, 'from'),
      ).length,
    0,
  );
  return [
    `Models added: ${d.modelsAdded.length}. Fields added: ${added}.`,
    `Models removed: ${d.modelsRemoved.length}. Fields removed: ${removed}.`,
    ...publishGroups(preview).flatMap((group) => [
      ...group.items,
      ...(group.note ? [group.note] : []),
    ]),
  ];
}

export interface PublishGroup {
  name: 'Added' | 'Removed' | 'Changed' | 'Archived' | 'Data';
  count: number;
  items: string[];
  note?: string;
}

/** Definition items grouped for review; intermediate conversions still matter. */
export function publishGroups(preview: PublishPreview): PublishGroup[] {
  const d = preview.definition;
  const added = [
    ...d.modelsAdded.map((name) => `Add model ${name}.`),
    ...d.recipesAdded.map((name) => `Add recipe ${name}.`),
  ];
  const removed = [
    ...d.modelsRemoved.map((name) => `Remove model ${name}.`),
    ...d.recipesRemoved.map((name) => `Remove recipe ${name}.`),
  ];
  const changed: string[] = renameLines(preview);
  for (const [name, model] of Object.entries(d.models)) {
    added.push(
      ...model.fieldsAdded
        .filter((field) => !renamed(preview, name, field, 'to'))
        .map((field) => addedField(name, field, preview)),
    );
    removed.push(
      ...model.fieldsRemoved
        .filter((field) => !renamed(preview, name, field, 'from'))
        .map((field) => `Remove field ${fieldSubject(name, field, preview)}.`),
    );
    changed.push(
      ...model.fieldsChanged
        .filter((field) =>
          meaningfulChange(name, field.from, field.to, preview),
        )
        .map((field) =>
          fieldChange(name, field.field, field.from, field.to, preview),
        ),
    );
  }
  for (const method of preview.methods) {
    if (method.change === 'added')
      added.push(`Add method ${method.model}.${method.name}().`);
    if (method.change === 'changed')
      changed.push(`Change method ${method.model}.${method.name}().`);
  }
  for (const change of preview.reportChanges ?? []) {
    (change.kind === 'added'
      ? added
      : change.kind === 'removed'
        ? removed
        : changed
    ).push(change.text);
  }
  const conversions = preview.versions
    .flatMap((v) => v.steps)
    .filter((step) => step.op === 'convertColumn').length;
  const data = publishDataLines(preview);
  return [
    {
      name: 'Data',
      count: data.length,
      items: data,
      note: 'Replayed against current live records.',
    },
    { name: 'Added', count: added.length, items: added },
    { name: 'Removed', count: removed.length, items: removed },
    {
      name: 'Changed',
      count: changed.length,
      items: changed,
      note: `Field type changes: ${conversions}.`,
    },
    {
      name: 'Archived',
      count: archiveItems(preview).length
        ? preview.archives.values + preview.archives.tables
        : 0,
      items: archiveItems(preview),
    },
  ];
}

export interface HistoryGroup {
  id: string;
  name: string | null;
  versions: VersionInfo[];
  before: number | null;
  canUndo: boolean;
}

/** Keep one publish together, regardless of the server's display ordering. */
export function groupHistory(versions: VersionInfo[]): HistoryGroup[] {
  const ordered = [...versions].sort((a, b) => a.version - b.version);
  const byVersion = new Map(ordered.map((v) => [v.version, v]));
  const applied = new Set<number>();
  let cursor = ordered.find((v) => v.current);
  while (cursor && !applied.has(cursor.version)) {
    applied.add(cursor.version);
    cursor = cursor.parent === null ? undefined : byVersion.get(cursor.parent);
  }
  const groups: HistoryGroup[] = [];
  for (const v of ordered) {
    const id = v.publish?.draftId ?? `version:${v.version}`;
    let group = groups.find((g) => g.id === id);
    if (!group) {
      group = {
        id,
        name: v.publish?.name ?? null,
        versions: [],
        before: v.parent,
        canUndo: false,
      };
      groups.push(group);
    }
    group.versions.push(v);
  }
  for (const g of groups) {
    const before = g.before;
    // undo-to also undoes later changes; never cross a cleaned-up archive
    // or offer a publish on a branch that has already been taken back.
    g.canUndo =
      before !== null &&
      applied.has(before) &&
      g.versions.every((v) => applied.has(v.version)) &&
      !ordered.some(
        (v) => v.version > before && applied.has(v.version) && v.purged,
      );
    g.versions.reverse();
  }
  return groups.reverse();
}
