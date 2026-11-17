import {
  WORKBOOK_LOOKUP,
  WORKBOOK_ROW,
} from '../../engine/import-bookkeeping.ts';
import { versionSummary } from './command-summary.ts';
import { fieldLabel, humanize } from './fields.ts';
import { formulaWords } from './formula.ts';
import type { FieldDef, PublishPreview, VersionInfo } from './types.ts';

export function publishModelLabel(model: string, preview: PublishPreview) {
  return preview.modelLabels?.[model]?.trim() || humanize(model);
}
const modelLabel = publishModelLabel;

export function publishMethodLabel(
  method: PublishPreview['methods'][number],
  preview: PublishPreview,
) {
  return `${humanize(method.name)} in ${modelLabel(method.model, preview)}`;
}

/** Old previews without a saved heading still pass through the common formatter. */
export function publishVersionSummary(
  version: PublishPreview['versions'][number],
  preview: PublishPreview,
) {
  if (version.humanSummary) return version.humanSummary;
  const names = new Set([
    ...Object.keys(preview.fields ?? {}),
    ...Object.keys(preview.modelLabels ?? {}),
  ]);
  const definition = {
    models: Object.fromEntries(
      [...names].map((name) => [
        name,
        {
          label: modelLabel(name, preview),
          fields: preview.fields?.[name] ?? {},
        },
      ]),
    ),
  };
  return versionSummary(version.summary, definition, definition);
}
function fieldName(model: string, field: string, preview: PublishPreview) {
  const def = preview.fields?.[model]?.[field];
  return fieldLabel(
    field,
    def ??
      preview.definition.models[model]?.fieldsChanged.find(
        (change) => change.field === field,
      )?.to ?? { type: 'text' },
  );
}
function fieldSubject(model: string, field: string, preview: PublishPreview) {
  return `${fieldName(model, field, preview)} in ${modelLabel(model, preview)}`;
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
/** Saved undo history is not removed app values; show archive decisions only. */
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
  const savedHistory = steps.some((s) =>
    ['loadRecords', 'extractModel', 'mergeRecords'].includes(s.op),
  );
  // Loading data saves undo history, which is not a decision to archive anything.
  if (savedHistory && !subjects.length) return [];
  if (savedHistory) subjects.push('undo history saved');
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

function dataLine(
  step: NonNullable<PublishPreview['versions'][number]['dataSteps']>[number],
  preview: PublishPreview,
) {
  const c = step.counts;
  const model = modelLabel(step.model, preview);
  if (step.op === 'loadRecords')
    return `Load records into ${model} (${step.mode}): ${c.insert} inserted, ${c.update} updated, ${c.unchanged} unchanged, ${c.rejected} rejected.`;
  if (step.op === 'extractModel')
    return `Extract from ${model}: ${c.rows} records, ${c.distinct} distinct values, ${c.folded} folded, ${c.create} created, ${c.matched} matched.`;
  const references =
    Object.entries((c.references ?? {}) as Record<string, number>)
      .map(
        ([model, count]) =>
          `${count} ${count === 1 ? 'reference' : 'references'} in ${modelLabel(model, preview)}`,
      )
      .join(', ') || 'none';
  return `Merge ${c.removed} ${c.removed === 1 ? 'record' : 'records'} in ${model}; references repointed (${references}).`;
}

/** Every replayed data step is counted against the current live rehearsal. */
export function publishDataLines(preview: PublishPreview): string[] {
  return preview.versions.flatMap((v) =>
    (v.dataSteps ?? []).map((step) => dataLine(step, preview)),
  );
}

/** Data steps other than record loads (those get a table of their own). */
export function publishOtherDataLines(preview: PublishPreview): string[] {
  return preview.versions.flatMap((v) =>
    (v.dataSteps ?? [])
      .filter((step) => step.op !== 'loadRecords')
      .map((step) => dataLine(step, preview)),
  );
}

export interface PublishDataTable {
  model: string;
  label: string;
  inserted: number;
  /** "12 records added", plus any non-zero other counts. */
  sentence: string;
  columns: { key: string; label: string; field: FieldDef }[];
  /** Tables the link columns point to, to label their cells. */
  links: { model: string; fields: Record<string, FieldDef> }[];
}

const num = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;
const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** One entry per table that records are loaded into; zero parts are left out. */
export function publishDataTables(preview: PublishPreview): PublishDataTable[] {
  const totals = new Map<
    string,
    { insert: number; update: number; unchanged: number; rejected: number }
  >();
  for (const version of preview.versions)
    for (const step of version.dataSteps ?? []) {
      if (step.op !== 'loadRecords') continue;
      const t = totals.get(step.model) ?? {
        insert: 0,
        update: 0,
        unchanged: 0,
        rejected: 0,
      };
      t.insert += num(step.counts.insert);
      t.update += num(step.counts.update);
      t.unchanged += num(step.counts.unchanged);
      t.rejected += num(step.counts.rejected);
      totals.set(step.model, t);
    }
  return [...totals].map(([model, t]) => {
    const parts = [
      ...(t.insert || (!t.update && !t.unchanged && !t.rejected)
        ? [`${plural(t.insert, 'record', 'records')} added`]
        : []),
      ...(t.update ? [`${t.update} updated`] : []),
      ...(t.unchanged ? [`${t.unchanged} unchanged`] : []),
      ...(t.rejected ? [`${t.rejected} skipped`] : []),
    ];
    return {
      model,
      label: modelLabel(model, preview),
      inserted: t.insert,
      sentence: parts.join(', '),
      columns: Object.entries(preview.fields?.[model] ?? {})
        .filter(
          ([key, field]) =>
            !field.hidden && key !== WORKBOOK_ROW && key !== WORKBOOK_LOOKUP,
        )
        .map(([key, field]) => ({
          key,
          label: fieldLabel(key, field),
          field,
        })),
      links: [
        ...new Set(
          Object.values(preview.fields?.[model] ?? {})
            .filter((f) => f.type === 'reference' && f.ref)
            .map((f) => f.ref as string),
        ),
      ].map((ref) => ({ model: ref, fields: preview.fields?.[ref] ?? {} })),
    };
  });
}

/** Bookkeeping the importer adds to every table; owners never decide on it. */
export function isPlumbingSummary(text: string): boolean {
  return /^Hide field: Workbook (row|lookup) in /i.test(text.trim());
}

/** Ordered changes with importer bookkeeping removed. */
export function publishChanges(preview: PublishPreview) {
  return preview.versions
    .map((version) => ({
      version: version.version,
      text: publishVersionSummary(version, preview),
    }))
    .filter((change) => !isPlumbingSummary(change.text));
}

/** The non-empty definition groups; zero-count groups are not shown. */
export function publishSummaryGroups(preview: PublishPreview): PublishGroup[] {
  return publishGroups(preview).filter(
    (group) => group.name !== 'Data' && group.items.length > 0,
  );
}

/** One line for everything that does not change; null when nothing is hidden. */
export function publishQuietLine(preview: PublishPreview): string | null {
  const shown = new Set(publishSummaryGroups(preview).map((g) => g.name));
  const words: [PublishGroup['name'], string][] = [
    ['Added', 'added'],
    ['Removed', 'removed'],
    ['Changed', 'changed'],
    ['Archived', 'archived'],
  ];
  const quiet = words.filter(([name]) => !shown.has(name)).map(([, w]) => w);
  if (!quiet.length) return null;
  if (shown.size === 0)
    return publishDataLines(preview).length
      ? 'No other changes.'
      : 'No changes to publish.';
  const last = quiet.pop();
  return `Nothing ${quiet.length ? `${quiet.join(', ')} or ${last}` : last}.`;
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
    ...d.modelsAdded.map((name) => `Add model ${modelLabel(name, preview)}.`),
    ...d.recipesAdded.map((name) => `Add recipe ${humanize(name)}.`),
  ];
  const removed = [
    ...d.modelsRemoved.map(
      (name) => `Remove model ${modelLabel(name, preview)}.`,
    ),
    ...d.recipesRemoved.map((name) => `Remove recipe ${humanize(name)}.`),
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
      added.push(`Add method ${publishMethodLabel(method, preview)}.`);
    if (method.change === 'changed')
      changed.push(`Change method ${publishMethodLabel(method, preview)}.`);
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

export interface HistoryEntry {
  group: HistoryGroup;
  title: string;
  /** Each change of the entry, oldest first, importer bookkeeping removed. */
  changes: string[];
  /** The newest version of the entry, which dates it. */
  newest: VersionInfo;
  current: boolean;
  purged: boolean;
}

/**
 * One entry per publish. Importer bookkeeping (the rule the review page
 * uses) is left out; an entry that is only bookkeeping is dropped unless it
 * is the current state, so it can still be undone.
 */
export function historyEntries(groups: HistoryGroup[]): HistoryEntry[] {
  return groups.flatMap((group) => {
    // Versions run newest first inside a group.
    const newest = group.versions[0];
    if (!newest) return [];
    const changes = [...group.versions]
      .reverse()
      .map((v) => v.humanSummary || 'Change to your app')
      .filter((text) => !isPlumbingSummary(text));
    const current = group.versions.some((v) => v.current);
    if (!changes.length && !current) return [];
    return [
      {
        group,
        title: group.name || changes[0] || 'Change to your app',
        changes,
        newest,
        current,
        purged: group.versions.some((v) => v.purged),
      },
    ];
  });
}
