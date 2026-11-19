/** The app model editor: cookbook source, durable revisions, tracked DDL, live publication. */

import type {
  Cookbook,
  CookbookCustomList,
  CookbookModelField,
  CookbookModels,
} from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type ActivationCoordinator,
  withRuntimeSchemaActivation,
} from '../activation.js';
import { getRuntimeManifest } from '../generators/rest.js';
import { stableStringify } from '../knowledge-graph.js';
import {
  assertMigrationAccepted,
  getPendingSchemaStatements,
  migrateSmrtSchemas,
} from '../migrations/orchestrate.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import {
  getRuntimeModelReadiness,
  notifyRuntimeExposureChanged,
  setRuntimeModelOwner,
  setRuntimeModelReadiness,
} from '../runtime-exposure.js';
import { runtimeListTableName } from '../runtime-list-table.js';
import {
  type RuntimeFieldDefinition,
  registerRuntimeModel,
  runtimeModelEntry,
} from '../runtime-model.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { inspectTableSchema } from '../schema/inspection.js';
import { getDatabaseEngine } from '../system/compatibility.js';
import { resolveDisplayLabelField } from '../ui-metadata.js';
import { toSnakeCase } from '../utils/naming.js';
import {
  buildWebCollectionDefinition,
  selectWebCollectionEntries,
} from '../vite-plugin/web-collections.js';
import { appOperationResult } from './app-tool-edits.js';
import { canonical, coveredModels } from './engine/document.js';
import { createCookbookEngine } from './engine/engine.js';
import { buildNav, modelParts, navItemId } from './engine/nav.js';
import type { EngineCatalog } from './engine/types.js';
import {
  type AppModelChange,
  type AppModelHistoryStore,
  type AppModelOperation,
  createAppModelHistory,
  isAppModelJournalStore,
} from './model-history.js';
import { journalReader } from './model-history-readers.js';
import {
  CUSTOM_MODEL_REF,
  cookbookModelCatalog,
  fitsStorageIdentifier,
  isCustomIdentifier,
  MAX_STORAGE_IDENTIFIER_BYTES,
  storageIdentifierProblems,
  validateCookbookModels,
} from './models.js';
import { isReservedFieldName } from './reserved-names.js';
import { validateCookbook } from './validate.js';

export type AppModelEdit = (
  | {
      type: 'add_field';
      model: string;
      name: string;
      field: CookbookModelField;
      label?: string;
    }
  | { type: 'label_field'; model: string; name: string; label: string | null }
  | { type: 'hide_field'; model: string; name: string; hidden: boolean }
  | { type: 'remove_field'; model: string; name: string }
  | {
      type: 'create_list';
      name: string;
      list: CookbookCustomList;
      fieldLabels?: Record<string, string>;
    }
  | { type: 'relabel_list'; name: string; label: string; icon?: string }
  | { type: 'remove_list'; name: string }
  | { type: 'import'; cookbook: unknown }
  | { type: 'undo' }
) & {
  /** Optional human audit/undo caption, stored with the command. */ summary?: string;
};
export interface AppModelEditContext {
  /** Resolved principal and tenant from the host, never from assistant arguments. */
  actor: string;
  tenantId: string;
  requestId: string;
  expectedRevision: number;
  operation?: AppModelOperation;
}
export interface AppModelEditorOptions {
  db: DatabaseInterface;
  application: string;
  tenantId: string;
  packageName: string;
  cookbook: Cookbook;
  catalog: EngineCatalog;
  store?: AppModelHistoryStore;
  authorize(context: AppModelEditContext): boolean | Promise<boolean>;
  /** Publish the cookbook/manifest projection to the host's existing engine and transports. */
  publish?(snapshot: AppModelSnapshot): void | Promise<void>;
  /**
   * A lazy-activation host's coordinator. Its manifest names every installed
   * model and table, loaded or not, so a new list cannot take the name or
   * table of a model whose recipe is off; `import` and `undo` activate the
   * models the restored cookbook covers before they apply.
   */
  activation?: Pick<ActivationCoordinator, 'activate' | 'manifest'>;
}
export interface AppModelSnapshot {
  revision: number;
  cookbook: Cookbook;
  manifest: SmartObjectManifest;
  webDefinitions: (ReturnType<typeof buildWebCollectionDefinition> & {
    label?: string;
    icon?: string;
    fieldPolicies: Record<string, Cookbook['policies'][number]>;
    customFields: string[];
  })[];
}
export interface AppModelEditReceipt extends AppModelSnapshot {
  path: 'runtime' | 'policy';
  elapsedMs: number;
  replayed?: boolean;
}

/**
 * Journal rows are immutable, and a layout label that is neither text nor
 * null could never be rendered: drop it when reading a stored document, so an
 * editor whose journal holds one still opens.
 */
function repairLayoutLabels(value: unknown): unknown {
  const layout = (value as { layout?: Record<string, unknown> } | null)?.layout;
  if (!layout || typeof layout !== 'object') return value;
  let repaired: { layout: Record<string, unknown> } | undefined;
  for (const key of ['sections', 'items'] as const) {
    const entries = layout[key];
    if (!entries || typeof entries !== 'object') continue;
    for (const [id, entry] of Object.entries(entries)) {
      const label = (entry as { label?: unknown } | null)?.label;
      if (label === undefined || label === null || typeof label === 'string')
        continue;
      repaired ??= structuredClone(value) as {
        layout: Record<string, unknown>;
      };
      delete (repaired.layout[key] as Record<string, Record<string, unknown>>)[
        id
      ].label;
    }
  }
  return repaired ?? value;
}

function checked(value: unknown): Cookbook {
  const result = validateCookbook(value);
  if (!result.ok)
    throw new Error(`INVALID_MODEL_EDIT: ${result.errors.join('; ')}`);
  return canonical(structuredClone(result.cookbook));
}

/** Money and presentation use the existing runtime/manifest field contract. */
function runtimeFields(
  fields: Record<string, CookbookModelField>,
  models: CookbookModels,
): Record<string, RuntimeFieldDefinition> {
  const result: Record<string, RuntimeFieldDefinition> = {};
  for (const [name, field] of Object.entries(fields)) {
    switch (field.type) {
      case 'longText':
        result[name] = { type: 'text', ui: { widget: 'textarea' } };
        break;
      case 'date':
      case 'datetime':
        result[name] = { type: 'datetime', ui: { format: field.type } };
        break;
      case 'money':
        result[name] = { type: 'integer', ui: { format: 'money' } };
        result[`${name}Currency`] = {
          type: 'text',
          default: field.currency,
          ui: { widget: 'currency' },
        };
        break;
      case 'choice':
        result[name] = { type: 'text', enum: field.choices };
        break;
      case 'reference': {
        const target = field.target!;
        const related = target.includes(':')
          ? target
          : `${models.packageName}:${target}`;
        result[name] = {
          type: related.startsWith(`${models.packageName}:`)
            ? 'foreignKey'
            : 'crossPackageRef',
          related,
        };
        break;
      }
      default:
        result[name] = { type: field.type };
    }
  }
  return result;
}

/** Reuse compiled field validators, including the save executor for reference checks. */
function fieldValidators(fields: Record<string, RuntimeFieldDefinition>) {
  return Object.fromEntries(
    Object.entries(fields).map(([name, field]) => [
      name,
      async (value: unknown, instance: SmrtObject) => {
        if (value === null || value === undefined || value === '') return true;
        if (field.type === 'integer')
          return typeof value === 'number' && Number.isSafeInteger(value);
        if (field.type === 'decimal')
          return typeof value === 'number' && Number.isFinite(value);
        if (field.type === 'boolean') return typeof value === 'boolean';
        if (field.type === 'datetime')
          return (
            (typeof value === 'string' || value instanceof Date) &&
            Number.isFinite(new Date(value).getTime())
          );
        if (field.type === 'text')
          return (
            typeof value === 'string' &&
            (!field.enum || field.enum.includes(value)) &&
            (field.ui?.widget !== 'currency' || /^[A-Z]{3}$/.test(value))
          );
        if (field.type === 'foreignKey' || field.type === 'crossPackageRef') {
          if (typeof value !== 'string') return false;
          const target = await ObjectRegistry.getCollection(field.related!, {
            db: instance.db,
          });
          return !!(await target.get(value));
        }
        return true;
      },
    ]),
  );
}

/** Keep archived storage declarations through removal/undo; never drop data as a side effect. */
function storageModels(
  documents: readonly Cookbook[],
  seed?: CookbookModels,
): CookbookModels | undefined {
  let result: CookbookModels | undefined = seed && structuredClone(seed);
  for (const document of documents) {
    const model = document.models;
    if (!model) continue;
    result ??= {
      version: 1,
      packageName: model.packageName,
      lists: {},
      fields: {},
    };
    if (result.packageName !== model.packageName)
      throw new Error('MODEL_PACKAGE_CONFLICT');
    for (const [name, list] of Object.entries(model.lists))
      result.lists[name] = {
        ...structuredClone(list),
        fields: {
          ...result.lists[name]?.fields,
          ...structuredClone(list.fields),
        },
      };
    for (const [name, fields] of Object.entries(model.fields))
      result.fields[name] = {
        ...result.fields[name],
        ...structuredClone(fields),
      };
  }
  return result;
}

/** Models whose stored fields `after` adds or changes relative to `before`. */
function changedModels(
  before: CookbookModels | undefined,
  after: CookbookModels | undefined,
): string[] {
  if (!after) return [];
  const differs = (a: unknown, b: unknown) =>
    b === undefined || stableStringify(a) !== stableStringify(b);
  return [
    ...Object.entries(after.lists)
      .filter(([name, list]) =>
        differs(list.fields, before?.lists[name]?.fields),
      )
      .map(([name]) => `${after.packageName}:${name}`),
    ...Object.entries(after.fields)
      .filter(([model, fields]) => differs(fields, before?.fields[model]))
      .map(([model]) => model),
  ];
}

/** Whether a physical table exists, kept (for example) by a disabled recipe. */
async function tableExists(
  db: DatabaseInterface,
  engine: string,
  table: string,
): Promise<boolean> {
  const { rows } = await db.query(
    engine === 'postgres'
      ? "SELECT 1 AS live FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = current_schema() AND c.relname = ? AND c.relkind IN ('r', 'p')"
      : "SELECT 1 AS live FROM sqlite_master WHERE type = 'table' AND lower(name) = lower(?)",
    [table],
  );
  return rows.length > 0;
}

declare global {
  /** Run-time classes each app model editor registered, by journal identity. */
  var __smrtAppModelEditorClasses: WeakMap<object, string> | undefined;
}
const editorClasses = () =>
  (globalThis.__smrtAppModelEditorClasses ??= new WeakMap<object, string>());
/** A process-local identity per database handle, part of each journal's key. */
const databaseIds = new WeakMap<object, number>();
let nextDatabaseId = 1;
const databaseId = (db: object) => {
  let id = databaseIds.get(db);
  if (id === undefined) {
    id = nextDatabaseId++;
    databaseIds.set(db, id);
  }
  return id;
};
/**
 * Registry baselines per journal and provider: the registration state before
 * the journal first replaced the provider, shared by every editor instance of
 * that journal so a reopened editor can still take its replacement out.
 */
const journalBaselines = new Map<string, Map<string, () => void>>();

/** Async construction replays persisted customizations and resolves pending activation BEFORE serving. */
export async function createAppModelEditor(options: AppModelEditorOptions) {
  if (!options.application || !options.tenantId || !options.authorize)
    throw new Error(
      'App model editor requires an application, tenant and authorizer',
    );
  const engine = getDatabaseEngine(options.db);
  if (engine !== 'sqlite' && engine !== 'postgres')
    throw new Error(
      'MODEL_ENGINE_UNSUPPORTED: live app model editor supports SQLite and PostgreSQL; DuckDB transactional DDL and revision fencing are not supported',
    );
  // Run-time lists are known to the retire step (#5005) only through the
  // journal; a store that writes elsewhere would create tables a whole-schema
  // migrate in another process sees as undeclared.
  if (options.store && !isAppModelJournalStore(options.store))
    throw new Error(
      'MODEL_HISTORY_JOURNAL_REQUIRED: a custom history store must append through a store createAppModelHistory made, so the app model journal (_smrt_app_model_changes) records every list and smrt db:migrate never treats a list table as undeclared',
    );
  // The registry is process-global: two independently customised editors
  // (another tenant's or application's journal) would merge their fields and
  // lists into the same classes. One application registry per process.
  // The journal identity includes the database: the same application and
  // tenant on another database is an independent journal.
  const journal = JSON.stringify([
    options.application,
    options.tenantId,
    databaseId(options.db),
  ]);
  const assertSoleEditor = () => {
    for (const entry of ObjectRegistry.getAllClasses().values()) {
      const owner = editorClasses().get(entry.constructor);
      if (owner !== undefined && owner !== journal)
        throw new Error(
          'MODEL_EDIT_CONFLICT: this process already holds app model customisations from another tenant or application journal; run one customised application registry per process',
        );
    }
  };
  assertSoleEditor();
  const store = options.store ?? (await createAppModelHistory(options));
  if (engine === 'postgres' && !store.transaction)
    throw new Error(
      'MODEL_HISTORY_TRANSACTION_REQUIRED: PostgreSQL history must bind revision CAS and migration DDL to one locked transaction',
    );
  // The editor never needs stored receipts in bulk: it keeps the light journal
  // (documents, no receipts) in memory and reads single rows per edit.
  const reader = journalReader(store);
  let history = await (reader ? reader.light() : store.read());
  const latestRow = async () =>
    reader ? reader.latest() : (await store.read()).at(-1);
  const findRow = async (requestId: string) =>
    reader
      ? reader.find(requestId)
      : (await store.read()).find((row) => row.requestId === requestId);
  /**
   * Read back a revision this editor just completed. complete() keeps only
   * the first completion, so another process (boot recovery elsewhere) may
   * have won: the caller adopts the journal's receipt. A row that is not
   * applied means this editor must not report or publish success.
   */
  const completedRow = async (requestId: string, at: number) => {
    const row = await findRow(requestId);
    // An operator abandoning the revision meanwhile also loses this completion.
    if (row?.status !== 'applied' || row.abandoned || row.revision !== at) {
      ready = false;
      throw new Error(
        `MODEL_EDIT_CONFLICT: revision ${at} was not completed as this edit; reopen the editor`,
      );
    }
    return row;
  };
  let revision = history.at(-1)?.revision ?? 0;
  let doc = checked(
    repairLayoutLabels(history.at(-1)?.after ?? options.cookbook),
  );
  let ready = false;
  let tail = Promise.resolve();
  const listeners = new Set<(snapshot: AppModelSnapshot) => void>();
  const effectiveId = (model: string) =>
    model.includes(':') ? model : `${options.packageName}:${model}`;
  const documents = () => [
    ...history.flatMap((row) => [row.before, row.after]),
    doc,
  ];
  // The union of every journalled declaration, recomputed only when the
  // journal or document changes (not on every snapshot or edit). Read-only.
  let storageMemo:
    | { history: AppModelChange[]; doc: Cookbook; value?: CookbookModels }
    | undefined;
  const storage = () => {
    if (storageMemo?.history !== history || storageMemo.doc !== doc)
      storageMemo = { history, doc, value: storageModels(documents()) };
    return storageMemo.value;
  };
  const identities = (models?: CookbookModels) =>
    models
      ? [
          ...Object.keys(models.lists).map(
            (name) => `${models.packageName}:${name}`,
          ),
          ...Object.keys(models.fields),
          ...Object.keys(models.fields).map(
            (id) => `${models.packageName}:${id.split(':').at(-1)}`,
          ),
        ]
      : [];

  /** Installed models and tables, loaded or not: the catalog plus the activation manifest. */
  function installed() {
    const names = new Map<string, string>();
    const tables = new Map<string, string>();
    const manifest = options.activation?.manifest;
    for (const model of options.catalog.models)
      names.set(model.name.toLowerCase(), model.id);
    for (const [id, model] of Object.entries(manifest?.models ?? {})) {
      names.set(id.split(':').at(-1)!.toLowerCase(), id);
      if (model.table) tables.set(model.table, id);
    }
    for (const [table, entry] of Object.entries(manifest?.tables ?? {}))
      if (!tables.has(table)) tables.set(table, entry.owners[0] ?? table);
    return { names, tables };
  }

  /**
   * `live` is the database to probe for an existing table. Edits pass it;
   * boot does not, since lists the journal already holds own their tables.
   */
  async function validate(
    doc: Cookbook,
    archived?: CookbookModels,
    live?: DatabaseInterface,
  ) {
    if (!doc.models) return;
    const models = doc.models;
    if (models.packageName !== options.packageName)
      throw new Error(
        'MODEL_PACKAGE_CONFLICT: import uses a different app package identity',
      );
    const errors = validateCookbookModels(models);
    if (errors.length)
      throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join('; '));
    // Derived table and column names must fit the strictest supported engine.
    // Declarations the journal already holds are not new and stay accepted.
    const tooLong = storageIdentifierProblems(models, archived);
    if (tooLong.length)
      throw new Error(
        `INVALID_MODEL_EDIT: ${tooLong.map((e) => `${e.path} ${e.message}`).join('; ')}`,
      );
    const used = coveredModels(options.catalog, doc);
    for (const [target, fields] of Object.entries(models.fields)) {
      if (used.has(target)) {
        if (!ObjectRegistry.getClass(target))
          throw new Error(`MODEL_NOT_IN_APP: ${target}`);
        continue;
      }
      // Disabling a provider's last recipe keeps its field declarations,
      // inactive until the recipe is enabled again. Only declarations the
      // journal already holds may stay; a new one needs the model in the app.
      const kept = archived?.fields[target];
      if (
        !kept ||
        Object.entries(fields).some(
          ([name, field]) =>
            !Object.hasOwn(kept, name) ||
            stableStringify(kept[name]) !== stableStringify(field),
        )
      )
        throw new Error(`MODEL_NOT_IN_APP: ${target}`);
    }
    const names = new Set<string>();
    for (const target of Object.keys(models.fields)) {
      const name = target.split(':').at(-1)!;
      if (names.has(name)) throw new Error(`APP_MODEL_NAME_COLLISION: ${name}`);
      names.add(name);
    }
    const tables = new Set<string>();
    const reserved = installed();
    for (const [name, list] of Object.entries(models.lists)) {
      if (names.has(name)) throw new Error(`MODEL_NAME_COLLISION: ${name}`);
      names.add(name);
      const own = `${models.packageName}:${name}`;
      const entry = runtimeModelEntry({
        packageName: models.packageName,
        name,
        fields: runtimeFields(
          Object.fromEntries(
            Object.entries(list.fields).filter(
              ([, field]) => field.type !== 'reference',
            ),
          ),
          models,
        ),
      });
      const table = entry.schema!.tableName;
      if (tables.has(table)) throw new Error(`MODEL_TABLE_COLLISION: ${table}`);
      tables.add(table);
      // A list the journal already holds keeps its name and table, so its
      // edits (removing it included) still apply if an installed model with
      // the same table was loaded beside it before these checks existed.
      if (archived?.lists[name]) continue;
      // A new list's name and table must be free among installed models
      // whether or not their recipe is on (lazy hosts load only enabled ones),
      // and among tables the database keeps for disabled or removed models.
      // The app package's own installed models (not loaded in a lazy host)
      // keep their identity: a list may not take it.
      if (options.activation?.manifest?.models[own])
        throw new Error(
          `MODEL_NAME_COLLISION: ${name} is the installed model ${own}; choose another list name`,
        );
      const named = reserved.names.get(name.toLowerCase());
      if (named && named !== own)
        throw new Error(
          `MODEL_NAME_COLLISION: ${name} is the name of the installed model ${named}; choose another list name`,
        );
      const owner = reserved.tables.get(table);
      if (owner && owner !== own)
        throw new Error(
          `MODEL_TABLE_COLLISION: ${table} is the table of the installed model ${owner}; choose another list name`,
        );
      for (const existing of ObjectRegistry.getAllClasses().values())
        if (
          ObjectRegistry.getTableName(
            existing.qualifiedName ?? existing.name,
          ) === table &&
          existing.qualifiedName !== own
        )
          throw new Error(`MODEL_TABLE_COLLISION: ${table}`);
      if (live && (await tableExists(live, engine, table)))
        throw new Error(
          `MODEL_TABLE_COLLISION: ${table} already exists in the database (kept for a disabled or removed model); choose another list name`,
        );
    }
    const protectedNames = new Set<string>();
    for (
      let proto: object | null = SmrtObject.prototype;
      proto;
      proto = Object.getPrototypeOf(proto)
    )
      for (const name of Object.getOwnPropertyNames(proto))
        protectedNames.add(name);
    const fieldSets = [
      ...Object.entries(models.lists).map(([name, list]) => ({
        name,
        fields: list.fields,
        archived: archived?.lists[name]?.fields,
        registered: ObjectRegistry.getClass(`${options.packageName}:${name}`),
      })),
      ...Object.entries(models.fields).map(([name, fields]) => ({
        name,
        fields,
        archived: archived?.fields[name],
        registered: ObjectRegistry.getClass(name),
      })),
    ];
    for (const entry of fieldSets) {
      if (!entry.name.includes(':')) {
        const collision = [...ObjectRegistry.getAllClasses().values()].find(
          (item) => item.name.toLowerCase() === entry.name.toLowerCase(),
        );
        if (
          collision &&
          (!entry.archived ||
            collision.qualifiedName !==
              `${options.packageName}:${entry.name}` ||
            !collision.sourceFilePath?.startsWith('runtime-model:'))
        )
          throw new Error(`MODEL_NAME_COLLISION: ${entry.name}`);
      }
      const existing = entry.registered
        ? await ObjectRegistry.getAllFields(
            entry.registered.qualifiedName ?? entry.registered.name,
          )
        : new Map();
      const modelProtected = new Set(protectedNames);
      for (
        let proto = entry.registered?.constructor.prototype;
        proto;
        proto = Object.getPrototypeOf(proto)
      )
        for (const name of Object.getOwnPropertyNames(proto))
          modelProtected.add(name);
      for (const [name, field] of Object.entries(entry.fields)) {
        if (!isCustomIdentifier(name) || modelProtected.has(name))
          throw new Error(`FIELD_NAME_RESERVED: ${name}`);
        // Constructor options and instance members (`options`, `db`, `ai`, …)
        // are not on the prototype. A new field, or its money companion, must
        // not take one; a field the journal already holds stays accepted.
        if (
          !(entry.archived && Object.hasOwn(entry.archived, name)) &&
          [name, ...(field.type === 'money' ? [`${name}Currency`] : [])].some(
            (column) =>
              isReservedFieldName(column) || modelProtected.has(column),
          )
        )
          throw new Error(
            `FIELD_NAME_RESERVED: ${name} is used by the object runtime; choose another field name`,
          );
        for (const columnName of [
          name,
          ...(field.type === 'money' ? [`${name}Currency`] : []),
        ]) {
          const collision = [...existing.keys()].find(
            (key) => toSnakeCase(key) === toSnakeCase(columnName),
          );
          const previouslyCustom =
            entry.archived && Object.hasOwn(entry.archived, name);
          if (collision && !previouslyCustom)
            throw new Error(`FIELD_NAME_COLLISION: ${columnName}`);
        }
        if (
          entry.name.includes(':') &&
          ObjectRegistry.getDeclaredClass(entry.name)?.fields.has(name)
        )
          throw new Error(`FIELD_NAME_COLLISION: ${name}`);
        const previous = entry.archived?.[name];
        if (
          previous &&
          JSON.stringify([
            previous.type,
            previous.currency,
            previous.choices,
            previous.target,
          ]) !==
            JSON.stringify([
              field.type,
              field.currency,
              field.choices,
              field.target,
            ])
        )
          throw new Error(
            `FIELD_TYPE_CHANGE_REQUIRES_MIGRATION: ${entry.name}.${name}`,
          );
        // A journalled, unchanged field of a provider whose recipe is off is
        // inactive: its reference is resolved again when the recipe returns.
        const inactive =
          entry.name.includes(':') &&
          !used.has(entry.name) &&
          !!previous &&
          stableStringify(previous) === stableStringify(field);
        if (field.type === 'reference' && !inactive) {
          const target = field.target!;
          if (
            target.includes(':') &&
            !target.startsWith(`${models.packageName}:`) &&
            !ObjectRegistry.getClass(target)
          )
            throw new Error(`REFERENCE_NOT_REGISTERED: ${target}`);
          if (
            target.includes(':')
              ? !used.has(target) &&
                !(
                  target.startsWith(`${models.packageName}:`) &&
                  Object.hasOwn(models.lists, target.split(':').at(-1)!)
                )
              : !Object.hasOwn(models.lists, target)
          )
            throw new Error(`REFERENCE_NOT_IN_APP: ${target}`);
        }
      }
    }
  }

  function projection(): AppModelSnapshot {
    const manifest = getRuntimeManifest();
    const allowed = coveredModels(options.catalog, doc);
    const catalog = cookbookModelCatalog(options.catalog, doc.models);
    const nav = buildNav(catalog, doc).flatMap((section) => section.items);
    const archived = storage();

    manifest.objects = Object.fromEntries(
      Object.entries(manifest.objects).filter(
        ([key, entry]) =>
          allowed.has(key) ||
          (entry.replacedBy && allowed.has(entry.replacedBy)) ||
          ObjectRegistry.getClass(key)?.replacedQualifiedNames?.some((id) =>
            allowed.has(id),
          ),
      ),
    );
    for (const entry of Object.values(manifest.objects))
      entry.displayLabelField = resolveDisplayLabelField(
        entry.fields,
        entry.decoratorConfig.display?.label,
      );
    return {
      revision,
      cookbook: structuredClone(doc),
      manifest,
      webDefinitions: selectWebCollectionEntries(manifest).map((entry) => {
        const definition = buildWebCollectionDefinition(entry, manifest);
        const ids = [
          definition.objectRef,
          ...(ObjectRegistry.getClass(definition.objectRef)
            ?.replacedQualifiedNames ?? []),
        ];
        const items = ids.flatMap((id) => {
          const parts = modelParts(catalog, id);
          return [
            navItemId(parts.packageId, parts.name),
            ...catalog.recipes.flatMap((recipe) =>
              recipe.nav
                .filter((item) => item.model === id)
                .map((item) =>
                  navItemId(parts.packageId, parts.name, item.key),
                ),
            ),
          ];
        });
        const item = nav.find((item) => items.includes(item.id));
        const customFields = ids.flatMap((id) =>
          Object.entries(
            archived?.lists[
              id.startsWith(`${options.packageName}:`)
                ? id.split(':').at(-1)!
                : ''
            ]?.fields ??
              archived?.fields[id] ??
              {},
          ).flatMap(([name, field]) => [
            name,
            ...(field.type === 'money' ? [`${name}Currency`] : []),
          ]),
        );
        const fieldPolicies = Object.fromEntries(
          doc.policies
            .filter(
              (policy) =>
                ids.includes(policy.objectRef) && policy.scopeType === 'app',
            )
            .map((policy) => [policy.fieldName, structuredClone(policy)]),
        );
        return {
          ...definition,
          customFields: [...new Set(customFields)],
          ...(definition.listFields
            ? {
                listFields: [
                  ...new Set([...definition.listFields, ...customFields]),
                ].filter(
                  (name) =>
                    Object.hasOwn(definition.fields, name) &&
                    fieldPolicies[name]?.visibility !== 'hidden',
                ),
              }
            : {}),
          ...(item ? { label: item.label, icon: item.icon } : {}),
          fieldPolicies,
        };
      }),
    };
  }

  /**
   * The storage that registers and migrates for `target`: every list, and the
   * provider overrides whose model `target` covers. An override whose recipe
   * is off stays declared and keeps its columns, inactive (never registered,
   * migrated or held closed) until the recipe is enabled again.
   */
  function active(
    all: CookbookModels | undefined,
    target: Cookbook,
  ): CookbookModels | undefined {
    if (!all) return all;
    const used = coveredModels(options.catalog, target);
    return {
      ...all,
      fields: Object.fromEntries(
        Object.entries(all.fields).filter(([id]) => used.has(id)),
      ),
    };
  }

  /** Registry baselines taken before this journal first replaced each provider. */
  const replacements =
    journalBaselines.get(journal) ??
    journalBaselines.set(journal, new Map()).get(journal)!;

  /** Register storage declarations; affected readiness closes until release(). */
  function register(all: CookbookModels | undefined) {
    setRuntimeModelReadiness(identities(all), false);
    ready = false;
    if (!all) return;
    try {
      registerAll(all);
    } finally {
      for (const id of identities(all)) {
        if (!id.startsWith(`${options.packageName}:`)) continue;
        const entry = ObjectRegistry.getClass(id);
        if (entry) editorClasses().set(entry.constructor, journal);
      }
      // Exposure admits these registrations only for this journal's tenant.
      setRuntimeModelOwner(
        identities(all).filter((id) =>
          id.startsWith(`${options.packageName}:`),
        ),
        options.tenantId,
      );
    }
  }
  function registerAll(all: CookbookModels) {
    // Register non-reference fields first, so mutually referencing app lists resolve through registry APIs.
    for (const [name, list] of Object.entries(all.lists))
      registerRuntimeModel(
        {
          packageName: all.packageName,
          name,
          fields: runtimeFields(
            Object.fromEntries(
              Object.entries(list.fields).filter(
                ([, field]) => field.type !== 'reference',
              ),
            ),
            all,
          ),
          tenantScoped: true,
          ui: { label: list.label, icon: list.icon },
          display: { label: list.displayField },
        },
        {
          refresh: true,
          fieldValidators: fieldValidators(
            runtimeFields(
              Object.fromEntries(
                Object.entries(list.fields).filter(
                  ([, field]) => field.type !== 'reference',
                ),
              ),
              all,
            ),
          ),
        },
      );
    for (const [name, list] of Object.entries(all.lists))
      registerRuntimeModel(
        {
          packageName: all.packageName,
          name,
          fields: runtimeFields(list.fields, all),
          tenantScoped: true,
          ui: { label: list.label, icon: list.icon },
          display: { label: list.displayField },
        },
        {
          refresh: true,
          fieldValidators: fieldValidators(runtimeFields(list.fields, all)),
        },
      );
    for (const [model, fields] of Object.entries(all.fields)) {
      const replacement = `${all.packageName}:${model.split(':').at(-1)}`;
      // Remember the registry before this journal first replaces the
      // provider (absent, or a pre-existing app subclass), so disabling the
      // provider's recipe restores it, from any editor instance of the
      // journal. A baseline is stale once the registry no longer holds this
      // journal's replacement (a reset registry): take a new one.
      const current = ObjectRegistry.getClass(replacement);
      if (
        !replacements.has(model) ||
        !current ||
        editorClasses().get(current.constructor) !== journal
      )
        replacements.set(
          model,
          ObjectRegistry.checkpointRegistrations([model, replacement]),
        );
      registerRuntimeModel(
        {
          packageName: all.packageName,
          name: model.split(':').at(-1)!,
          extends: model,
          replaces: true,
          fields: runtimeFields(fields, all),
        },
        {
          refresh: true,
          fieldValidators: fieldValidators(runtimeFields(fields, all)),
        },
      );
    }
  }

  /** Physical tables of the given (registered) model identities. */
  const tablesOf = (models: readonly string[]) =>
    new Set(
      models
        .map((id) => ObjectRegistry.getTableName(id))
        .filter((name): name is string => !!name),
    );

  /**
   * Refuse manual drift on the tables an edit migrates. Only those tables (and
   * their FK closure) are inspected, so drift elsewhere never blocks an edit.
   */
  async function plan(db: DatabaseInterface, tables: Set<string>) {
    if (!tables.size) return;
    if (engine === 'postgres') {
      // PostgreSQL truncates a longer identifier, so a declaration over the
      // limit (journalled before edits were checked) never matches its own
      // column again and every migration of its table would fail. Refuse the
      // edit up front; the model keeps working and other models stay editable.
      const schemas = ObjectRegistry.getAllSchemasAsDefinitions({ tables });
      const long = Object.values(schemas).flatMap((schema) =>
        [schema.tableName, ...Object.keys(schema.columns)]
          .filter((name) => !fitsStorageIdentifier(name))
          .map((name) => `${schema.tableName}.${name}`),
      );
      if (long.length)
        throw new Error(
          `MODEL_MIGRATION_REQUIRED: ${long.join(', ')} exceed PostgreSQL's ${MAX_STORAGE_IDENTIFIER_BYTES}-byte identifier limit, so this table cannot take new fields. Add the field to another list, or have an operator rename the stored column and its declaration`,
        );
    }
    const pending = await getPendingSchemaStatements(db, {
      engineHint: engine,
      tables,
    });
    if (pending.hasManualDrift)
      throw new Error(
        `MODEL_MIGRATION_REQUIRED: ${JSON.stringify(pending.unactionableChanges)}`,
      );
  }

  async function migrate(db: DatabaseInterface, tables: Set<string>) {
    if (!tables.size) return;
    // A refused run applies nothing (a release stop, for example); the edit
    // must fail rather than publish fields whose columns do not exist.
    const migrated = await migrateSmrtSchemas({
      db,
      packageName: options.packageName,
      version: String(revision),
      name: `app_models_${revision}_${Date.now()}`,
      engineHint: engine,
      ...(engine === 'postgres'
        ? { atomic: true, postgresSafe: false, useConcurrentIndexes: false }
        : {}),
      tables,
      requireComplete: true,
    });
    assertMigrationAccepted(migrated);
  }

  /**
   * Register `all` and migrate only the tables of `changed` models: an edit's
   * new lists and fields. Labels, hiding, removal and undo change no storage
   * and run no DDL; provider tables otherwise stay the operator's migration.
   */
  async function activate(
    target: Cookbook,
    all: CookbookModels | undefined,
    changed: readonly string[],
    db = options.db,
    publishNow = true,
  ) {
    register(all);
    const tables = tablesOf(changed);
    await plan(db, tables);
    await migrate(db, tables);
    doc = structuredClone(target);
    return publishNow ? publish() : projection();
  }

  async function publish() {
    const current = projection();
    try {
      await options.publish?.(current);
    } catch (error) {
      ready = false;
      throw error;
    }
    return current;
  }

  function release(all?: CookbookModels) {
    const held = identities(all);
    ready = true;
    // A provider whose recipe is now off keeps its declarations inactive; its
    // replacement leaves the registry so no projection shows its fields.
    for (const [model, restore] of replacements)
      if (!all?.fields[model]) {
        const replacement = `${options.packageName}:${model.split(':').at(-1)}`;
        const current = ObjectRegistry.getClass(replacement);
        // Only a replacement this journal registered is restored.
        if (current && editorClasses().get(current.constructor) === journal) {
          restore();
          setRuntimeModelOwner([replacement], undefined);
        }
        replacements.delete(model);
      }
    // Deleted lists remain in storage/registry but are closed on every surface.
    const enabled = new Set(coveredModels(options.catalog, doc));
    setRuntimeModelReadiness(
      held.filter(
        (id) => enabled.has(id) || !all?.lists[id.split(':').at(-1)!],
      ),
      true,
    );
    notifyRuntimeExposureChanged();
  }
  /**
   * When another process completed a revision first, its receipt is the
   * committed projection: installed through the host before readiness opens,
   * and served by snapshot() for that revision.
   */
  let adopted: AppModelSnapshot | undefined;
  async function adoptWinner(
    row: AppModelChange,
    local: AppModelEditReceipt,
  ): Promise<AppModelSnapshot | undefined> {
    if (!row.receipt || stableStringify(row.receipt) === stableStringify(local))
      return undefined;
    const { revision: at, cookbook, manifest, webDefinitions } = row.receipt;
    const winner = { revision: at, cookbook, manifest, webDefinitions };
    try {
      await options.publish?.(structuredClone(winner));
    } catch (error) {
      ready = false;
      throw error;
    }
    adopted = winner;
    return winner;
  }
  function snapshot(): AppModelSnapshot {
    if (!ready) throw new Error('MODEL_ACTIVATION_PENDING');
    // Never project another journal's registrations as this editor's own.
    assertSoleEditor();
    if (adopted?.revision === revision) return structuredClone(adopted);
    return projection();
  }

  function receiptFor(
    current: AppModelSnapshot,
    edit: AppModelEdit,
    elapsedMs: number,
  ): AppModelEditReceipt {
    return JSON.parse(
      JSON.stringify({
        ...current,
        path: ['label_field', 'hide_field', 'remove_field'].includes(edit.type)
          ? 'policy'
          : 'runtime',
        elapsedMs,
      }),
    );
  }
  async function recover(
    context: AppModelEditContext,
  ): Promise<AppModelChange | null> {
    if (
      context.tenantId !== options.tenantId ||
      !context.actor ||
      !context.requestId ||
      !(await options.authorize(context))
    )
      throw new Error('MODEL_EDIT_FORBIDDEN');
    if (!store.supportsDurableOperations)
      throw new Error('MODEL_DURABLE_OPERATIONS_UNSUPPORTED');
    const found = await findRow(context.requestId);
    if (!found) return null;
    if (
      found.actor !== context.actor ||
      found.revision - 1 !== context.expectedRevision ||
      !found.operation ||
      !context.operation ||
      stableStringify(found.operation.binding) !==
        stableStringify(context.operation.binding)
    )
      throw new Error('MODEL_REQUEST_ID_REUSED');
    if (found.status !== 'applied')
      throw new Error('MODEL_ACTIVATION_PENDING: reopen the editor to recover');
    if (found.abandoned)
      throw new Error(
        `MODEL_REVISION_ABANDONED: revision ${found.revision} was abandoned and never applied`,
      );
    if (!found.receipt || !found.result)
      throw new Error('MODEL_RESULT_UNAVAILABLE');
    return structuredClone(found);
  }

  const recoveryHint = (error: unknown) => {
    const pending = history.at(-1);
    if (pending?.status !== 'pending' || !(error instanceof Error))
      return error;
    error.message += `; pending revision ${pending.revision} cannot be applied. Repair the cause and reopen, or abandon it with abandonAppModelRevision({ revision: ${pending.revision} })`;
    return error;
  };
  /**
   * The storage boot reconciles: a pending revision's own changes, or an
   * initial cookbook's declarations before anything is journalled. An applied
   * journal runs no DDL at boot; verifyStorage() checks it instead.
   */
  function bootChanges(): string[] {
    const all = active(storage(), doc);
    const pending =
      history.at(-1)?.status === 'pending' ? history.at(-1) : undefined;
    if (!history.length) return changedModels(undefined, all);
    if (!pending) return [];
    return changedModels(
      active(
        storageModels([
          ...history.slice(0, -1).flatMap((row) => [row.before, row.after]),
          pending.before,
        ]),
        pending.before,
      ),
      all,
    );
  }

  /**
   * An initial cookbook that declares app models, opened with an empty
   * journal, becomes journal revision 1, then migrated and completed as a
   * tracked revision, so later boots treat its lists as journalled and the
   * retire step knows their tables. Its lists may not take a table an
   * installed model owns (manifest or registry), even one that model kept
   * after its recipe was disabled.
   */
  async function journalInitial(target: AppModelHistoryStore) {
    const models = doc.models;
    if (
      history.length ||
      !models ||
      (!Object.keys(models.lists).length && !Object.keys(models.fields).length)
    )
      return;
    // The startup document may have booted before this release: its own
    // declarations count as existing for the name, length and reserved-name
    // checks. Its tables must still not belong to an installed model.
    await validate(doc, storageModels([doc]));
    const reserved = installed();
    for (const name of Object.keys(models.lists)) {
      const own = `${models.packageName}:${name}`;
      const table = runtimeListTableName(name);
      const owner =
        reserved.tables.get(table) ??
        [...ObjectRegistry.getAllClasses().values()]
          .map((entry) => entry.qualifiedName ?? entry.name)
          .find(
            (id) => id !== own && ObjectRegistry.getTableName(id) === table,
          );
      if (owner && owner !== own)
        throw new Error(
          `MODEL_TABLE_COLLISION: ${table} is the table of the installed model ${owner}; the startup cookbook's list ${name} cannot take it`,
        );
    }
    const before = structuredClone(doc);
    delete before.models;
    const change: AppModelChange = {
      revision: 1,
      requestId: 'initial-cookbook',
      actor: 'system',
      command: JSON.stringify({
        type: 'import',
        cookbook: doc,
        summary: 'Initial app models',
      }),
      before,
      after: structuredClone(doc),
      status: 'pending',
    };
    await target.append(change, 0);
    history = [change];
    revision = 1;
  }

  /**
   * Read-only check that every registered customised model's table holds
   * every declared column (provider upgrades included), so boot never opens a
   * model whose storage is incomplete. PostgreSQL stores identifiers over 63
   * bytes truncated, so the comparison truncates too.
   */
  const storageMismatch: string[] = [];
  async function verifyStorage(
    db: DatabaseInterface,
    models: readonly string[],
    skip: readonly string[],
  ) {
    const tables = tablesOf(models.filter((id) => !skip.includes(id)));
    if (!tables.size) return;
    const physical = (name: string) =>
      engine === 'postgres'
        ? new TextDecoder().decode(
            new TextEncoder()
              .encode(name)
              .slice(0, MAX_STORAGE_IDENTIFIER_BYTES),
          )
        : name;
    const missing: string[] = [];
    for (const schema of Object.values(
      ObjectRegistry.getAllSchemasAsDefinitions({ tables }),
    )) {
      if (!tables.has(schema.tableName)) continue;
      const live = await inspectTableSchema(
        db,
        physical(schema.tableName),
        engine,
      );
      const columns = new Set(
        Object.keys(live?.columns ?? {}).map((name) => name.toLowerCase()),
      );
      if (!live) missing.push(schema.tableName);
      else
        for (const column of Object.keys(schema.columns))
          if (!columns.has(physical(column).toLowerCase()))
            missing.push(`${schema.tableName}.${column}`);
    }
    if (missing.length) {
      storageMismatch.push(...models);
      throw new Error(
        `MODEL_MIGRATION_REQUIRED: storage does not match the app models (missing ${missing.join(', ')}); run the operator migration (smrt db:migrate) and reopen the editor`,
      );
    }
  }

  await withRuntimeSchemaActivation(async () => {
    // Boots are serialized here; check again, so two editors constructed at
    // the same time cannot both register over each other.
    assertSoleEditor();
    const started = performance.now();
    let restore = () => {};
    const readiness = new Map<string, boolean | undefined>();
    const checkpoint = () => {
      const held = identities(active(storage(), doc));
      for (const id of held) readiness.set(id, getRuntimeModelReadiness(id));
      restore = ObjectRegistry.checkpointRegistrations(held);
    };
    try {
      if (engine === 'postgres') {
        await store.transaction!(async (scoped, db) => {
          const scopedReader = journalReader(scoped);
          history = await (scopedReader ? scopedReader.light() : scoped.read());
          revision = history.at(-1)?.revision ?? 0;
          doc = checked(
            repairLayoutLabels(history.at(-1)?.after ?? options.cookbook),
          );
          await journalInitial(scoped);
          await validate(
            doc,
            storageModels(history.flatMap((row) => [row.before, row.after])),
          );
          checkpoint();
          const changed = bootChanges();
          await activate(doc, active(storage(), doc), changed, db, false);
          await verifyStorage(
            db,
            changedModels(undefined, active(storage(), doc)),
            changed,
          );
        });
      } else {
        await journalInitial(store);
        await validate(
          doc,
          storageModels(history.flatMap((row) => [row.before, row.after])),
        );
        checkpoint();
        const changed = bootChanges();
        await activate(doc, active(storage(), doc), changed, options.db, false);
        await verifyStorage(
          options.db,
          changedModels(undefined, active(storage(), doc)),
          changed,
        );
      }
    } catch (error) {
      // The surrounding transaction can fail while committing, after the
      // migration callback itself succeeded. Restore that boundary too.
      restore();
      for (const [id, value] of readiness)
        setRuntimeModelReadiness([id], value);
      // Models whose storage is incomplete stay closed until the operator
      // migration runs and the editor reopens.
      if (storageMismatch.length)
        setRuntimeModelReadiness(
          storageMismatch.flatMap((id) => [
            id,
            `${options.packageName}:${id.split(':').at(-1)}`,
          ]),
          false,
        );
      throw recoveryHint(error);
    }
    try {
      await publish();
    } catch (error) {
      throw recoveryHint(error);
    }
    if (history.at(-1)?.status === 'pending') {
      const pending = history.at(-1)!;
      const receipt = receiptFor(
        projection(),
        JSON.parse(pending.command),
        performance.now() - started,
      );
      await store.complete(
        revision,
        receipt.elapsedMs,
        receipt,
        appOperationResult(pending.operation, receipt),
      );
      const row = await completedRow(pending.requestId, pending.revision);
      await adoptWinner(row, receipt);
      history = [
        ...history.slice(0, -1),
        {
          ...pending,
          status: 'applied',
          elapsedMs: row.elapsedMs ?? receipt.elapsedMs,
        },
      ];
    }
    release(active(storage(), doc));
  });

  /**
   * Undo and import can bring back recipes a lazy host has not loaded. With a
   * coordinator, activate the models the restored cookbook covers first, so
   * they are loaded, migrated and ready before the edit applies. Admission
   * comes first: a refused caller or a stale request loads nothing, and a
   * retry reaches its stored receipt without activation. This runs outside
   * the activation queue the edit itself takes (the coordinator queues there).
   */
  async function activateRestored(
    edit: AppModelEdit,
    context: AppModelEditContext,
  ) {
    if (!options.activation || (edit.type !== 'undo' && edit.type !== 'import'))
      return;
    if (
      context.tenantId !== options.tenantId ||
      !context.actor ||
      !context.requestId ||
      !(await options.authorize(context))
    )
      throw new Error('MODEL_EDIT_FORBIDDEN');
    if (await findRow(context.requestId)) return;
    if (!ready || context.expectedRevision !== revision) return;
    let target: Cookbook | undefined;
    if (edit.type === 'import') {
      const result = validateCookbook(edit.cookbook);
      if (!result.ok) return; // the edit refuses it
      target = result.cookbook;
    } else {
      const undone = new Set(
        history.flatMap((row) =>
          row.undoes === undefined || row.abandoned ? [] : [row.undoes],
        ),
      );
      target = history.findLast(
        (row) =>
          row.status === 'applied' &&
          !row.abandoned &&
          row.undoes === undefined &&
          !undone.has(row.revision),
      )?.before;
    }
    if (!target) return;
    const models = target.models;
    const lists = new Set(
      Object.keys(models?.lists ?? {}).map(
        (name) => `${models?.packageName}:${name}`,
      ),
    );
    try {
      await options.activation.activate(
        [...coveredModels(options.catalog, target)].filter(
          (id) => !lists.has(id),
        ),
      );
    } catch (error) {
      throw new Error(
        `MODEL_ACTIVATION_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function apply(
    edit: AppModelEdit,
    context: AppModelEditContext,
  ): Promise<AppModelEditReceipt> {
    edit = structuredClone(edit);
    context = structuredClone(context);
    const execute = async () => {
      assertSoleEditor();
      if (
        context.tenantId !== options.tenantId ||
        !context.actor ||
        !context.requestId ||
        !(await options.authorize(context))
      )
        throw new Error('MODEL_EDIT_FORBIDDEN');
      if (
        context.operation &&
        (!store.supportsDurableOperations || !context.operation.result)
      )
        throw new Error('MODEL_DURABLE_OPERATIONS_UNSUPPORTED');
      const tip = await latestRow();
      const print = JSON.stringify(edit);
      if ('model' in edit) {
        const name = edit.model.split(':').at(-1)!;
        const listName =
          edit.model.startsWith(`${options.packageName}:`) &&
          Object.hasOwn(doc.models?.lists ?? {}, name)
            ? name
            : undefined;
        const upstream = ObjectRegistry.getExposureModel(
          edit.model,
        )?.replacedQualifiedNames?.find((id) =>
          options.catalog.models.some((model) => model.id === id),
        );
        edit = { ...edit, model: listName ?? upstream ?? edit.model };
      }
      const replay = await findRow(context.requestId);
      if (replay) {
        if (replay.command !== print || replay.actor !== context.actor)
          throw new Error('MODEL_REQUEST_ID_REUSED');
        if (replay.status === 'pending')
          throw new Error(
            'MODEL_ACTIVATION_PENDING: reopen the editor to recover',
          );
        if (replay.abandoned)
          throw new Error(
            `MODEL_REVISION_ABANDONED: revision ${replay.revision} was abandoned and never applied`,
          );
        if (context.operation) {
          const recovered = await recover(context);
          if (!recovered) throw new Error('MODEL_RESULT_UNAVAILABLE');
          return { ...recovered.receipt!, replayed: true };
        }
        return {
          ...(replay.receipt ?? snapshot()),
          path: ['label_field', 'hide_field', 'remove_field'].includes(
            edit.type,
          )
            ? ('policy' as const)
            : ('runtime' as const),
          elapsedMs: replay.elapsedMs ?? 0,
          replayed: true,
        };
      }
      if (!ready || tip?.status === 'pending')
        throw new Error('MODEL_ACTIVATION_PENDING');
      if (
        context.expectedRevision !== revision ||
        (tip?.revision ?? 0) !== revision
      )
        throw new Error('MODEL_EDIT_CONFLICT');
      // From here the in-memory journal equals the durable one: another
      // process's revision would have moved the tip.
      const latest = history;
      const before = structuredClone(doc);
      let next = structuredClone(doc);
      next.models ??= {
        version: 1,
        packageName: options.packageName,
        lists: {},
        fields: {},
      };
      const models = next.models;
      let undoes: number | undefined;
      switch (edit.type) {
        case 'create_list':
          if (!isCustomIdentifier(edit.name, true))
            throw new Error('MODEL_NAME_RESERVED');
          if (models.lists[edit.name]) throw new Error('MODEL_NAME_COLLISION');
          models.lists[edit.name] = structuredClone(edit.list);
          next.features = [
            ...new Set([...next.features, effectiveId(edit.name)]),
          ];
          for (const [fieldName, label] of Object.entries(
            edit.fieldLabels ?? {},
          )) {
            if (!Object.hasOwn(edit.list.fields, fieldName))
              throw new Error('FIELD_NOT_FOUND');
            next.policies.push({
              objectRef: effectiveId(edit.name),
              fieldName,
              scopeType: 'app',
              label,
            });
          }
          break;
        case 'relabel_list':
          if (Object.hasOwn(models.lists, edit.name))
            models.lists[edit.name] = {
              ...models.lists[edit.name],
              label: edit.label,
              ...(edit.icon !== undefined ? { icon: edit.icon } : {}),
            };
          else if (!coveredModels(options.catalog, next).has(edit.name))
            throw new Error('MODEL_NOT_FOUND');
          {
            const id = Object.hasOwn(models.lists, edit.name)
              ? effectiveId(edit.name)
              : edit.name;
            const catalog = cookbookModelCatalog(options.catalog, models);
            const parts = modelParts(catalog, id);
            const keys = options.catalog.recipes.flatMap((recipe) =>
              recipe.nav
                .filter((entry) => entry.model === id)
                .map((entry) => entry.key),
            );
            next.layout ??= { version: 1 };
            next.layout.items ??= {};
            for (const key of new Set([undefined, ...keys])) {
              const itemId = navItemId(parts.packageId, parts.name, key);
              next.layout.items[itemId] = {
                ...next.layout.items[itemId],
                label: edit.label,
                ...(edit.icon !== undefined ? { icon: edit.icon } : {}),
              };
            }
          }
          break;
        case 'remove_list':
          if (!Object.hasOwn(models.lists, edit.name))
            throw new Error('MODEL_NOT_FOUND');
          {
            const removedId = effectiveId(edit.name);
            next.features = next.features.filter((id) => id !== removedId);
          }
          break;
        case 'add_field': {
          if (!isCustomIdentifier(edit.name) || isReservedFieldName(edit.name))
            throw new Error(
              `FIELD_NAME_RESERVED: ${edit.name}; choose a descriptive name such as sortOrder, groupName, fromDate or toDate (unquoted SDK columns, sdk#1513)`,
            );
          if (
            !Object.hasOwn(models.lists, edit.model) &&
            !new RegExp(CUSTOM_MODEL_REF).test(edit.model)
          )
            throw new Error('MODEL_NOT_IN_APP');
          if (!Object.hasOwn(models.lists, edit.model))
            models.fields[edit.model] ??= {};
          const fields = Object.hasOwn(models.lists, edit.model)
            ? models.lists[edit.model].fields
            : models.fields[edit.model];
          if (Object.hasOwn(fields, edit.name))
            throw new Error('FIELD_NAME_COLLISION');
          fields[edit.name] = structuredClone(edit.field);
          if (edit.label !== undefined)
            next.policies.push({
              objectRef: effectiveId(edit.model),
              fieldName: edit.name,
              scopeType: 'app',
              label: edit.label,
            });
          break;
        }
        case 'label_field':
        case 'hide_field':
        case 'remove_field': {
          const id = effectiveId(edit.model);
          const engine = createCookbookEngine({
            catalog: cookbookModelCatalog(options.catalog, models),
            cookbook: next,
          });
          const policyCommand = {
            name: 'set_policy',
            input: {
              model: id,
              field: edit.name,
              ...(edit.type === 'label_field'
                ? { label: edit.label }
                : {
                    visibility:
                      edit.type === 'hide_field' && !edit.hidden
                        ? 'basic'
                        : 'hidden',
                  }),
            },
          } as const;

          const logicalField =
            models.lists[edit.model]?.fields[edit.name] ??
            models.fields[edit.model]?.[edit.name];
          const result =
            logicalField?.type === 'money' && edit.type !== 'label_field'
              ? engine.batch({
                  commands: [
                    policyCommand,
                    {
                      ...policyCommand,
                      input: {
                        ...policyCommand.input,
                        field: `${edit.name}Currency`,
                      },
                    },
                  ],
                })
              : engine.run(policyCommand);
          if (!result.ok) throw new Error(result.error.message);
          next = engine.cookbook();
          break;
        }
        case 'import':
          next = checked(edit.cookbook);
          break;
        case 'undo': {
          const undone = new Set(
            latest.flatMap((row) =>
              row.undoes === undefined || row.abandoned ? [] : [row.undoes],
            ),
          );
          const previous = latest.findLast(
            (row) =>
              row.status === 'applied' &&
              !row.abandoned &&
              row.undoes === undefined &&
              !undone.has(row.revision),
          );
          if (!previous) throw new Error('MODEL_UNDO_EMPTY');
          next = structuredClone(
            repairLayoutLabels(previous.before) as Cookbook,
          );
          undoes = previous.revision;
          break;
        }
        default:
          throw new Error('UNKNOWN_MODEL_EDIT');
      }
      next = checked(next);
      const archived = storage();
      await validate(next, archived, options.db);
      // A removed/undone field keeps its stored definition, hidden through the existing policy rail.
      for (const [model, fields] of Object.entries(archived?.fields ?? {}))
        for (const name of Object.entries(fields).flatMap(([name, field]) => [
          name,
          ...(field.type === 'money' ? [`${name}Currency`] : []),
        ]))
          if (
            !next.models?.fields[model]?.[name] &&
            !(
              name.endsWith('Currency') &&
              next.models?.fields[model]?.[name.slice(0, -8)]?.type === 'money'
            )
          ) {
            next.policies = next.policies.filter(
              (row) => row.objectRef !== model || row.fieldName !== name,
            );
            next.policies.push({
              objectRef: model,
              fieldName: name,
              scopeType: 'app',
              visibility: 'hidden',
            });
          }
      for (const [listName, list] of Object.entries(archived?.lists ?? {}))
        for (const name of Object.entries(list.fields).flatMap(
          ([name, field]) => [
            name,
            ...(field.type === 'money' ? [`${name}Currency`] : []),
          ],
        ))
          if (
            !next.models?.lists[listName]?.fields[name] &&
            !(
              name.endsWith('Currency') &&
              next.models?.lists[listName]?.fields[name.slice(0, -8)]?.type ===
                'money'
            )
          ) {
            const objectRef = `${options.packageName}:${listName}`;
            next.policies = next.policies.filter(
              (row) => row.objectRef !== objectRef || row.fieldName !== name,
            );
            next.policies.push({
              objectRef,
              fieldName: name,
              scopeType: 'app',
              visibility: 'hidden',
            });
          }
      const began = performance.now();
      const change: AppModelChange = {
        revision: revision + 1,
        requestId: context.requestId,
        actor: context.actor,
        command: print,
        before,
        after: next,
        status: 'pending',
        ...(undoes ? { undoes } : {}),
        ...(context.operation
          ? { operation: structuredClone(context.operation) }
          : {}),
      };
      const previous = { history, revision, doc, ready };
      const union = storageModels([next], storage());
      const all = active(union, next);
      const changed = changedModels(active(archived, doc), all);
      const held = identities(all);
      const readiness = new Map(
        held.map((id) => [id, getRuntimeModelReadiness(id)]),
      );
      let restore = () => {};
      const rollback = () => {
        restore();
        ({ history, revision, doc, ready } = previous);
        for (const [id, value] of readiness)
          setRuntimeModelReadiness([id], value);
      };
      if (engine === 'postgres') {
        try {
          await store.transaction!(async (scoped, db) => {
            // Check new tables again under the shared lock every journal's
            // edit takes, so two processes on different journals cannot both
            // claim a table that was absent when they validated.
            await validate(next, archived, db);
            // Claim before touching the registry. The lock and this CAS fence
            // every process, including two editors created at the same revision.
            await scoped.append(change, revision);
            restore = ObjectRegistry.checkpointRegistrations(held);
            history = [...latest, change];
            revision = change.revision;
            await activate(next, all, changed, db, false);
          });
        } catch (error) {
          rollback();
          throw error;
        }
      } else {
        // Register and plan BEFORE journalling: a refused migration (manual
        // drift on an edited table) leaves no pending revision behind.
        let tables: Set<string>;
        try {
          restore = ObjectRegistry.checkpointRegistrations(held);
          register(all);
          tables = tablesOf(changed);
          await plan(options.db, tables);
          await store.append(change, revision);
        } catch (error) {
          rollback();
          throw error;
        }
        history = [...latest, change];
        revision = change.revision;
        // From here a failure stays pending and closed; reopen recovers it.
        await migrate(options.db, tables);
        doc = structuredClone(next);
      }
      storageMemo = { history, doc, value: union };
      // Schema + pending history are durable before any external publication.
      // A callback failure stays pending and closed, and boot retries it.
      await publish();
      const elapsedMs = performance.now() - began;
      const receipt = receiptFor(projection(), edit, elapsedMs);
      await store.complete(
        revision,
        elapsedMs,
        receipt,
        appOperationResult(change.operation, receipt),
      );
      const row = await completedRow(change.requestId, change.revision);
      // A first completion elsewhere wins: install it before readiness opens,
      // then notify and return it.
      const winner = await adoptWinner(row, receipt);
      const won = winner ? row.receipt : undefined;
      history = history.map((entry) =>
        entry.revision === change.revision
          ? {
              ...entry,
              status: 'applied' as const,
              elapsedMs: row.elapsedMs ?? elapsedMs,
            }
          : entry,
      );
      storageMemo = { history, doc, value: union };
      release(active(storage(), doc));
      const result: AppModelSnapshot = snapshot();
      for (const listener of listeners) {
        try {
          listener(result);
        } catch {
          /* Transport subscriber cannot undo a committed revision. */
        }
      }
      return structuredClone(won ?? receipt);
    };
    const operation = tail.then(async () => {
      await activateRestored(edit, context);
      return withRuntimeSchemaActivation(execute);
    });
    tail = operation.then(
      () => {},
      () => {},
    );
    return operation;
  }
  return {
    /** Server transports reuse the exact editor database, including in-memory SQLite. */
    get application() {
      return options.application;
    },
    get supportsDurableOperations() {
      return store.supportsDurableOperations === true;
    },
    recover,
    get database() {
      return options.db;
    },
    apply,
    snapshot,
    export: () => JSON.stringify(snapshot().cookbook, null, 2),
    history: () => store.read(),
    subscribe(listener: (snapshot: AppModelSnapshot) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
