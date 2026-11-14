import { formulaWords } from './formula.ts';
import type { FieldDef, PublishPreview, VersionInfo } from './types.ts';

function fieldChange(
  model: string,
  field: string,
  from: FieldDef,
  to: FieldDef,
  preview: PublishPreview,
) {
  const fields = preview.fields?.[model] ?? { [field]: to };
  if (to.calculated)
    return `Change ${model}.${field}: calculated as ${formulaWords(to.calculated, fields)}.`;
  if (from.calculated)
    return `Change ${model}.${field}: remove calculation; use ${to.type} values.`;
  return `Change ${model}.${field}: ${from.type} to ${to.type}.`;
}
function addedField(model: string, field: string, preview: PublishPreview) {
  const fields = preview.fields?.[model] ?? {};
  const calculation = fields[field]?.calculated;
  return `Add field ${model}.${field}${calculation ? `: calculated as ${formulaWords(calculation, fields)}` : ''}.`;
}

/** Every replayed data step is counted against the current live rehearsal. */
export function publishDataLines(preview: PublishPreview): string[] {
  return preview.versions.flatMap((v) =>
    (v.dataSteps ?? []).map((step) => {
      const c = step.counts;
      if (step.op === 'loadRecords')
        return `Load ${step.model} (${step.mode}): ${c.insert} inserted, ${c.update} updated, ${c.unchanged} unchanged, ${c.rejected} rejected.`;
      if (step.op === 'extractModel')
        return `Extract ${step.model}: ${c.rows} rows, ${c.distinct} distinct values, ${c.folded} folded, ${c.create} created, ${c.matched} matched.`;
      const references =
        Object.entries((c.references ?? {}) as Record<string, number>)
          .map(([model, count]) => `${model}: ${count}`)
          .join(', ') || 'none';
      return `Merge ${step.model}: ${c.removed} removed; references repointed (${references}).`;
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
    for (const field of diff.fieldsAdded)
      if (preview.fields?.[model]?.[field]?.calculated)
        lines.push(addedField(model, field, preview));
    for (const field of diff.fieldsChanged)
      if (
        JSON.stringify(field.from.calculated) !==
        JSON.stringify(field.to.calculated)
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
  const lines = [
    `Models added: ${d.modelsAdded.length}. Fields added: ${Object.values(d.models).reduce((n, m) => n + m.fieldsAdded.length, 0)}.`,
    ...d.modelsAdded.map((name) => `Add model ${name}.`),
    `Models removed: ${d.modelsRemoved.length}. Fields removed: ${Object.values(d.models).reduce((n, m) => n + m.fieldsRemoved.length, 0)}.`,
    ...d.modelsRemoved.map((name) => `Remove model ${name}.`),
  ];
  for (const [name, model] of Object.entries(d.models)) {
    lines.push(...model.fieldsAdded.map((f) => addedField(name, f, preview)));
    lines.push(...model.fieldsRemoved.map((f) => `Remove field ${name}.${f}.`));
    lines.push(
      ...model.fieldsChanged.map((f) =>
        fieldChange(name, f.field, f.from, f.to, preview),
      ),
    );
  }
  const conversions = preview.versions
    .flatMap((v) => v.steps)
    .filter((s) => s.op === 'convertColumn');
  lines.push(`Field type changes: ${conversions.length}.`);
  lines.push(
    `Archived values: ${preview.archives.values}. Archived tables: ${preview.archives.tables}.`,
  );
  lines.push(
    ...d.recipesAdded.map((r) => `Add recipe ${r}.`),
    ...d.recipesRemoved.map((r) => `Remove recipe ${r}.`),
  );
  lines.push(...(preview.reportChanges ?? []).map((c) => c.text));
  lines.push(...publishDataLines(preview));
  return lines;
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
  const changed: string[] = [];
  for (const [name, model] of Object.entries(d.models)) {
    added.push(
      ...model.fieldsAdded.map((field) => addedField(name, field, preview)),
    );
    removed.push(
      ...model.fieldsRemoved.map((field) => `Remove field ${name}.${field}.`),
    );
    changed.push(
      ...model.fieldsChanged.map((field) =>
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
      count: preview.archives.values + preview.archives.tables,
      items: [
        `Archived values: ${preview.archives.values}.`,
        `Archived tables: ${preview.archives.tables}.`,
      ],
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
