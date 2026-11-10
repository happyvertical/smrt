import type { PublishPreview, VersionInfo } from './types.ts';

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
    lines.push(...model.fieldsAdded.map((f) => `Add field ${name}.${f}.`));
    lines.push(...model.fieldsRemoved.map((f) => `Remove field ${name}.${f}.`));
    lines.push(
      ...model.fieldsChanged.map(
        (f) => `Change ${name}.${f.field}: ${f.from.type} to ${f.to.type}.`,
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
  return lines;
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
