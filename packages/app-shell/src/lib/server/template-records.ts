// A template with records, as the commands one change waiting holds (#5207).
//
// `importTemplate` writes a template's records straight into the copy it runs
// on, and a waiting change does not carry a copy's records to live. So the
// records travel as ordinary `loadRecords` commands after the definition, in
// the same card. `loadRecords` makes its own ids, so each model gets a
// temporary key field holding the template's id; links are resolved through it
// (`references.by`), and the field is hidden at the end, the way a workbook
// import hides its provenance. Pure: no host, no database.
import {
  builtInFields,
  type Command,
  EngineError,
  type FieldDef,
  type Template,
} from '../../engine/index.ts';

/** Rows per load (the engine caps one load at 10,000 rows and 8 MiB). */
export const TEMPLATE_LOAD_ROWS = 500;

type Row = Record<string, unknown>;
type Models = Template['definition']['models'];

const loadable = (models: Models, model: string): Record<string, FieldDef> => {
  const md = models[model];
  return {
    ...builtInFields(model, md),
    ...Object.fromEntries(
      Object.entries(md.fields ?? {}).filter(([, f]) => !f.hidden),
    ),
  };
};

/** A name no field of the model uses. */
function keyName(taken: Record<string, unknown>): string {
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'templateId' : `templateId${n}`;
    if (!Object.hasOwn(taken, name)) return name;
  }
}

/**
 * The commands for `data`: just the template itself when it has no records.
 * With records: the template (definition only, with the key fields), loads in
 * link order, a second pass for links that point forward, then the hides.
 */
export function templateCommands(data: Template): Command[] {
  const withRecords = Object.entries(data.records ?? {}).filter(
    ([model, rows]) =>
      Array.isArray(rows) &&
      rows.length > 0 &&
      Object.hasOwn(data.definition?.models ?? {}, model),
  );
  if (!withRecords.length) return [{ type: 'importTemplate', data }];
  const models = data.definition.models;
  const names = withRecords.map(([m]) => m);
  const keys = Object.fromEntries(
    names.map((m) => [m, keyName(models[m].fields ?? {})]),
  );
  const definition = structuredClone(data.definition);
  for (const m of names)
    definition.models[m].fields = {
      ...definition.models[m].fields,
      [keys[m]]: { type: 'text', label: 'Template id' },
    };
  const { records: _records, ...rest } = data;
  const commands: Command[] = [
    { type: 'importTemplate', data: { ...rest, definition } },
  ];
  // Link order: a model loads after the models it points at that carry records.
  const order: string[] = [];
  const pending = new Set(names);
  while (pending.size) {
    const next = [...pending].find((m) =>
      Object.values(loadable(models, m)).every(
        (f) =>
          f.type !== 'reference' ||
          !f.ref ||
          f.ref === m ||
          !pending.has(f.ref),
      ),
    );
    // A loop of links: take the first, its links to the rest are set later.
    const take = next ?? [...pending][0];
    order.push(take);
    pending.delete(take);
  }
  const done = new Set<string>();
  const later: { model: string; field: string }[] = [];
  const second: Command[] = [];
  for (const model of order) {
    const fields = loadable(models, model);
    const rows = (data.records?.[model] ?? []) as Row[];
    const references: Record<string, { model: string; by: string }> = {};
    const deferred = new Set<string>();
    for (const [field, fd] of Object.entries(fields)) {
      if (fd.type !== 'reference' || !fd.ref || !(fd.ref in keys)) continue;
      if (fd.ref !== model && done.has(fd.ref))
        references[field] = { model: fd.ref, by: keys[fd.ref] };
      else {
        if (fd.required)
          throw new EngineError(
            'this template links its records to each other in a loop that cannot be loaded; import it without its records',
            'refused',
          );
        deferred.add(field);
        later.push({ model, field });
      }
    }
    // A record without an id still needs a key; nothing can link to it.
    const rowKey = (row: Row, index: number): string =>
      typeof row.id === 'string' && row.id ? row.id : `row-${index}`;
    const plain = (row: Row, index: number): Row => {
      const out: Row = { [keys[model]]: rowKey(row, index) };
      for (const [field, value] of Object.entries(row)) {
        const fd = fields[field];
        if (!fd || fd.calculated || deferred.has(field)) continue;
        out[field] = value;
      }
      return out;
    };
    for (let at = 0; at < rows.length; at += TEMPLATE_LOAD_ROWS)
      commands.push({
        type: 'loadRecords',
        model,
        mode: 'insert',
        rows: rows
          .slice(at, at + TEMPLATE_LOAD_ROWS)
          .map((row, i) => plain(row, at + i)),
        ...(Object.keys(references).length ? { references } : {}),
      });
    done.add(model);
  }
  // Links that pointed forward (or at the model itself): set once everything is loaded.
  for (const model of order) {
    const fields = later.filter((l) => l.model === model).map((l) => l.field);
    if (!fields.length) continue;
    const rows = (data.records?.[model] ?? []) as Row[];
    const references = Object.fromEntries(
      fields.map((field) => [
        field,
        { model: models[model].fields[field].ref as string, by: '' },
      ]),
    );
    for (const field of fields)
      references[field].by = keys[references[field].model];
    for (let at = 0; at < rows.length; at += TEMPLATE_LOAD_ROWS)
      second.push({
        type: 'loadRecords',
        model,
        mode: 'upsert',
        key: [keys[model]],
        rows: rows.slice(at, at + TEMPLATE_LOAD_ROWS).map((row, i) => ({
          [keys[model]]:
            typeof row.id === 'string' && row.id ? row.id : `row-${at + i}`,
          ...Object.fromEntries(fields.map((f) => [f, row[f] ?? null])),
        })),
        references,
      });
  }
  commands.push(...second);
  for (const model of names)
    commands.push({ type: 'hideField', model, field: keys[model] });
  return commands;
}

/** "Import template: 3 tables, 14 records": the one line the card shows. */
export function templateSummary(data: Template): string {
  const tables = Object.keys(data.definition?.models ?? {}).length;
  const records = Object.values(data.records ?? {}).reduce(
    (n, rows) => n + (Array.isArray(rows) ? rows.length : 0),
    0,
  );
  const t = `${tables} ${tables === 1 ? 'table' : 'tables'}`;
  return records
    ? `Import template: ${t}, ${records} ${records === 1 ? 'record' : 'records'}`
    : `Import template: ${t}`;
}
