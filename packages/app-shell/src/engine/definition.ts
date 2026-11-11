// The user app's definition: plain, versioned JSON. The engine turns it into
// run-time smrt models (core's `registerRuntimeModel`) and table changes.
import {
  type GeneratedExpression,
  type RuntimeFieldType,
  type RuntimeModelDefinition,
  runtimeModelEntry,
} from '@happyvertical/smrt-core';

import { parseRuntimeReportSpec } from '@happyvertical/smrt-reports';
import type { ReportDef } from './reports.ts';

export const USER_PKG = '@local/app';
export const FORMAT = 1;

export type FieldType =
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'money'
  | 'choice'
  | 'reference'
  | 'json';

export interface FieldDef {
  type: FieldType;
  label?: string;
  required?: boolean;
  choices?: string[];
  /** For `reference`: the name of another model of the app. */
  ref?: string;
  hidden?: boolean;
  /** Database-owned same-row expression from core / the SQL SDK. */
  calculated?: GeneratedExpression;
}

export interface MethodParamDef {
  type: FieldType;
  required?: boolean;
}

export interface MethodDef {
  description: string;
  params?: Record<string, MethodParamDef>;
  /**
   * JavaScript body of `function ({ record, params, data, app })`. Return a
   * result; call `app.create/update/delete` to propose writes.
   */
  code: string;
}

export interface ModelDef {
  label?: string;
  titleField?: string;
  /**
   * Qualified name of a shipped model this app model extends (the app-subclass
   * rule: `Profile` extends `@happyvertical/smrt-profiles:Profile`). The
   * model's fields become nullable columns on the parent's table.
   */
  extends?: string;
  fields: Record<string, FieldDef>;
  methods?: Record<string, MethodDef>;
}

export interface AppDefinition {
  format: 1;
  name: string;
  /** Shipped SMRT packages turned on. Only `profiles` for now. */
  recipes: string[];
  models: Record<string, ModelDef>;
  reports?: Record<string, ReportDef>;
}

export const EMPTY_APP: AppDefinition = {
  format: 1,
  name: 'My app',
  recipes: [],
  models: {},
};

export interface RecipeModel {
  /** Qualified name of the shipped parent class. */
  parent: string;
  /** The parent's (shared, STI) table. */
  table: string;
  /**
   * Class name the app subclass is registered under. It cannot be `Profile`
   * yet: a second class named `Profile` makes the real package's own
   * `Person`/`Organization` subclasses lose their STI base in the registry
   * (see AGENTS.md, "Known core gap"). Flip this to the model name when core
   * resolves a parent by qualified name.
   */
  className: string;
  /** Fields the parent already has, in app terms. */
  builtIn: Record<string, FieldDef>;
}

export interface Recipe {
  /** Shipped classes whose tables are created first. */
  tables: string[];
  models: Record<string, RecipeModel>;
}

export const RECIPES: Record<string, Recipe> = {
  profiles: {
    tables: [
      '@happyvertical/smrt-profiles:ProfileType',
      '@happyvertical/smrt-profiles:Profile',
    ],
    models: {
      Profile: {
        parent: '@happyvertical/smrt-profiles:Profile',
        table: 'profiles',
        className: 'Profile',
        builtIn: {
          name: { type: 'text', required: true },
          email: { type: 'text' },
          description: { type: 'text' },
        },
      },
    },
  },
};

/** The recipe model an app model extends, if it does. */
export function recipeModelFor(
  model: string,
  md: ModelDef | undefined,
): RecipeModel | undefined {
  if (!md?.extends) return undefined;
  for (const r of Object.values(RECIPES))
    for (const [name, rm] of Object.entries(r.models))
      if (name === model && rm.parent === md.extends) return rm;
  return undefined;
}

export const MAX_CODE_LENGTH = 20_000;
export const MAX_MODELS = 100;
export const MAX_FIELDS = 200;
export const MAX_METHODS = 50;
export const MAX_PARAMS = 20;
export const MAX_CHOICES = 200;

const MODEL_NAME = /^[A-Z][A-Za-z0-9]{0,39}$/;
// camelCase without consecutive capitals, so snake-casing is unambiguous and
// matches core's `toSnakeCase` for every legal name.
const FIELD_NAME = /^[a-z][a-z0-9]{0,39}(?:[A-Z][a-z0-9]{1,39})*$/;
const RESERVED = new Set([
  'id',
  'slug',
  'context',
  'createdAt',
  'updatedAt',
  'tenantId',
  'save',
  'delete',
  'load',
  'do',
  'is',
  'describe',
  'constructor',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'typeId',
  'metaType',
]);
export const FIELD_TYPES: readonly FieldType[] = [
  'text',
  'number',
  'integer',
  'boolean',
  'date',
  'money',
  'choice',
  'reference',
  'json',
];

const TYPES = FIELD_TYPES;

/** The regular expression field and method names must match (camelCase). */
export const FIELD_NAME_PATTERN = FIELD_NAME.source;

/** A legal camelCase spelling of a rejected name, e.g. `due_date` -> `dueDate`. */
export function suggestFieldName(name: string): string | undefined {
  const words = String(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (!words.length || /^[0-9]/.test(words[0])) return undefined;
  const camel =
    words[0] +
    words
      .slice(1)
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join('');
  return FIELD_NAME.test(camel) && camel !== name ? camel : undefined;
}

export const snake = (s: string) =>
  s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

export function isValidModelName(s: string): boolean {
  return MODEL_NAME.test(s);
}
export function isValidFieldName(s: string): boolean {
  return FIELD_NAME.test(s) && !RESERVED.has(s);
}

export function tableFor(model: string, md?: ModelDef): string {
  const rm = recipeModelFor(model, md);
  if (rm) return rm.table;
  const s = snake(model).replace(/^_/, '');
  return `u_${s.endsWith('s') ? s : `${s}s`}`;
}

/** Class name a model is registered under (generated tools use it). */
export function classNameFor(model: string, md?: ModelDef): string {
  return recipeModelFor(model, md)?.className ?? model;
}

/** Route segment of the generated REST collection. */
export function routeFor(model: string, md?: ModelDef): string {
  const t = tableFor(model, md);
  return t.startsWith('u_') ? t.slice(2) : t;
}

/**
 * Whether a REST request may be served: only `/api/<route>` and
 * `/api/<route>/<id or action>` of the app's own models. Core's generated
 * handler also serves reserved endpoints (`sync/apply`, whose `delete` op
 * deletes records, `_changes`, `_events`, ...) and any shipped class it can
 * find in its registry; none of those belong to the app.
 */
export function restRouteAllowed(def: AppDefinition, rawUrl: string): boolean {
  let path: string;
  try {
    path = new URL(rawUrl, 'http://app.local').pathname;
  } catch {
    return false;
  }
  if (path !== '/api' && !path.startsWith('/api/')) return false;
  const parts = path.slice('/api'.length).split('/').filter(Boolean);
  if (parts.length < 1 || parts.length > 2) return false;
  const routes = new Set(
    Object.entries(def.models).map(([m, md]) => routeFor(m, md)),
  );
  if (!routes.has(parts[0])) return false;
  return parts.length === 1 || !parts[1].startsWith('_');
}

/** Names of the generated tools: `<class>_list`, ... and one per method. */
export function toolNamesFor(model: string, md: ModelDef): string[] {
  const cls = classNameFor(model, md).toLowerCase();
  return [
    ...['list', 'get', 'create', 'update', 'delete'],
    ...Object.keys(md.methods ?? {}),
  ].map((a) => `${cls}_${a}`);
}

/** Shipped (built-in) fields of an app model. */
export function builtInFields(
  model: string,
  md: ModelDef | undefined,
): Record<string, FieldDef> {
  return recipeModelFor(model, md)?.builtIn ?? {};
}

export function visible(fields: Record<string, FieldDef>) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, f]) => !f.hidden),
  );
}

/** Core's run-time field type and the SQLite column type it gets. */
const TYPE_MAP: Record<FieldType, [RuntimeFieldType, string]> = {
  text: ['text', 'TEXT'],
  number: ['decimal', 'REAL'],
  integer: ['integer', 'INTEGER'],
  boolean: ['boolean', 'INTEGER'],
  date: ['datetime', 'DATETIME'],
  money: ['integer', 'INTEGER'], // minor units (cents)
  choice: ['text', 'TEXT'],
  reference: ['text', 'TEXT'], // the referenced record's id
  json: ['json', 'TEXT'],
};
export const sqlType = (t: FieldType) => TYPE_MAP[t][1];
export const runtimeType = (t: FieldType) => TYPE_MAP[t][0];

/** Storage family of a declared SQLite column type, to compare columns. */
export function storageFamily(declared: string): string {
  const t = declared.toUpperCase();
  if (/DATE|TIME/.test(t)) return 'date';
  if (/INT|BOOL/.test(t)) return 'integer';
  if (/REAL|FLOA|DOUB|DEC|NUMERIC/.test(t)) return 'real';
  return 'text';
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** Check a whole definition. Returns problems; empty means valid. */
export function validate(def: unknown): string[] {
  const errs: string[] = [];
  if (!isObj(def)) return ['definition must be an object'];
  if (def.format !== FORMAT)
    return [`unknown definition format '${String(def.format)}'`];
  if (typeof def.name !== 'string' || !def.name.trim() || def.name.length > 80)
    errs.push('name must be 1 to 80 characters');
  if (
    !Array.isArray(def.recipes) ||
    def.recipes.some((r) => typeof r !== 'string')
  ) {
    errs.push('recipes must be a list of names');
    return errs;
  }
  if (!isObj(def.models)) {
    errs.push('models must be an object');
    return errs;
  }
  const d = def as unknown as AppDefinition;
  for (const r of d.recipes)
    if (!Object.hasOwn(RECIPES, r)) errs.push(`unknown recipe '${r}'`);
  const names = Object.keys(d.models);
  if (names.length > MAX_MODELS) errs.push(`at most ${MAX_MODELS} models`);
  const known = new Set(names);

  // Recipe models and the app subclasses must agree.
  for (const r of d.recipes) {
    for (const [name, rm] of Object.entries(RECIPES[r]?.models ?? {})) {
      const md = d.models[name];
      if (!md || md.extends !== rm.parent)
        errs.push(`${name}: recipe '${r}' needs the app model ${name}`);
    }
  }

  for (const [m, md] of Object.entries(d.models)) {
    if (!isObj(md) || !isObj(md.fields)) {
      errs.push(`${m}: a model needs a fields object`);
      continue;
    }
    if (!MODEL_NAME.test(m))
      errs.push(
        `${m}: model names are PascalCase (e.g. Chore): uppercase first letter, then letters and digits`,
      );
    if (md.label !== undefined && typeof md.label !== 'string')
      errs.push(`${m}: label must be text`);
    let builtIn: Record<string, FieldDef> = {};
    if (md.extends !== undefined) {
      const rm = recipeModelFor(m, md);
      if (!rm || !d.recipes.some((r) => RECIPES[r]?.models[m] === rm))
        errs.push(`${m}: cannot extend '${md.extends}'`);
      builtIn = builtInFields(m, md);
    } else if (Object.values(RECIPES).some((r) => Object.hasOwn(r.models, m))) {
      errs.push(`${m}: reserved for a recipe; enable the recipe instead`);
    }
    const fieldNames = Object.keys(md.fields);
    if (fieldNames.length > MAX_FIELDS) errs.push(`${m}: too many fields`);
    for (const [f, fd] of Object.entries(md.fields)) {
      const at = `${m}.${f}`;
      if (!FIELD_NAME.test(f)) errs.push(fieldNameProblem(at, f));
      if (RESERVED.has(f)) errs.push(`${at}: reserved name`);
      if (Object.hasOwn(builtIn, f)) errs.push(`${at}: is built in`);
      if (!isObj(fd)) {
        errs.push(`${at}: field must be an object`);
        continue;
      }
      if (!TYPES.includes(fd.type as FieldType))
        errs.push(
          `${at}: unknown type '${String(fd.type)}'; use one of ${TYPES.join(', ')}`,
        );
      if (fd.type === 'choice') {
        const c = fd.choices;
        if (
          !Array.isArray(c) ||
          !c.length ||
          c.length > MAX_CHOICES ||
          c.some((x) => typeof x !== 'string' || !x)
        )
          errs.push(`${at}: choice needs choices (a list of text)`);
      }
      if (fd.type === 'reference' && (!fd.ref || !known.has(fd.ref)))
        errs.push(
          `${at}: reference needs ref to a model of the app (have: ${names.join(', ') || 'none'})`,
        );
      if (
        fd.calculated !== undefined &&
        !['number', 'integer', 'money', 'boolean', 'text', 'date'].includes(
          fd.type,
        )
      )
        errs.push(`${at}: this type cannot be calculated`);
      if (fd.label !== undefined && typeof fd.label !== 'string')
        errs.push(`${at}: label must be text`);
    }
    if (
      md.titleField !== undefined &&
      (typeof md.titleField !== 'string' ||
        !visible({ ...builtIn, ...md.fields })[md.titleField])
    )
      errs.push(`${m}: titleField must name a visible field`);
    try {
      // The public core entry builder validates expressions without registering
      // anything in this process. Include the shipped fields for same-row refs.
      const rt = toRuntimeModel(m, { fields: { ...builtIn, ...md.fields } });
      runtimeModelEntry(rt);
    } catch (e) {
      errs.push(`${m}: ${(e as Error).message}`);
    }
    const methods = md.methods ?? {};
    if (!isObj(methods)) {
      errs.push(`${m}: methods must be an object`);
      continue;
    }
    if (Object.keys(methods).length > MAX_METHODS)
      errs.push(`${m}: too many methods`);
    for (const [name, meth] of Object.entries(methods)) {
      const at = `${m}.${name}()`;
      if (!FIELD_NAME.test(name) || RESERVED.has(name))
        errs.push(
          RESERVED.has(name)
            ? `${at}: '${name}' is a reserved name`
            : fieldNameProblem(`${m} method`, name),
        );
      if (Object.hasOwn(md.fields, name) || Object.hasOwn(builtIn, name))
        errs.push(`${at}: clashes with a field`);
      if (!isObj(meth) || typeof meth.code !== 'string') {
        errs.push(`${at}: a method needs code`);
        continue;
      }
      if (meth.code.length > MAX_CODE_LENGTH)
        errs.push(`${at}: code is longer than ${MAX_CODE_LENGTH} characters`);
      if (typeof meth.description !== 'string')
        errs.push(`${at}: a method needs a description`);
      const params = meth.params ?? {};
      if (!isObj(params) || Object.keys(params).length > MAX_PARAMS) {
        errs.push(`${at}: params must be an object of at most ${MAX_PARAMS}`);
        continue;
      }
      for (const [p, pd] of Object.entries(params)) {
        if (!FIELD_NAME.test(p)) errs.push(fieldNameProblem(`${at} param`, p));
        if (!isObj(pd) || !TYPES.includes(pd.type as FieldType))
          errs.push(
            `${at}: param '${p}' needs a type, one of ${TYPES.join(', ')}`,
          );
      }
    }
  }
  if (d.reports !== undefined) {
    if (!isObj(d.reports)) errs.push('reports must be an object');
    else
      for (const [name, report] of Object.entries(d.reports)) {
        if (!isValidFieldName(name)) errs.push(`report ${name}: invalid name`);
        try {
          if (
            !isObj(report) ||
            (report.label !== undefined && typeof report.label !== 'string') ||
            (report.description !== undefined &&
              typeof report.description !== 'string')
          )
            throw new Error('invalid report');
          const spec = parseRuntimeReportSpec(report.spec);
          const model = d.models[spec.source];
          if (!model) throw new Error('unknown source');
          const fields = {
            ...builtInFields(spec.source, model),
            ...visible(model.fields),
          };
          for (const f of [
            ...spec.dimensions,
            ...spec.measures,
            ...spec.filters,
          ])
            if (f.field && !Object.hasOwn(fields, f.field))
              throw new Error(`unknown field '${f.field}'`);
        } catch (e) {
          errs.push(`report ${name}: ${(e as Error).message}`);
        }
      }
  }
  return errs;
}

/** The message for a rejected field, method or parameter name. */
function fieldNameProblem(at: string, name: string): string {
  const hint = suggestFieldName(name);
  return `${at}: field names are camelCase (e.g. dueDate): lowercase first letter, then letters and digits, no underscores, spaces or runs of capitals${hint ? `; did you mean '${hint}'?` : ''} (got '${name}')`;
}

/** Changes that cannot be applied by only adding things. */
export function refuseChanges(
  prev: AppDefinition,
  next: AppDefinition,
  converting = new Set<string>(),
): string[] {
  const errs: string[] = [];
  for (const [m, md] of Object.entries(prev.models)) {
    const nm = next.models[m];
    if (!nm) continue;
    for (const [f, fd] of Object.entries(md.fields)) {
      const nf = nm.fields[f];
      if (
        nf &&
        sqlType(nf.type) !== sqlType(fd.type) &&
        !converting.has(`${m}.${f}`)
      )
        errs.push(
          `${m}.${f}: use changeFieldType to change ${fd.type} -> ${nf.type}`,
        );
    }
  }
  return errs;
}

/** What the app looks like to the assistant and the page. */
export function describeApp(def: AppDefinition, version: number) {
  const models: Record<string, DescribedModel> = {};
  for (const [m, md] of Object.entries(def.models)) {
    const built = builtInFields(m, md);
    models[m] = {
      kind: md.extends ? 'shipped-subclass' : 'app',
      label: md.label ?? m,
      table: tableFor(m, md),
      className: classNameFor(m, md),
      extends: md.extends ?? null,
      fields: { ...built, ...visible(md.fields) },
      ownFields: Object.keys(visible(md.fields)),
      methods: Object.fromEntries(
        Object.entries(md.methods ?? {}).map(([k, v]) => [
          k,
          { description: v.description, params: v.params ?? {} },
        ]),
      ),
    };
  }
  return {
    name: def.name,
    version,
    recipes: def.recipes,
    models,
    reports: def.reports ?? {},
  };
}

export interface DescribedModel {
  kind: 'app' | 'shipped-subclass';
  label: string;
  table: string;
  className: string;
  extends: string | null;
  fields: Record<string, FieldDef>;
  ownFields: string[];
  methods: Record<
    string,
    { description: string; params: Record<string, MethodParamDef> }
  >;
}

/** A model as core's `registerRuntimeModel` wants it (hidden fields left out). */
export function toRuntimeModel(
  model: string,
  md: ModelDef,
): RuntimeModelDefinition {
  const fields: NonNullable<RuntimeModelDefinition['fields']> = {};
  for (const [f, fd] of Object.entries(visible(md.fields))) {
    fields[f] = {
      type: runtimeType(fd.type),
      required: !!fd.required && !md.extends && !fd.calculated,
      ...(fd.calculated !== undefined ? { generated: fd.calculated } : {}),
      ...(fd.type === 'money' || fd.type === 'date'
        ? { ui: { format: fd.type === 'money' ? 'money' : 'date' } }
        : {}),
      ...(fd.type === 'choice' && fd.choices ? { enum: fd.choices } : {}),
      ...(fd.label ? { description: fd.label } : {}),
    };
  }
  const methods: NonNullable<RuntimeModelDefinition['methods']> = {};
  for (const [name, m] of Object.entries(md.methods ?? {})) {
    methods[name] = {
      description: m.description,
      parameters: Object.entries(m.params ?? {}).map(([p, pd]) => ({
        name: p,
        type: runtimeType(pd.type),
        optional: !pd.required,
      })),
    };
  }
  return {
    name: classNameFor(model, md),
    packageName: USER_PKG,
    fields,
    methods,
    ...(md.extends
      ? { extends: md.extends }
      : { tableName: tableFor(model, md) }),
  };
}

// ---------- migrations ----------

/**
 * One database step of a definition change that is not purely additive. Each
 * has an inverse, which undo runs. Additive changes (new tables and columns)
 * need no step: the app runtime adds what the definition lacks.
 */
export type Step =
  | {
      op: 'calculation';
      table: string;
      column: string;
      from?: FieldDef;
      to?: FieldDef;
    }
  | { op: 'renameColumn'; table: string; from: string; to: string }
  /** Values are archived first, so undo can put them back. */
  | {
      op: 'dropColumn';
      table: string;
      key: string;
      column: string;
      type: FieldType;
    }
  /** Original values are archived; rows that do not convert become null. */
  | {
      op: 'convertColumn';
      table: string;
      key: string;
      column: string;
      from: FieldDef;
      to: FieldDef;
    }
  /** The table is renamed out of the way, not dropped. */
  | { op: 'archiveTable'; table: string; archivedAs: string };

export interface Migration {
  steps: Step[];
  /** 'up' applies steps; 'down' undoes them in reverse order. */
  direction: 'up' | 'down';
  /** The version whose steps these are (archives are keyed by it). */
  version: number;
}

/** Convert one stored value to a field type. */
export function convertValue(
  v: unknown,
  to: FieldDef,
): { ok: boolean; value: unknown } {
  if (v === null || v === undefined || v === '')
    return { ok: true, value: null };
  const s = String(v).trim();
  switch (to.type) {
    case 'text':
    case 'reference':
      return { ok: true, value: typeof v === 'object' ? JSON.stringify(v) : s };
    case 'integer':
    case 'money': {
      const n = Number(s);
      return Number.isFinite(n)
        ? { ok: true, value: Math.round(n) }
        : { ok: false, value: null };
    }
    case 'number': {
      const n = Number(s);
      return Number.isFinite(n)
        ? { ok: true, value: n }
        : { ok: false, value: null };
    }
    case 'boolean': {
      const l = s.toLowerCase();
      if (['1', 'true', 'yes', 'y', 'done'].includes(l))
        return { ok: true, value: 1 };
      if (['0', 'false', 'no', 'n'].includes(l)) return { ok: true, value: 0 };
      return { ok: false, value: null };
    }
    case 'date': {
      const d = new Date(/^\d+$/.test(s) ? Number(s) : s);
      return Number.isNaN(d.getTime())
        ? { ok: false, value: null }
        : { ok: true, value: d.toISOString() };
    }
    case 'choice':
      return to.choices?.includes(s)
        ? { ok: true, value: s }
        : { ok: false, value: null };
    case 'json':
      try {
        return {
          ok: true,
          value: JSON.stringify(typeof v === 'string' ? JSON.parse(v) : v),
        };
      } catch {
        return { ok: false, value: null };
      }
  }
}

export type Coerced =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

/**
 * Check a value against a field and convert it for storage. Shared by record
 * writes and by the writes a method proposes, so both are held to one rule.
 * References are only checked for shape here; the runtime checks the target.
 */
export function coerceValue(fd: FieldDef, v: unknown): Coerced {
  if (fd.calculated !== undefined)
    return { ok: false, error: 'is calculated and read-only' };
  if (v === null || v === undefined) return { ok: true, value: null };
  const bad = (what: string): Coerced => ({
    ok: false,
    error: `must be ${what}`,
  });
  switch (fd.type) {
    case 'text':
      return typeof v === 'string'
        ? { ok: true, value: v }
        : typeof v === 'number' || typeof v === 'boolean'
          ? { ok: true, value: String(v) }
          : bad('text');
    case 'reference':
      return typeof v === 'string' && v
        ? { ok: true, value: v }
        : bad('a record id');
    case 'choice':
      return typeof v === 'string' && fd.choices?.includes(v)
        ? { ok: true, value: v }
        : bad(`one of ${fd.choices?.join(', ')}`);
    case 'integer':
    case 'money':
    case 'number': {
      const n =
        typeof v === 'number'
          ? v
          : typeof v === 'string' && v.trim() !== ''
            ? Number(v)
            : Number.NaN;
      if (!Number.isFinite(n)) return bad('a number');
      return { ok: true, value: fd.type === 'number' ? n : Math.round(n) };
    }
    case 'boolean':
      if (v === true || v === 'true' || v === 1)
        return { ok: true, value: true };
      if (v === false || v === 'false' || v === 0)
        return { ok: true, value: false };
      return bad('true or false');
    case 'date': {
      const d =
        v instanceof Date
          ? v
          : typeof v === 'string' || typeof v === 'number'
            ? new Date(v)
            : null;
      return d && !Number.isNaN(d.getTime())
        ? { ok: true, value: d }
        : bad('a date');
    }
    case 'json':
      return { ok: true, value: v };
    default:
      return bad('a known type');
  }
}
