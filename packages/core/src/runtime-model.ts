/**
 * Run-time models (#4871): define a smrt model from data, with no class
 * source and no rebuild.
 *
 * A {@link RuntimeModelDefinition} becomes a manifest entry
 * ({@link runtimeModelEntry}) that `registerRuntimeModel()` registers. The
 * model then gets a table (DDL from {@link planRuntimeModelDDL}), record
 * storage and the generated REST, MCP and CLI surfaces, like a decorated
 * class. A run-time model may extend a real registered class
 * (`extends: '@pkg:Profile'`): the app-subclass rule of #4869.
 *
 * The registry only adds. Re-registering a changed definition never removes a
 * field and keeps the first exposure config, so a host that edits models
 * builds a fresh registry (a worker or process) per definition.
 *
 * @module
 */

import type { DatabaseEngine } from './migrations/types.js';
import type { SmrtObject } from './object.js';
import { registerFromManifest } from './registry/class-registration.js';
import { fieldsToColumns } from './registry/schema-builder.js';
import { ObjectRegistry } from './registry.js';
import type {
  FieldDefinition,
  MethodDefinition,
  SmartObjectDefinition,
} from './scanner/types.js';
import type { ColumnDefinition } from './schema/types.js';
import { createQualifiedName } from './utils/qualified-names.js';
import { toSnakeCase } from './utils.js';

const quoteIdentifier = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Field types a run-time model can declare. */
export type RuntimeFieldType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'json';

export interface RuntimeFieldDefinition {
  type: RuntimeFieldType;
  required?: boolean;
  /** Allowed values of a text field. */
  enum?: string[];
  description?: string;
  default?: unknown;
}

export interface RuntimeMethodDefinition {
  description?: string;
  /** Parameters of the generated tool. */
  parameters?: Array<{
    name: string;
    type: RuntimeFieldType;
    optional?: boolean;
  }>;
}

export interface RuntimeModelDefinition {
  /** Class name, PascalCase. */
  name: string;
  /** Owning package, e.g. `@local/app`. Qualified name is `<package>:<name>`. */
  packageName: string;
  fields?: Record<string, RuntimeFieldDefinition>;
  /** Methods the generated MCP tools expose. Functions are set with {@link registerRuntimeModel}. */
  methods?: Record<string, RuntimeMethodDefinition>;
  /** Table name. Defaults to the snake-case plural of `name`; a subclass of a registered class uses its parent's table. */
  tableName?: string;
  /**
   * Qualified name of a registered class this model extends, e.g.
   * `@happyvertical/smrt-profiles:Profile`. The model extends the real class
   * when it has one.
   */
  extends?: string;
  /**
   * Natural conflict key (field names). Defaults to `['id']`: run-time
   * records have no natural key, so the default (slug, context) upsert key,
   * which has no unique index behind it on these tables, would fail to save
   * untitled records and merge records that share a title.
   */
  conflictColumns?: string[];
  /** Generated REST actions. Defaults to list, get, create, update, delete. */
  api?: string[];
  /** Generated MCP actions. Defaults to the same, plus every method. */
  mcp?: string[];
}

const CRUD = ['list', 'get', 'create', 'update', 'delete'];

function pluralize(name: string): string {
  const s = toSnakeCase(name).replace(/^_/, '');
  if (s.endsWith('s')) return s;
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  return `${s}s`;
}

function toFieldDefinition(def: RuntimeFieldDefinition): FieldDefinition {
  return {
    type: def.type,
    required: def.required ?? false,
    ...(def.enum ? { enum: def.enum } : {}),
    ...(def.description ? { description: def.description } : {}),
    ...(def.default !== undefined ? { default: def.default } : {}),
  } as FieldDefinition;
}

function baseColumns(
  sti: boolean,
  idType: 'UUID' | 'TEXT',
): Record<string, ColumnDefinition> {
  return {
    // Framework-owned sync columns; deletes and sync tombstones read them.
    _sync_origin_device_id: { type: 'TEXT' },
    _sync_revision: { type: 'INTEGER' },
    id: { type: idType, primaryKey: true, notNull: true },
    slug: { type: 'TEXT', notNull: true },
    context: { type: 'TEXT', defaultValue: '' },
    created_at: {
      type: 'TIMESTAMP',
      notNull: true,
      defaultValue: 'current_timestamp',
    },
    updated_at: {
      type: 'TIMESTAMP',
      notNull: true,
      defaultValue: 'current_timestamp',
    },
    ...(sti ? { _meta_type: { type: 'TEXT', notNull: true } } : {}),
  } as Record<string, ColumnDefinition>;
}

/**
 * Turn a definition into a manifest entry: fields, columns (including the
 * `id` conflict key), and method exposure (`decoratorConfig: {}` per method
 * plus the class's `mcp.include`, so the generated tool exists).
 *
 * A model with `extends` carries no column list of its own: the registry
 * assembles the shared table from the parent and the subclass's fields, with
 * the subclass's columns nullable.
 */
export function runtimeModelEntry(
  def: RuntimeModelDefinition,
): SmartObjectDefinition {
  const qualifiedName = createQualifiedName(def.packageName, def.name);
  const parentKey = def.extends;
  const parent = parentKey ? ObjectRegistry.getClass(parentKey) : undefined;
  if (parentKey && !parent) {
    throw new Error(
      `Run-time model ${qualifiedName} extends ${parentKey}, which is not registered`,
    );
  }
  const fields: Record<string, FieldDefinition> = {};
  // A subclass of a one-table-per-class parent has a table of its own that
  // holds only its own fields, so the inherited ones are declared again on it
  // (#4869). An STI subclass shares its parent's table and needs none.
  if (parent && ObjectRegistry.getSTIBase(def.extends!) === null) {
    for (const [name, inherited] of ObjectRegistry.getFields(def.extends!)) {
      fields[name] = {
        type: inherited.type,
        required: false,
        ...(inherited.related ? { related: inherited.related } : {}),
      } as FieldDefinition;
    }
  }
  for (const [name, fd] of Object.entries(def.fields ?? {})) {
    fields[name] = toFieldDefinition(fd);
  }
  const methods: Record<string, MethodDefinition> = {};
  for (const [name, md] of Object.entries(def.methods ?? {})) {
    methods[name] = {
      name,
      async: true,
      isStatic: false,
      isPublic: true,
      returnType: 'unknown',
      description: md.description,
      decoratorConfig: {},
      parameters: (md.parameters ?? []).map((p) => ({
        name: p.name,
        type: p.type,
        optional: p.optional ?? false,
      })),
    } as unknown as MethodDefinition;
  }
  const parentSimple = parent?.name;
  // A subclass shares an STI parent's table. Any other parent's table belongs
  // to the parent alone, so the subclass gets its own.
  const sharesParentTable =
    !!parent && ObjectRegistry.getSTIBase(parentKey!) !== null;
  const tableName =
    def.tableName ??
    (sharesParentTable
      ? ObjectRegistry.getSchema(parentKey!)?.tableName
      : undefined) ??
    pluralize(def.name);
  // A subclass keeps its parent's key unless it declares one: an explicit key
  // on an STI subclass owns an extra partial unique index (#3456), and an
  // empty subclass must change nothing.
  const conflictColumns = def.conflictColumns ?? (parent ? undefined : ['id']);
  const mcp = [...CRUD, ...Object.keys(methods)];
  const decoratorConfig: Record<string, unknown> = {
    ...(sharesParentTable ? {} : { tableName }),
    ...(conflictColumns ? { conflictColumns } : {}),
    api: { include: def.api ?? CRUD },
    mcp: { include: def.mcp ?? mcp },
  };
  const entry: SmartObjectDefinition = {
    name: def.name.toLowerCase(),
    className: def.name,
    qualifiedName: qualifiedName as SmartObjectDefinition['qualifiedName'],
    packageName: def.packageName,
    collection: parent?.collection ?? tableName,
    filePath: `runtime-model:${qualifiedName}`,
    fields,
    methods,
    decoratorConfig:
      decoratorConfig as SmartObjectDefinition['decoratorConfig'],
    ...(parent
      ? { extends: parentSimple, extendsQualified: parentKey }
      : { extends: 'SmrtObject' }),
  };
  if (!sharesParentTable) {
    const columns = {
      ...baseColumns(false, 'UUID'),
      ...fieldsToColumns(new Map(Object.entries(fields))),
    };
    entry.schema = {
      tableName,
      ddl: '',
      indexes: [],
      triggers: [],
      foreignKeys: [],
      dependencies: [],
      version: '1',
      columns,
    } as unknown as SmartObjectDefinition['schema'];
  }
  return entry;
}

export interface RegisterRuntimeModelOptions {
  /**
   * Functions to set on the model's prototype, by method name. Each should
   * also be declared in `definition.methods`, so the generated MCP tool
   * exists. `this` is the record; the argument is an object of the declared
   * parameters.
   */
  methods?: Record<
    string,
    (this: SmrtObject, params?: Record<string, unknown>) => unknown
  >;
}

/**
 * Register a run-time model and return its qualified name. A model with
 * `extends` extends the real registered class and shares its simple name
 * without replacing the parent's registration.
 */
export function registerRuntimeModel(
  def: RuntimeModelDefinition,
  options: RegisterRuntimeModelOptions = {},
): string {
  const entry = runtimeModelEntry(def);
  const qualifiedName = entry.qualifiedName as string;
  registerFromManifest(qualifiedName, entry, def.packageName, {
    extendsRegistered: def.extends,
  });
  const registered = ObjectRegistry.getClass(qualifiedName);
  if (!registered) {
    throw new Error(`Run-time model ${qualifiedName} was not registered`);
  }
  const proto = (registered.constructor as unknown as { prototype: object })
    .prototype as Record<string, unknown>;
  for (const [name, fn] of Object.entries(options.methods ?? {})) {
    // The generated tools call a method with its declared parameters as
    // positional arguments; the function receives them as one object.
    const declared = (def.methods?.[name]?.parameters ?? []).map((p) => p.name);
    proto[name] = function (this: SmrtObject, ...args: unknown[]) {
      if (declared.length === 0) {
        const [first] = args;
        return fn.call(
          this,
          first && typeof first === 'object'
            ? (first as Record<string, unknown>)
            : {},
        );
      }
      return fn.call(
        this,
        Object.fromEntries(declared.map((n, i) => [n, args[i]])),
      );
    };
  }
  return qualifiedName;
}

/** Existing columns of a table, by name; `null` when the table does not exist. */
export type RuntimeTableIntrospector = (
  table: string,
) => Promise<ReadonlySet<string> | readonly string[] | null>;

/**
 * Statements that bring the database up to a registered model's table:
 * `CREATE TABLE` (and its indexes) when the table is missing, otherwise
 * `ADD COLUMN` for each column it lacks. Additive only: it never drops or
 * alters a column. The caller runs the statements (in its own transaction)
 * and supplies `existingColumns` read through that same transaction.
 */
export async function planRuntimeModelDDL(
  qualifiedName: string,
  engine: DatabaseEngine,
  existingColumns: RuntimeTableIntrospector,
): Promise<string[]> {
  const registered = ObjectRegistry.getClass(qualifiedName);
  if (!registered) {
    throw new Error(`Run-time model ${qualifiedName} is not registered`);
  }
  const table = ObjectRegistry.getTableName(qualifiedName);
  if (!table) throw new Error(`No table for ${qualifiedName}`);
  const definition = ObjectRegistry.getAllSchemasAsDefinitions()[table];
  if (!definition) throw new Error(`No schema for table ${table}`);
  const { getDDLStrategy } = await import('./schema/ddl/index.js');
  const strategy = getDDLStrategy(engine);
  const have = await existingColumns(table);
  if (!have) {
    return [
      strategy.generateCreateTable(definition),
      ...strategy.generateIndexes(definition),
    ];
  }
  const names = new Set(have);
  const statements: string[] = [];
  for (const [column, def] of Object.entries(definition.columns)) {
    if (names.has(column)) continue;
    // A column added to an existing table is nullable and without a NOT NULL
    // default requirement: existing rows have no value for it.
    const fragment = strategy.generateColumnDefinition(column, {
      ...def,
      notNull: false,
      primaryKey: false,
      unique: false,
    });
    statements.push(
      `ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${fragment}`,
    );
  }
  return statements;
}
