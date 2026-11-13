import {
  type GeneratedExpression,
  GeneratedFieldError,
  generatedExpression,
  validateGeneratedFields,
} from './generated-fields.js';
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
 * Explicit refresh/replacement supports the versioned app model editor.
 * Storage is additive; migrations and host publication remain separate.
 *
 * @module
 */

import type { DatabaseEngine } from './migrations/types.js';
import type { SmrtObject } from './object.js';
import {
  ensureTenantScopedField,
  normalizeTenantScopedConfig,
  registerFromManifest,
} from './registry/class-registration.js';
import {
  getEffectiveFieldsSync,
  getOwnTableFieldsSync,
  inheritsHierarchicalBase,
} from './registry/inheritance-resolver.js';
import { fieldsToColumns } from './registry/schema-builder.js';
import type { RegisteredField, SmartObjectConfig } from './registry/types.js';
import { ObjectRegistry } from './registry.js';
import type {
  FieldDefinition,
  FieldUIHints,
  MethodDefinition,
  SmartObjectDefinition,
} from './scanner/types.js';
import type { ColumnDefinition } from './schema/types.js';
import {
  displayLabelFieldProblem,
  FIELD_UI_FORMAT_TYPES,
  FIELD_UI_WIDGET_TYPES,
  isFieldUIFormat,
  isFieldUIWidget,
  resolveDisplayLabelField,
  resolveDisplayLabelProjection,
} from './ui-metadata.js';
import {
  createQualifiedName,
  isQualifiedName,
  parseQualifiedName,
} from './utils/qualified-names.js';
import { toSnakeCase } from './utils.js';

const quoteIdentifier = (id: string) => `"${id.replace(/"/g, '""')}"`;

/** Field types a run-time model can declare. */
export type RuntimeFieldType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'datetime'
  | 'json'
  | 'foreignKey'
  | 'crossPackageRef';

export interface RuntimeFieldDefinition {
  type: RuntimeFieldType;
  generated?: GeneratedExpression;
  sensitive?: boolean;
  readPermission?: string;
  required?: boolean;
  /** Allowed values of a text field. */
  enum?: string[];
  description?: string;
  default?: unknown;
  /** Qualified target model for a reference, as on manifest fields. */
  related?: string;
  /** The same presentation hints as @field({ ui }). No storage/security effect. */
  ui?: FieldUIHints;
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
  /** Explicit same-name app replacement, sharing its effective parent's table. */
  replaces?: boolean;
  tenantScoped?: SmartObjectConfig['tenantScoped'];
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
  /** Presentation metadata, using the normal model/manifest contract. */
  ui?: SmartObjectConfig['ui'];
  display?: SmartObjectConfig['display'];
}

/**
 * The TypeScript type name the generated tool schema and argument coercion
 * read, for a run-time field type (they know `number`, not `integer`).
 */
const WIRE_TYPE: Record<RuntimeFieldType, string> = {
  text: 'string',
  integer: 'number',
  decimal: 'number',
  boolean: 'boolean',
  datetime: 'string',
  json: 'object',
  foreignKey: 'string',
  crossPackageRef: 'string',
};

const CRUD = ['list', 'get', 'create', 'update', 'delete'];

function pluralize(name: string): string {
  const s = toSnakeCase(name).replace(/^_/, '');
  if (s.endsWith('s')) return s;
  if (/[^aeiou]y$/.test(s)) return `${s.slice(0, -1)}ies`;
  return `${s}s`;
}

function toFieldDefinition(def: RuntimeFieldDefinition): FieldDefinition {
  if (
    (def.type === 'foreignKey' || def.type === 'crossPackageRef') &&
    (typeof def.related !== 'string' || !isQualifiedName(def.related))
  ) {
    throw new Error(
      `Run-time ${def.type} field requires a qualified related model`,
    );
  }
  if (def.generated !== undefined && def.default !== undefined)
    throw new GeneratedFieldError('Generated fields cannot declare a default');
  const widget = def.ui?.widget;
  if (
    widget !== undefined &&
    (!isFieldUIWidget(widget) ||
      !FIELD_UI_WIDGET_TYPES[widget].includes(def.type))
  ) {
    throw new Error(`Invalid ui.widget ${String(widget)} for ${def.type}`);
  }
  const format = def.ui?.format;
  if (
    format !== undefined &&
    (!isFieldUIFormat(format) ||
      !FIELD_UI_FORMAT_TYPES[format].includes(def.type))
  ) {
    throw new Error(`Invalid ui.format ${String(format)} for ${def.type}`);
  }
  return {
    type: def.type,
    ...(def.generated !== undefined ? { generated: def.generated } : {}),
    ...(def.sensitive !== undefined ? { sensitive: def.sensitive } : {}),
    ...(def.readPermission ? { readPermission: def.readPermission } : {}),
    required: def.required ?? false,
    ...(def.enum ? { enum: [...def.enum] } : {}),
    ...(def.description ? { description: def.description } : {}),
    ...(def.default !== undefined ? { default: def.default } : {}),
    ...(def.related ? { related: def.related } : {}),
    ...(def.ui ? { _meta: { ui: { ...def.ui } } } : {}),
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
  if (
    def.replaces &&
    (!parent ||
      parent.name !== def.name ||
      (parent.packageName === def.packageName &&
        parent.qualifiedName !== qualifiedName))
  ) {
    throw new Error(
      'Runtime replacement requires a registered same-name upstream model',
    );
  }
  const parentTable = parentKey
    ? ObjectRegistry.getTableName(parentKey)
    : undefined;
  const parentSchema =
    def.replaces && parentTable
      ? ObjectRegistry.getAllSchemasAsDefinitions({ tables: [parentTable] })[
          parentTable
        ]
      : undefined;
  const fields: Record<string, FieldDefinition> = {};
  // Keep ordinary STI fields on their declaring class, as before #4915.
  // Copy only generated metadata needed by output/write consumers; validation
  // below resolves dependencies from the complete effective parent ancestry.
  if (parent) {
    const sharedTable = ObjectRegistry.getSTIBase(parentKey!) !== null;
    const inheritedFields =
      sharedTable && !def.replaces
        ? getEffectiveFieldsSync(parent)
        : getOwnTableFieldsSync(parent);
    const hierarchical =
      !def.replaces && !sharedTable && inheritsHierarchicalBase(parent);
    for (const [name, inherited] of inheritedFields) {
      if (
        sharedTable &&
        !def.replaces &&
        generatedExpression(inherited) === undefined
      )
        continue;

      const related =
        name === 'parentId' && hierarchical && inherited.related === parent.name
          ? def.name
          : inherited.related;
      fields[name] = {
        ...inherited,
        type: inherited.type,
        required:
          def.replaces || sharedTable
            ? (inherited.required ?? inherited._meta?.required ?? false)
            : false,
        ...(related ? { related } : {}),
        ...(inherited._meta
          ? {
              _meta: {
                ...inherited._meta,
                ...(inherited._meta.ui
                  ? { ui: { ...inherited._meta.ui } }
                  : {}),
              },
            }
          : {}),
      } as FieldDefinition;
    }
  }
  for (const [name, fd] of Object.entries(def.fields ?? {})) {
    fields[name] = toFieldDefinition(fd);
    if (
      fd.type === 'foreignKey' &&
      fd.related &&
      parseQualifiedName(fd.related).packageName !== def.packageName
    ) {
      throw new Error(
        `Run-time field ${name}: use crossPackageRef across packages`,
      );
    }
  }
  const tenantScoped = def.tenantScoped ?? parent?.config.tenantScoped;
  const scopedFields = new Map<string, RegisteredField>(
    Object.entries(fields).map(([name, field]) => [name, { ...field }]),
  );
  ensureTenantScopedField(
    scopedFields,
    normalizeTenantScopedConfig(tenantScoped),
  );
  Object.assign(fields, Object.fromEntries(scopedFields));
  validateGeneratedFields(
    new Map([
      ...(parent ? getEffectiveFieldsSync(parent) : []),
      ...Object.entries(fields),
    ]),
  );
  const methods: Record<string, MethodDefinition> =
    def.replaces && parent ? Object.fromEntries(parent.methods) : {};
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
        type: WIRE_TYPE[p.type] ?? 'string',
        optional: p.optional ?? false,
      })),
    } as unknown as MethodDefinition;
  }
  const parentSimple = parent?.name;
  // A subclass shares an STI parent's table. Any other parent's table belongs
  // to the parent alone, so the subclass gets its own.
  const sharesParentTable =
    !!parent &&
    (def.replaces || ObjectRegistry.getSTIBase(parentKey!) !== null);
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
    ...(def.replaces ? parent?.config : {}),
    ...(tenantScoped ? { tenantScoped } : {}),
    ...(sharesParentTable && !def.replaces ? {} : { tableName }),
    ...(conflictColumns ? { conflictColumns } : {}),
    api: def.api
      ? { include: def.api }
      : def.replaces
        ? parent?.config.api
        : { include: CRUD },
    mcp: def.mcp
      ? { include: def.mcp }
      : def.replaces
        ? parent?.config.mcp
        : { include: mcp },
    ...(def.ui ? { ui: { ...def.ui } } : {}),
    ...(def.display ? { display: { ...def.display } } : {}),
  };
  const label = (decoratorConfig.display as SmartObjectConfig['display'])
    ?.label;
  const displayLabelProjection = resolveDisplayLabelProjection(label);
  if (typeof label === 'string') {
    const problem = displayLabelFieldProblem(fields, label);
    if (problem) {
      throw new Error(
        `Run-time model ${qualifiedName}: display.label ${problem}`,
      );
    }
  }
  if (displayLabelProjection) {
    decoratorConfig.display = {
      ...(decoratorConfig.display as SmartObjectConfig['display']),
      label: { ...displayLabelProjection },
    };
    const via = fields[displayLabelProjection.via];
    if (!via?.related || !['foreignKey', 'crossPackageRef'].includes(via.type))
      throw new Error('Runtime display projection requires an own reference');
    const targetFields = Object.fromEntries(
      ObjectRegistry.getFields(via.related),
    );
    const problem = displayLabelFieldProblem(
      targetFields,
      displayLabelProjection.field,
    );
    if (problem)
      throw new Error(`Runtime display projection target: ${problem}`);
  }
  const displayLabelField = resolveDisplayLabelField(fields, label);
  const entry: SmartObjectDefinition = {
    name: def.name.toLowerCase(),
    className: def.name,
    qualifiedName: qualifiedName as SmartObjectDefinition['qualifiedName'],
    packageName: def.packageName,
    collection: parent?.collection ?? tableName,
    filePath: `runtime-model:${qualifiedName}`,
    fields,
    methods,
    ...(displayLabelField ? { displayLabelField } : {}),
    ...(displayLabelProjection ? { displayLabelProjection } : {}),
    decoratorConfig:
      decoratorConfig as SmartObjectDefinition['decoratorConfig'],
    ...(parent
      ? { extends: parentSimple, extendsQualified: parentKey }
      : { extends: 'SmrtObject' }),
  };
  if (!sharesParentTable || def.replaces) {
    const columns = {
      ...baseColumns(false, 'UUID'),
      ...fieldsToColumns(new Map(Object.entries(fields))),
      ...(parentSchema?.columns ?? {}),
      ...(def.replaces
        ? fieldsToColumns(
            new Map(
              Object.entries(def.fields ?? {}).map(([name, field]) => [
                name,
                toFieldDefinition(field),
              ]),
            ),
          )
        : {}),
    };
    // fieldsToColumns accepts physical table names. Runtime references name
    // registered models, whose physical tables may be explicitly configured.
    for (const [name, field] of Object.entries(fields)) {
      if (
        field.type !== 'foreignKey' ||
        !field.related ||
        field._meta?.__tenancy?.isTenantIdField
      )
        continue;
      const foreignKey = columns[toSnakeCase(name)]?.foreignKey;
      if (!foreignKey) continue;
      const targetTable =
        field.related === qualifiedName || field.related === def.name
          ? tableName
          : ObjectRegistry.getTableName(field.related);
      if (!targetTable) {
        throw new Error(
          `Run-time reference target ${field.related} must be registered first`,
        );
      }
      foreignKey.table = targetTable;
    }
    entry.schema = {
      tableName,
      ddl: '',
      indexes: parentSchema?.indexes ?? [],
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
  refresh?: boolean;
  /** Host-side validators; definitions remain portable JSON. */
  fieldValidators?: Record<
    string,
    (value: unknown, instance: SmrtObject) => boolean | Promise<boolean>
  >;
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
  for (const [name, validate] of Object.entries(
    options.fieldValidators ?? {},
  )) {
    if (!entry.fields[name])
      throw new Error(`Unknown runtime validator field ${name}`);
    entry.fields[name]._meta = { ...entry.fields[name]._meta, validate };
  }
  const qualifiedName = entry.qualifiedName as string;
  registerFromManifest(qualifiedName, entry, def.packageName, {
    extendsRegistered: def.extends,
    replaceParent: def.replaces,
    refreshRuntime: options.refresh,
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
