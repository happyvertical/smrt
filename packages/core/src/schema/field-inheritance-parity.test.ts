/**
 * #4940 Phase A: a differential test of field inheritance.
 *
 * "What fields does a class have, counting what it inherits" is decided in
 * more than one place (`ManifestGenerator.mergeInheritedFields()` for the
 * build step, `getAllFields()` / `getOwnTableFieldsSync()` for the registry).
 * This test runs ONE matrix of declaration shapes through both and compares
 * the effective fields, instead of waiting for someone to write the case that
 * would catch a disagreement.
 *
 * Both paths are driven from the SAME shape description:
 *
 *   - manifest path: the shape is rendered to TypeScript source, scanned by
 *     the real `OxcScanner`, converted by the real `ManifestAdapter`, then run
 *     through `ManifestGenerator.applyGenerationPasses()` (the pass sequence a
 *     build runs, including `mergeInheritedFields()`); the manifest is then
 *     registered with `ObjectRegistry.registerFromManifest()` and its table
 *     definitions read with `getAllSchemasAsDefinitions()`.
 *
 *   - registry path, "decorated": the shape is applied as real `@smrt()` /
 *     `@field()` decorators (how `getTestDatabase()` and hand-written tests
 *     reach the registry); effective fields come from
 *     `ObjectRegistry.getAllFields()`, table definitions from
 *     `getAllSchemasAsDefinitions()`.
 *
 *   - registry path, "unmerged manifest": the manifest BEFORE
 *     `mergeInheritedFields()` (each class carries only its own fields, as an
 *     older prebuilt manifest does) registered the same way, so the registry
 *     resolver does the merge. This is the only registry route that can carry
 *     a field `enum`, because `@field()` has no `enum` option (the scanner
 *     reads it off a literal-union type).
 *
 * Every result is collected first; the assertions come at the end, against
 * KNOWN_DISAGREEMENTS (kinds with counts), so one disagreement never hides another. When Phase B
 * unifies the rule that list must be empty and this file then asserts the two
 * paths agree on every shape.
 *
 * Set `FIELD_INHERITANCE_PARITY_REPORT=<file>` to write the full disagreement
 * table (markdown) for the run.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManifestAdapter, OxcScanner } from '@happyvertical/smrt-scanner';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { field, foreignKey } from '../decorators/index.js';
import { SmrtHierarchical } from '../hierarchical.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

type Strategy = 'own-table' | 'shared-table';
type Base = 'none' | 'SmrtHierarchical';
/** Where the "nearer class" of the variant sits in a three-level chain. */
type Position = 'leaf' | 'middle';

interface FieldSpec {
  kind: 'text' | 'integer' | 'foreignKey';
  required?: boolean;
  sqlType?: string | null;
  description?: string | null;
  default?: string | number | null;
  unique?: boolean;
  min?: number | null;
  max?: number | null;
  backfill?: string | null;
  minLength?: number | null;
  maxLength?: number | null;
  pattern?: string | null;
  indexed?: boolean;
  sensitive?: boolean;
  readonly?: boolean;
  readPermission?: string | null;
  bare?: boolean;
  /** A closed literal set; reaches the scanner only (no `@field` option). */
  enumValues?: string[];
}

type Fields = Record<string, FieldSpec>;

/** What the root declares. Every variant below acts on one of these. */
const ROOT_FIELDS: Fields = {
  name: { kind: 'text', required: true, unique: true, description: 'The name' },
  note: { kind: 'text', required: false, description: 'A note' },
  kind: {
    kind: 'text',
    required: false,
    description: 'Kind of thing',
    enumValues: ['a', 'b'],
  },
  amount: {
    kind: 'integer',
    required: true,
    unique: true,
    sqlType: 'REAL',
    min: 1,
    max: 99,
    default: 5,
    backfill: '5',
  },
  score: { kind: 'integer', required: false, min: 10, max: 100 },
  status: { kind: 'text', required: false, default: 'open' },
  handle: { kind: 'text', required: false, unique: true },
  owner: { kind: 'foreignKey', required: true },
  guarded: {
    kind: 'text',
    required: true,
    minLength: 2,
    maxLength: 40,
    pattern: '^[a-z]+$',
    indexed: true,
    sensitive: true,
    readonly: true,
    readPermission: 'secret:read',
  },
};

interface Variant {
  id: string;
  /** What the nearer class declares. */
  fields: Fields;
  leafFields?: Fields;
  expected?: Record<string, Partial<FieldView>>;
}

const VARIANTS: Variant[] = [
  { id: 'nothing', fields: {} },
  { id: 'tightens', fields: { note: { kind: 'text', required: true } } },
  { id: 'relaxes', fields: { name: { kind: 'text', required: false } } },
  {
    id: 'redeclares-bare',
    fields: {
      name: { kind: 'text', bare: true },
      amount: { kind: 'integer', bare: true },
    },
    expected: {
      name: { required: true, unique: true, description: 'The name' },
      amount: {
        required: true,
        unique: true,
        sqlType: 'REAL',
        default: 5,
        backfill: '5',
        min: 1,
        max: 99,
      },
    },
  },
  {
    id: 'one-option',
    fields: { name: { kind: 'text', maxLength: 20 } },
    expected: {
      name: {
        required: true,
        unique: true,
        maxLength: 20,
        description: 'The name',
      },
    },
  },
  {
    id: 'loosens',
    fields: {
      name: { kind: 'text', required: false, unique: false },
      score: { kind: 'integer', min: 0, max: 200 },
    },
    expected: {
      name: { required: false, unique: false },
      score: { min: 0, max: 200, required: false },
    },
  },
  {
    id: 'inferred-required-is-not-stated',
    fields: { score: { kind: 'integer', bare: true } },
    expected: { score: { required: false, min: 10, max: 100 } },
  },
  {
    id: 'foreignKey-required',
    fields: { owner: { kind: 'foreignKey' } },
    expected: { owner: { required: true } },
  },
  {
    id: 'null-clears',
    fields: {
      amount: { kind: 'integer', sqlType: null, default: null, backfill: null },
    },
    expected: {
      amount: {
        sqlType: undefined,
        default: undefined,
        backfill: undefined,
        required: true,
        unique: true,
        min: 1,
        max: 99,
      },
    },
  },
  {
    id: 'null-clears-bounds-and-docs',
    fields: {
      guarded: {
        kind: 'text',
        minLength: null,
        maxLength: null,
        pattern: null,
        readPermission: null,
        description: null,
      },
      score: { kind: 'integer', min: null, max: null },
    },
    expected: {
      guarded: {
        minLength: undefined,
        maxLength: undefined,
        pattern: undefined,
        readPermission: undefined,
        description: undefined,
        sensitive: true,
        readonly: true,
        indexed: true,
      },
      score: { min: undefined, max: undefined },
    },
  },
  {
    id: 'partial-chain',
    fields: { amount: { kind: 'integer', max: 200 } },
    leafFields: { amount: { kind: 'integer', min: 0 } },
    expected: {
      amount: {
        required: true,
        unique: true,
        sqlType: 'REAL',
        default: 5,
        backfill: '5',
        min: 0,
        max: 200,
      },
    },
  },
  {
    id: 'clear-chain',
    fields: {
      amount: { kind: 'integer', sqlType: null, default: null, backfill: null },
    },
    leafFields: { amount: { kind: 'integer', min: 0 } },
    expected: {
      amount: {
        sqlType: undefined,
        default: undefined,
        backfill: undefined,
        min: 0,
        required: true,
      },
    },
  },
  {
    id: 'text-type-change',
    fields: { guarded: { kind: 'integer' }, kind: { kind: 'integer' } },
    expected: {
      guarded: {
        type: 'integer',
        required: true,
        minLength: undefined,
        maxLength: undefined,
        pattern: undefined,
        sensitive: true,
        readonly: true,
        indexed: true,
        readPermission: 'secret:read',
      },
      kind: { type: 'integer', enum: undefined },
    },
  },
  {
    id: 'changes-type-over-sqlType',
    fields: { amount: { kind: 'text' } },
    expected: {
      amount: {
        type: 'text',
        required: true,
        unique: true,
        sqlType: undefined,
        min: undefined,
        max: undefined,
        enum: undefined,
        default: undefined,
        backfill: undefined,
      },
    },
  },
  { id: 'redeclares-enum-field-bare', fields: { kind: { kind: 'text' } } },
  { id: 'redeclares-described-field-bare', fields: { note: { kind: 'text' } } },
  {
    id: 'min-max-both',
    fields: { score: { kind: 'integer', required: false, min: 10, max: 200 } },
  },
  {
    id: 'changes-default',
    fields: { status: { kind: 'text', required: false, default: 'new' } },
  },
  { id: 'redeclares-unique-field-bare', fields: { handle: { kind: 'text' } } },
  { id: 'adds-field', fields: { extra: { kind: 'text' } } },
  { id: 'restates-everything', fields: ROOT_FIELDS },
];

interface Shape {
  id: string;
  strategy: Strategy;
  base: Base;
  depth: 2 | 3;
  position: Position;
  variant: Variant;
  /** Class names, root first. */
  names: string[];
  /** Table names, root first (shared-table classes use the root's). */
  tables: string[];
}

function buildShapes(): Shape[] {
  const shapes: Shape[] = [];
  let n = 0;
  for (const strategy of ['own-table', 'shared-table'] as const) {
    for (const base of ['none', 'SmrtHierarchical'] as const) {
      for (const [depth, position] of [
        [2, 'leaf'],
        [3, 'leaf'],
        [3, 'middle'],
      ] as const) {
        for (const variant of VARIANTS) {
          if (variant.leafFields && (depth !== 3 || position !== 'middle'))
            continue;
          n += 1;
          const tag = `S${String(n).padStart(3, '0')}`;
          const names = Array.from(
            { length: depth },
            (_, level) => `${tag}L${level}`,
          );
          const tables = names.map((_, level) =>
            strategy === 'shared-table'
              ? `${tag.toLowerCase()}_shared`
              : `${tag.toLowerCase()}_l${level}`,
          );
          shapes.push({
            id: [
              tag,
              strategy,
              base === 'none' ? 'plain' : 'hier',
              `depth${depth}`,
              depth === 3 ? position : 'leaf',
              variant.id,
            ].join(' '),
            strategy,
            base,
            depth,
            position: depth === 3 ? position : 'leaf',
            variant,
            names,
            tables,
          });
        }
      }
    }
  }
  return shapes;
}

/** Which declarations each level makes. */
function levelFields(shape: Shape): Fields[] {
  const levels: Fields[] = shape.names.map(() => ({}));
  levels[0] = ROOT_FIELDS;
  const nearer =
    shape.depth === 3 && shape.position === 'middle' ? 1 : shape.depth - 1;
  levels[nearer] = { ...levels[nearer], ...shape.variant.fields };
  if (shape.variant.leafFields)
    levels[shape.depth - 1] = shape.variant.leafFields;
  return levels;
}

// ---------------------------------------------------------------------------
// Rendering a shape: source text (manifest path) and decorators (registry path)
// ---------------------------------------------------------------------------

const TARGET = 'ParityTarget';
const APP = '@parity/app';
const CORE = '@happyvertical/smrt-core';

function optionBag(spec: FieldSpec): Record<string, unknown> {
  const bag: Record<string, unknown> = {};
  bag.type = spec.kind === 'integer' ? 'integer' : 'text';
  if (spec.required !== undefined) bag.required = spec.required;
  if (spec.sqlType !== undefined) bag.sqlType = spec.sqlType;
  if (spec.description !== undefined) bag.description = spec.description;
  if (spec.default !== undefined) bag.default = spec.default;
  if (spec.unique !== undefined) bag.unique = spec.unique;
  if (spec.min !== undefined) bag.min = spec.min;
  if (spec.max !== undefined) bag.max = spec.max;
  for (const key of [
    'backfill',
    'minLength',
    'maxLength',
    'pattern',
    'indexed',
    'sensitive',
    'readonly',
    'readPermission',
  ] as const) {
    if (spec[key] !== undefined) bag[key] = spec[key];
  }
  return bag;
}

function renderField(name: string, spec: FieldSpec): string {
  // No initializer: an initializer is the class's own default and counts as a
  // stated option on the build routes (#4942), which the decorator route
  // cannot see. A bare redeclaration here states nothing.
  if (spec.bare)
    return `  ${name}?: ${spec.kind === 'integer' ? 'number' : 'string'};`;
  if (spec.kind === 'foreignKey') {
    return `  @foreignKey(${TARGET}${spec.required !== undefined ? `, { required: ${spec.required} }` : ''}) ${name}: string = '';`;
  }
  const bag = JSON.stringify(optionBag(spec));
  const decorator = `@field(${bag})`;
  if (spec.kind === 'integer') return `  ${decorator} ${name}?: number;`;
  if (spec.enumValues) {
    const union = spec.enumValues.map((v) => `'${v}'`).join(' | ');
    return `  ${decorator} ${name}?: ${union};`;
  }
  return `  ${decorator} ${name}?: string;`;
}

function renderSource(shape: Shape): string {
  const levels = levelFields(shape);
  const lines = [
    `import { SmrtObject, SmrtHierarchical, smrt, field, foreignKey } from '${CORE}';`,
    `import { ${TARGET} } from './target';`,
  ];
  shape.names.forEach((name, level) => {
    const parent =
      level === 0
        ? shape.base === 'none'
          ? 'SmrtObject'
          : 'SmrtHierarchical'
        : shape.names[level - 1];
    const config =
      shape.strategy === 'shared-table'
        ? level === 0
          ? `{ tableStrategy: 'sti' }`
          : ''
        : `{ tableName: '${shape.tables[level]}' }`;
    lines.push(
      '',
      `@smrt(${config})`,
      `export class ${name} extends ${parent} {`,
    );
    for (const [fieldName, spec] of Object.entries(levels[level])) {
      lines.push(renderField(fieldName, spec));
    }
    lines.push('}');
  });
  return `${lines.join('\n')}\n`;
}

/** The decorated twin of {@link renderSource}. */
function declareTarget(): typeof SmrtObject {
  const target = class extends SmrtObject {};
  Object.defineProperty(target, 'name', { value: TARGET });
  smrt({ tableName: 'parity_targets' })(target);
  return target as typeof SmrtObject;
}

function declareDecorated(shape: Shape, target: typeof SmrtObject): void {
  const levels = levelFields(shape);
  let parent: typeof SmrtObject =
    shape.base === 'none'
      ? SmrtObject
      : (SmrtHierarchical as typeof SmrtObject);
  shape.names.forEach((name, level) => {
    const ctor = class extends parent {};
    Object.defineProperty(ctor, 'name', { value: name });
    for (const [fieldName, spec] of Object.entries(levels[level])) {
      if (spec.bare) continue; // No runtime decorator metadata for a bare field.
      if (spec.kind === 'foreignKey') {
        foreignKey(
          target,
          spec.required !== undefined ? { required: spec.required } : {},
        )(ctor.prototype, fieldName);
      } else {
        field(optionBag(spec) as never)(ctor.prototype, fieldName);
      }
    }
    smrt(
      shape.strategy === 'shared-table'
        ? level === 0
          ? { tableStrategy: 'sti' }
          : {}
        : { tableName: shape.tables[level] },
    )(ctor);
    parent = ctor as typeof SmrtObject;
  });
}

// ---------------------------------------------------------------------------
// Normalised results
// ---------------------------------------------------------------------------

interface FieldView {
  type: unknown;
  required: boolean;
  sqlType: unknown;
  enum: unknown;
  description: unknown;
  related: unknown;
  default: unknown;
  unique: unknown;
  min: unknown;
  max: unknown;
  backfill: unknown;
  minLength: unknown;
  maxLength: unknown;
  pattern: unknown;
  indexed: unknown;
  sensitive: unknown;
  readonly: unknown;
  readPermission: unknown;
}

interface ColumnView {
  type: string;
  notNull: boolean;
  default: unknown;
}

interface Observation {
  fields: Record<string, FieldView>;
  /** The leaf's table (for shared-table: the family's table). */
  columns: Record<string, ColumnView>;
}

type Bag = Record<string, unknown> & { _meta?: Record<string, unknown> };

function pick(f: Bag, key: string): unknown {
  return f[key] ?? f._meta?.[key];
}

/** System fields every table has; they are not what is being compared. */
const SYSTEM_FIELDS = new Set([
  'id',
  'slug',
  'context',
  'createdAt',
  'updatedAt',
  'created_at',
  'updated_at',
]);

function fieldView(f: Bag): FieldView {
  return {
    type: f.type,
    required: f.required === true || f._meta?.required === true,
    sqlType: pick(f, 'sqlType'),
    enum: pick(f, 'enum'),
    description: pick(f, 'description'),
    related: pick(f, 'related'),
    default: pick(f, 'default'),
    unique: pick(f, 'unique'),
    min: pick(f, 'min'),
    max: pick(f, 'max'),
    backfill: pick(f, 'backfill'),
    minLength: pick(f, 'minLength'),
    maxLength: pick(f, 'maxLength'),
    pattern: pick(f, 'pattern'),
    indexed: pick(f, 'indexed'),
    sensitive: pick(f, 'sensitive'),
    readonly: pick(f, 'readonly'),
    readPermission: pick(f, 'readPermission'),
  };
}

function fieldViews(
  entries: Iterable<[string, Bag]>,
): Record<string, FieldView> {
  const out: Record<string, FieldView> = {};
  for (const [name, f] of entries) {
    if (SYSTEM_FIELDS.has(name) || name.startsWith('_')) continue;
    out[name] = fieldView(f);
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

function columnViews(
  schema:
    | {
        columns: Record<
          string,
          { type?: unknown; notNull?: boolean; defaultValue?: unknown }
        >;
      }
    | undefined,
): Record<string, ColumnView> {
  const out: Record<string, ColumnView> = {};
  for (const [name, column] of Object.entries(schema?.columns ?? {})) {
    if (SYSTEM_FIELDS.has(name) || name.startsWith('_')) continue;
    out[name] = {
      type: String(column.type).toUpperCase(),
      notNull: column.notNull === true,
      default: column.defaultValue,
    };
  }
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}

// ---------------------------------------------------------------------------
// Running the paths
// ---------------------------------------------------------------------------

interface Observed {
  manifest: Map<string, Observation>;
  registryDecorated: Map<string, Observation>;
  registryUnmerged: Map<string, Observation>;
  errors: Map<string, string>;
}

async function scanManifest(
  shapes: Shape[],
): Promise<{ merged: SmartObjectManifest; unmerged: SmartObjectManifest }> {
  const dir = mkdtempSync(join(tmpdir(), 'smrt-4940-parity-'));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'target.ts'),
      `import { SmrtObject, smrt } from '${CORE}';\n@smrt({ tableName: 'parity_targets' })\nexport class ${TARGET} extends SmrtObject {}\n`,
    );
    for (const shape of shapes) {
      writeFileSync(join(dir, `${shape.names[0]}.ts`), renderSource(shape));
    }
    const scanner = new OxcScanner({
      cwd: dir,
      include: ['*.ts'],
      agentSurface: false,
    });
    const { resolved, results } = await scanner.scanAndResolve();
    const typeAliases = results.typeAliases;
    const build = () => {
      const manifest = new ManifestAdapter().toManifest(resolved, {
        packageName: APP,
        typeAliases,
      });
      manifest.smrtDependencies = [CORE];
      return manifest;
    };
    const unmerged = build();
    const merged = build();
    new ManifestGenerator().applyGenerationPasses(merged, {
      packageName: APP,
      packageJson: { name: APP, version: '0.0.0' },
    });
    return { merged, unmerged };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function registerManifest(manifest: SmartObjectManifest): void {
  for (const [name, obj] of Object.entries(manifest.objects)) {
    ObjectRegistry.registerFromManifest(name, obj, APP);
  }
}

async function registerCoreHierarchical(): Promise<void> {
  const { loadExternalManifestSync } = await import(
    '../manifest/manifest-loader.js'
  );
  const core = loadExternalManifestSync(CORE) as SmartObjectManifest | null;
  const entry = core?.objects?.[`${CORE}:SmrtHierarchical`];
  if (!core || !entry) {
    throw new Error('core manifest has no SmrtHierarchical entry (build core)');
  }
  ObjectRegistry.registerFromManifest(`${CORE}:SmrtHierarchical`, entry, CORE);
}

async function observeRegistry(shape: Shape): Promise<Observation> {
  const leaf = shape.names[shape.names.length - 1];
  const fields = await ObjectRegistry.getAllFields(leaf);
  const table = shape.tables[shape.tables.length - 1];
  const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
  return {
    fields: fieldViews(fields as Iterable<[string, Bag]>),
    columns: columnViews(schemas[table] as never),
  };
}

async function runAll(shapes: Shape[]): Promise<Observed> {
  const observed: Observed = {
    manifest: new Map(),
    registryDecorated: new Map(),
    registryUnmerged: new Map(),
    errors: new Map(),
  };
  const { merged, unmerged } = await scanManifest(shapes);
  const restore = snapshotObjectRegistryState();
  try {
    // Manifest path: effective fields as built, table definitions as the
    // registry reads them back from the registered manifest.
    ObjectRegistry.clear();
    await registerCoreHierarchical();
    registerManifest(merged);
    const mergedSchemas = ObjectRegistry.getAllSchemasAsDefinitions();
    for (const shape of shapes) {
      const leaf = shape.names[shape.names.length - 1];
      const table = shape.tables[shape.tables.length - 1];
      const def = merged.objects[`${APP}:${leaf}`];
      if (!def) {
        observed.errors.set(
          `${shape.id}|manifest`,
          `no manifest entry for ${leaf}`,
        );
        continue;
      }
      observed.manifest.set(shape.id, {
        fields: fieldViews(
          Object.entries(def.fields) as unknown as [string, Bag][],
        ),
        columns: columnViews(mergedSchemas[table] as never),
      });
    }

    // Registry path, decorated classes.
    ObjectRegistry.clear();
    await registerCoreHierarchical();
    const target = declareTarget();
    for (const shape of shapes) declareDecorated(shape, target);
    for (const shape of shapes) {
      try {
        observed.registryDecorated.set(shape.id, await observeRegistry(shape));
      } catch (error) {
        observed.errors.set(`${shape.id}|decorated`, String(error));
      }
    }

    // Registry path, unmerged manifest.
    ObjectRegistry.clear();
    await registerCoreHierarchical();
    registerManifest(unmerged);
    for (const shape of shapes) {
      try {
        observed.registryUnmerged.set(shape.id, await observeRegistry(shape));
      } catch (error) {
        observed.errors.set(`${shape.id}|unmerged`, String(error));
      }
    }
  } finally {
    restore();
  }
  return observed;
}

// ---------------------------------------------------------------------------
// Comparing
// ---------------------------------------------------------------------------

interface Difference {
  /** `field <name>.<attr>` or `column <name>.<attr>` or `field-set` ... */
  where: string;
  manifest: string;
  registry: string;
}

function show(value: unknown): string {
  return value === undefined ? '(absent)' : JSON.stringify(value);
}

function compare(
  left: Observation | undefined,
  right: Observation | undefined,
  ignoreAttrs: ReadonlySet<string>,
): Difference[] {
  if (!left || !right) {
    return [
      {
        where: 'observation',
        manifest: left ? 'present' : '(missing)',
        registry: right ? 'present' : '(missing)',
      },
    ];
  }
  const diffs: Difference[] = [];
  for (const [section, a, b] of [
    ['field', left.fields, right.fields],
    ['column', left.columns, right.columns],
  ] as const) {
    const names = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const name of [...names].sort()) {
      const x = (a as unknown as Record<string, Record<string, unknown>>)[name];
      const y = (b as unknown as Record<string, Record<string, unknown>>)[name];
      if (!x || !y) {
        diffs.push({
          where: `${section} ${name}`,
          manifest: x ? 'present' : '(absent)',
          registry: y ? 'present' : '(absent)',
        });
        continue;
      }
      for (const attr of new Set([...Object.keys(x), ...Object.keys(y)])) {
        if (section === 'field' && ignoreAttrs.has(attr)) continue;
        if (JSON.stringify(x[attr]) !== JSON.stringify(y[attr])) {
          diffs.push({
            where: `${section} ${name}.${attr}`,
            manifest: show(x[attr]),
            registry: show(y[attr]),
          });
        }
      }
    }
  }
  return diffs;
}

/** `@field()` has no `enum` option; only the scanner can carry one. */
const DECORATOR_CANNOT_EXPRESS = new Set(['enum']);

type Route = 'decorated' | 'unmerged';

// ---------------------------------------------------------------------------
// Known disagreements (Phase A, recorded; Phase B must empty this)
// ---------------------------------------------------------------------------

/**
 * The disagreements Phase A found, each as a KIND (route | table strategy |
 * what differs) with the number of shapes it appears on. The final assertion
 * is exact equality: a new kind, a changed count, or a listed kind that stops
 * appearing fails the suite. Phase B (#4940) decides each one and removes the
 * entries; after it this object is empty and the two paths must agree on every
 * shape. Details and the decision per kind: evidence-train/phase-a-disagreements.md.
 *
 * Routes: `decorated` = manifest path vs `@smrt()`/`@field()` classes in the
 * registry; `unmerged` = manifest path vs the registry merging an unmerged
 * manifest.
 */
const KNOWN_DISAGREEMENTS: Record<string, number> = {};

/** Differences tallied by kind: route | strategy | where. */
function tallyKinds(
  all: Shape[],
  results: Map<string, Record<Route, Difference[]>>,
): Record<string, number> {
  const tally: Record<string, number> = {};
  for (const shape of all) {
    for (const route of ['decorated', 'unmerged'] as const) {
      for (const d of results.get(shape.id)?.[route] ?? []) {
        const kind = `${route} | ${shape.strategy} | ${d.where}`;
        tally[kind] = (tally[kind] ?? 0) + 1;
      }
    }
  }
  return Object.fromEntries(
    Object.entries(tally).sort(([a], [b]) => a.localeCompare(b)),
  );
}

const shapes = buildShapes();

describe('#4940 field inheritance: manifest path vs registry path', () => {
  let observed: Observed;
  const results = new Map<string, Record<Route, Difference[]>>();

  beforeAll(async () => {
    observed = await runAll(shapes);
    for (const shape of shapes) {
      const m = observed.manifest.get(shape.id);
      results.set(shape.id, {
        decorated: compare(
          m,
          observed.registryDecorated.get(shape.id),
          DECORATOR_CANNOT_EXPRESS,
        ),
        unmerged: compare(
          m,
          observed.registryUnmerged.get(shape.id),
          new Set(),
        ),
      });
    }
    const target = process.env.FIELD_INHERITANCE_PARITY_REPORT;
    if (target) writeFileSync(target, renderReport(shapes, results, observed));
  }, 120_000);

  afterAll(() => {
    results.clear();
  });

  it('ran every shape through every path without an error', () => {
    expect(shapes.length).toBeGreaterThan(100);
    expect([...observed.errors.entries()]).toEqual([]);
    for (const shape of shapes) {
      expect(observed.manifest.has(shape.id), shape.id).toBe(true);
      expect(observed.registryDecorated.has(shape.id), shape.id).toBe(true);
      expect(observed.registryUnmerged.has(shape.id), shape.id).toBe(true);
    }
  });

  it('keeps inherited defaults and applies only stated overrides on every route', () => {
    for (const shape of shapes) {
      for (const route of [
        'manifest',
        'registryDecorated',
        'registryUnmerged',
      ] as const) {
        for (const [name, expected] of Object.entries(
          shape.variant.expected ?? {},
        )) {
          const actual = observed[route].get(shape.id)?.fields[name];
          for (const [key, value] of Object.entries(expected)) {
            if (
              route === 'registryDecorated' &&
              DECORATOR_CANNOT_EXPRESS.has(key)
            )
              continue;
            expect(
              actual?.[key as keyof FieldView],
              `${shape.id} ${route} ${name}.${key}`,
            ).toEqual(value);
          }
        }
      }
    }
  });

  it('agrees on every shape except the known disagreements', () => {
    expect(tallyKinds(shapes, results)).toEqual(
      Object.fromEntries(
        Object.entries(KNOWN_DISAGREEMENTS).sort(([x], [y]) =>
          x.localeCompare(y),
        ),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function renderReport(
  all: Shape[],
  results: Map<string, Record<Route, Difference[]>>,
  observed: Observed,
): string {
  const out: string[] = [];
  const cell = (s: string) => s.replace(/\|/g, '\\|');
  for (const route of ['decorated', 'unmerged'] as const) {
    out.push(`## Manifest path vs registry path (${route})`, '');
    out.push(
      '| shape | difference | manifest path | registry path |',
      '|---|---|---|---|',
    );
    for (const shape of all) {
      for (const d of results.get(shape.id)?.[route] ?? []) {
        out.push(
          `| ${cell(shape.id)} | ${cell(d.where)} | ${cell(d.manifest)} | ${cell(d.registry)} |`,
        );
      }
    }
    out.push('');
  }
  for (const [key, message] of observed.errors)
    out.push(`ERROR ${key}: ${message}`);
  return `${out.join('\n')}\n`;
}
