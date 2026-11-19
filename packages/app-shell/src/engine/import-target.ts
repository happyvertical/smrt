/** Spreadsheet adapter over replayable engine commands. No shell or UI dependencies. */
import type { GeneratedExpression } from '@happyvertical/smrt-core';
import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import {
  compensatedSum,
  type ImportPlan,
  type ImportTarget,
  type LoadBatch,
  loadOrder,
  type PlanField,
  type TargetRow,
  validatePlan,
} from '@happyvertical/smrt-spreadsheets/import';
import {
  type AppDefinition,
  EMPTY_APP,
  type FieldDef,
  validate,
} from './definition.ts';
import { EngineError } from './errors.ts';
import type { AppHost } from './host.ts';

import {
  type ImportNames,
  importNames,
  WORKBOOK_LOOKUP,
  WORKBOOK_ROW,
} from './import-names.ts';

export { importFieldName, importModelName } from './import-names.ts';

const SOURCE_ROW = WORKBOOK_ROW;
const LOOKUP_KEY = WORKBOOK_LOOKUP;

export class EngineImportError extends Error {
  constructor(
    readonly table: string,
    readonly field?: string,
    readonly reason: 'structure' | 'table-exists' = 'structure',
  ) {
    super(
      'This table or calculation cannot be represented in the app. Revise the import plan.',
    );
    this.name = 'EngineImportError';
  }
}

function expression(node: unknown, fields: Record<string, string>): unknown {
  if (Array.isArray(node))
    return node.map((child) => expression(child, fields));
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      key === 'col' ? fields[String(value)] : expression(value, fields),
    ]),
  );
}

/**
 * Where an import's engine commands go. The shell hands one in so every
 * command also becomes part of the changes waiting (a card per table); the
 * engine stays free of shell code. `table` is the plan key the command belongs
 * to (none for a report). `run` executes the command on the import's copy.
 */
export type ImportCommandHook = (input: {
  command: Parameters<AppHost['execute']>[0];
  table?: string;
  run: () => Promise<unknown>;
}) => Promise<unknown>;

export interface EngineImportTarget extends ImportTarget {
  /** Hide provenance only after all loads; the owning host holds draft edits until proof. */
  seal(): Promise<void>;
  readonly names: ImportNames;
}

export function createEngineImportTarget(
  host: AppHost,
  beforeCommand: () => Promise<void> = async () => {},
  retainNames: (names: ImportNames) => Promise<void> = async () => {},
  onCommand?: ImportCommandHook,
): EngineImportTarget {
  let plan: ImportPlan | undefined;
  let sealed = false;
  let names: ImportNames = { tables: {}, reports: {} };
  const modelName = (key: string) => names.tables[key].model;
  const fieldName = (table: string, key: string) =>
    names.tables[table].fields[key];
  const definitions = new Map<string, Map<string, PlanField>>();
  const table = (key: string) => {
    const found = plan?.tables.find((t) => t.key === key);
    if (!found) throw new EngineImportError(key);
    return found;
  };
  const run = async (
    command: Parameters<AppHost['execute']>[0],
    table?: string,
  ) => {
    await beforeCommand();
    const execute = () => host.execute(command, { author: 'workbook import' });
    return onCommand ? onCommand({ command, table, run: execute }) : execute();
  };
  const target: EngineImportTarget = {
    get names() {
      return structuredClone(names);
    },
    async describe() {
      const models = host.describe().models;
      return {
        tables: Object.keys(models).map((name) => {
          const source = Object.entries(names.tables).find(
            ([, t]) => t.model === name,
          );
          const fields = new Map(
            Object.entries(source?.[1].fields ?? {}).map(([key, engine]) => [
              engine,
              key,
            ]),
          );
          return {
            key: source?.[0] ?? name,
            fields: Object.entries(models[name].fields).map(([key, fd]) => ({
              key: fields.get(key) ?? key,
              type: fd.type,
            })),
          };
        }),
      };
    },
    async applyStructure(input) {
      if (!host.draft)
        throw new EngineError('Workbook imports need a draft.', 'refused');
      plan = validatePlan(input);
      const existing = host.def;
      names = importNames(plan, existing);
      const next: AppDefinition = {
        ...structuredClone(EMPTY_APP),
        models: {},
        reports: {},
      };
      for (const t of plan.tables) {
        const model = modelName(t.key);
        const fields: Record<string, FieldDef> = {
          [SOURCE_ROW]: {
            type: 'integer',
            label: 'Workbook row',
            required: false,
          },
          [LOOKUP_KEY]: { type: 'text', label: 'Workbook lookup' },
        };
        definitions.set(t.key, new Map(t.fields.map((f) => [f.key, f])));
        for (const f of t.fields)
          fields[fieldName(t.key, f.key)] = {
            type: f.type,
            label: f.label,
            required: f.required,
            ...(f.money ? { money: { ...f.money } } : {}),
            ...(f.choices ? { choices: f.choices } : {}),
            ...(f.reference ? { ref: modelName(f.reference.table) } : {}),
            ...(f.calculated !== undefined
              ? {
                  calculated: expression(
                    f.calculated,
                    names.tables[t.key].fields,
                  ) as GeneratedExpression,
                }
              : {}),
          };
        next.models[model] = {
          label: t.label,
          fields,
          ...(t.titleField
            ? { titleField: fieldName(t.key, t.titleField) }
            : {}),
        };
        if (
          validate({ ...EMPTY_APP, models: { ...next.models } }).some(
            (e) => !e.includes('reference needs ref'),
          )
        ) {
          // Full-graph validation below gives the same refusal for forward references.
          for (const f of t.fields.filter((f) => f.calculated !== undefined)) {
            const single = {
              ...EMPTY_APP,
              models: {
                [model]: {
                  fields: Object.fromEntries(
                    Object.entries(fields).filter(
                      ([, fd]) => fd.type !== 'reference',
                    ),
                  ),
                },
              },
            };
            if (validate(single).length)
              throw new EngineImportError(t.key, f.key);
          }
        }
      }
      const errors = validate(next);
      if (errors.length) throw new EngineImportError(plan.tables[0].key);
      for (const report of plan.reports ?? []) {
        const spec = parseRuntimeReportSpec(report.spec);
        const source = spec.source;
        spec.source = modelName(source);
        for (const member of [
          ...spec.dimensions,
          ...spec.measures,
          ...spec.filters,
        ])
          if (member.field) member.field = fieldName(source, member.field);
        next.reports ??= {};
        next.reports[names.reports[report.key]] = {
          label: report.label,
          spec,
        };
      }
      // Expressions and report shapes are preflighted before structure; the worker
      // compiles each report against its registered models before any row loads.
      await retainNames(structuredClone(names));
      for (const key of loadOrder(plan)) {
        const model = modelName(key);
        const md = next.models[model];
        // Non-calculated fields first, so the engine can type-check every calculation.
        await run(
          {
            type: 'defineModel',
            name: model,
            label: md.label,
            titleField: md.titleField,
            fields: Object.fromEntries(
              Object.entries(md.fields).filter(([, f]) => !f.calculated),
            ),
          },
          key,
        );
        for (const [field, definition] of Object.entries(md.fields).filter(
          ([, f]) => !!f.calculated,
        )) {
          await run(
            {
              type: 'addField',
              model,
              field,
              definition: { ...definition, calculated: undefined },
            },
            key,
          );
          await run(
            {
              type: 'setCalculation',
              model,
              field,
              calculated: definition.calculated!,
            },
            key,
          );
        }
      }
      for (const [name, definition] of Object.entries(next.reports ?? {}))
        await run({ type: 'defineReport', name, definition });
    },
    async load(batch: LoadBatch) {
      if (sealed) throw new EngineImportError(batch.table);
      const t = table(batch.table);
      const references = Object.fromEntries(
        t.fields
          .filter((f) => f.reference)
          .map((f) => [
            fieldName(t.key, f.key),
            { model: modelName(f.reference!.table), by: LOOKUP_KEY },
          ]),
      );
      const rows = batch.records.map((record) => {
        if (!Number.isSafeInteger(record.sourceRow) || record.sourceRow < 1)
          throw new EngineImportError(batch.table);
        const values: Record<string, unknown> = {
          [SOURCE_ROW]: record.sourceRow,
          [LOOKUP_KEY]: JSON.stringify(
            (t.lookupKey ?? []).map((key) => record.values[key] ?? null),
          ),
        };
        for (const [key, value] of Object.entries(record.values))
          values[fieldName(t.key, key)] = value;
        for (const f of t.fields.filter((f) => f.reference))
          values[fieldName(t.key, f.key)] = record.references[f.key]
            ? JSON.stringify(record.references[f.key].key)
            : null;
        return values;
      });
      // runImport's default is 500; the engine independently checks its row/byte/journal caps.
      await run(
        {
          type: 'loadRecords',
          model: modelName(t.key),
          mode: 'insert',
          rows,
          references,
        },
        t.key,
      );
      return { loaded: rows.length };
    },
    async seal() {
      if (sealed || !plan) return;
      for (const t of plan.tables)
        for (const field of [SOURCE_ROW, LOOKUP_KEY])
          await run(
            {
              type: 'hideField',
              model: modelName(t.key),
              field,
            },
            t.key,
          );
      sealed = true;
    },
    async count(key) {
      table(key);
      return host.countRows(modelName(key));
    },
    async sum(key, field) {
      const fd = definitions.get(key)?.get(field);
      if (!fd) throw new EngineImportError(key, field);
      const numbers: number[] = [];
      let exact = 0n;
      for await (const row of target.values(key, [field])) {
        const value = row.values[field];
        if (value === null || value === undefined) continue;
        if (fd.type === 'integer' || fd.type === 'money') {
          if (
            typeof value !== 'bigint' &&
            (typeof value !== 'number' || !Number.isSafeInteger(value))
          )
            return Number.NaN;
          exact += BigInt(value as number | bigint);
        } else numbers.push(Number(value));
      }
      return fd.type === 'integer' || fd.type === 'money'
        ? exact <= BigInt(Number.MAX_SAFE_INTEGER) &&
          exact >= BigInt(Number.MIN_SAFE_INTEGER)
          ? Number(exact)
          : exact
        : compensatedSum(numbers);
    },
    async *values(key, fields, sourceRows): AsyncIterable<TargetRow> {
      table(key);
      for (const field of fields)
        if (!definitions.get(key)?.has(field))
          throw new EngineImportError(key, field);
      const rows = await host.readStoredRows(
        modelName(key),
        [SOURCE_ROW, ...fields.map((field) => fieldName(key, field))],
        SOURCE_ROW,
        sourceRows,
      );
      for (const row of rows) {
        // Owner-created records have no corresponding workbook row.
        if (row[SOURCE_ROW] == null) continue;
        const values: Record<string, unknown> = {};
        for (const f of fields) {
          const fd = definitions.get(key)!.get(f)!;
          const value = row[fieldName(key, f)];
          values[f] =
            fd.type === 'boolean' && value !== null
              ? Boolean(value)
              : fd.type === 'date' && typeof value === 'string'
                ? value.slice(0, 10)
                : value;
        }
        yield { sourceRow: Number(row[SOURCE_ROW]), values };
      }
    },
  };
  return target;
}
