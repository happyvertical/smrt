/** Spreadsheet adapter over replayable engine commands. No shell or UI dependencies. */
import { createHash } from 'node:crypto';
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
  snake,
  validate,
} from './definition.ts';
import { EngineError } from './errors.ts';
import type { AppHost } from './host.ts';

// Every plan key has a stable name; the persisted plan supplies the reverse map.
// Hashing avoids truncation/camel-case collisions for the 63-character SDK keys.
export const importModelName = (key: string) =>
  `Import${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
export const importFieldName = (key: string) =>
  `f${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
const SOURCE_ROW = 'importSourceRow';
const LOOKUP_KEY = 'importLookupKey';

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

function expression(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(expression);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      key === 'col' ? importFieldName(String(value)) : expression(value),
    ]),
  );
}

export interface EngineImportTarget extends ImportTarget {
  /** Hide provenance only after all loads; the owning host holds draft edits until proof. */
  seal(): Promise<void>;
}

export function createEngineImportTarget(
  host: AppHost,
  beforeCommand: () => Promise<void> = async () => {},
): EngineImportTarget {
  let plan: ImportPlan | undefined;
  let sealed = false;
  const definitions = new Map<string, Map<string, PlanField>>();
  const table = (key: string) => {
    const found = plan?.tables.find((t) => t.key === key);
    if (!found) throw new EngineImportError(key);
    return found;
  };
  const run = async (command: Parameters<AppHost['execute']>[0]) => {
    await beforeCommand();
    return host.execute(command, { author: 'workbook import' });
  };
  const target: EngineImportTarget = {
    async describe() {
      const models = host.describe().models;
      return {
        tables: Object.keys(models).map((name) => ({
          key:
            plan?.tables.find((t) => importModelName(t.key) === name)?.key ??
            name,
          fields: Object.entries(models[name].fields).map(([key, fd]) => ({
            key,
            type: fd.type,
          })),
        })),
      };
    },
    async applyStructure(input) {
      if (!host.draft)
        throw new EngineError('Workbook imports need a draft.', 'refused');
      plan = validatePlan(input);
      const existing = host.describe();
      const next: AppDefinition = {
        ...structuredClone(EMPTY_APP),
        models: {},
        reports: {},
      };
      for (const t of plan.tables) {
        const model = importModelName(t.key);
        if (
          existing.models[model] ||
          existing.models[t.key] ||
          Object.keys(existing.models).some((m) => snake(m) === t.key)
        )
          throw new EngineImportError(t.key, undefined, 'table-exists');
        const fields: Record<string, FieldDef> = {
          [SOURCE_ROW]: {
            type: 'integer',
            label: 'Workbook row',
            required: true,
          },
          [LOOKUP_KEY]: { type: 'text', label: 'Workbook lookup' },
        };
        definitions.set(t.key, new Map(t.fields.map((f) => [f.key, f])));
        for (const f of t.fields)
          fields[importFieldName(f.key)] = {
            type: f.type,
            label: f.label,
            required: f.required,
            ...(f.choices ? { choices: f.choices } : {}),
            ...(f.reference ? { ref: importModelName(f.reference.table) } : {}),
            ...(f.calculated !== undefined
              ? { calculated: expression(f.calculated) as GeneratedExpression }
              : {}),
          };
        next.models[model] = {
          label: t.label,
          fields,
          ...(t.titleField
            ? { titleField: importFieldName(t.titleField) }
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
        spec.source = importModelName(source);
        for (const member of [
          ...spec.dimensions,
          ...spec.measures,
          ...spec.filters,
        ])
          if (member.field) member.field = importFieldName(member.field);
        next.reports ??= {};
        next.reports[importFieldName(report.key)] = {
          label: report.label,
          spec,
        };
      }
      // Expressions and report shapes are preflighted before structure; the worker
      // compiles each report against its registered models before any row loads.
      for (const key of loadOrder(plan)) {
        const model = importModelName(key);
        const md = next.models[model];
        // Non-calculated fields first, so the engine can type-check every calculation.
        await run({
          type: 'defineModel',
          name: model,
          label: md.label,
          titleField: md.titleField,
          fields: Object.fromEntries(
            Object.entries(md.fields).filter(([, f]) => !f.calculated),
          ),
        });
        for (const [field, definition] of Object.entries(md.fields).filter(
          ([, f]) => !!f.calculated,
        )) {
          await run({
            type: 'addField',
            model,
            field,
            definition: { ...definition, calculated: undefined },
          });
          await run({
            type: 'setCalculation',
            model,
            field,
            calculated: definition.calculated!,
          });
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
            importFieldName(f.key),
            { model: importModelName(f.reference!.table), by: LOOKUP_KEY },
          ]),
      );
      const rows = batch.records.map((record) => {
        const values: Record<string, unknown> = {
          [SOURCE_ROW]: record.sourceRow,
          [LOOKUP_KEY]: JSON.stringify(
            (t.lookupKey ?? []).map((key) => record.values[key] ?? null),
          ),
        };
        for (const [key, value] of Object.entries(record.values))
          values[importFieldName(key)] = value;
        for (const f of t.fields.filter((f) => f.reference))
          values[importFieldName(f.key)] = record.references[f.key]
            ? JSON.stringify(record.references[f.key].key)
            : null;
        return values;
      });
      // runImport's default is 500; the engine independently checks its row/byte/journal caps.
      await run({
        type: 'loadRecords',
        model: importModelName(t.key),
        mode: 'insert',
        rows,
        references,
      });
      return { loaded: rows.length };
    },
    async seal() {
      if (sealed || !plan) return;
      for (const t of plan.tables)
        for (const field of [SOURCE_ROW, LOOKUP_KEY])
          await run({
            type: 'hideField',
            model: importModelName(t.key),
            field,
          });
      sealed = true;
    },
    async count(key) {
      table(key);
      return host.countRows(importModelName(key));
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
        importModelName(key),
        [SOURCE_ROW, ...fields.map(importFieldName)],
        SOURCE_ROW,
        sourceRows,
      );
      for (const row of rows) {
        const values: Record<string, unknown> = {};
        for (const f of fields) {
          const fd = definitions.get(key)!.get(f)!;
          const value = row[importFieldName(f)];
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
