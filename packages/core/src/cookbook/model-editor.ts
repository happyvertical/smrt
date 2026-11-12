/** The app model editor: cookbook source, durable revisions, tracked DDL, live publication. */

import type {
  Cookbook,
  CookbookCustomList,
  CookbookModelField,
  CookbookModels,
} from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { withRuntimeSchemaActivation } from '../activation.js';
import { getRuntimeManifest } from '../generators/rest.js';
import { stableStringify } from '../knowledge-graph.js';
import {
  getPendingSchemaStatements,
  migrateSmrtSchemas,
} from '../migrations/orchestrate.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry } from '../registry.js';
import {
  getRuntimeModelReadiness,
  notifyRuntimeExposureChanged,
  setRuntimeModelReadiness,
} from '../runtime-exposure.js';
import {
  type RuntimeFieldDefinition,
  registerRuntimeModel,
  runtimeModelEntry,
} from '../runtime-model.js';
import type { SmartObjectManifest } from '../scanner/types.js';
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
} from './model-history.js';
import {
  CUSTOM_MODEL_REF,
  cookbookModelCatalog,
  isCustomIdentifier,
  validateCookbookModels,
} from './models.js';
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
): CookbookModels | undefined {
  let result: CookbookModels | undefined;
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
  const store = options.store ?? (await createAppModelHistory(options));
  if (engine === 'postgres' && !store.transaction)
    throw new Error(
      'MODEL_HISTORY_TRANSACTION_REQUIRED: PostgreSQL history must bind revision CAS and migration DDL to one locked transaction',
    );
  let history = await store.read();
  let revision = history.at(-1)?.revision ?? 0;
  let doc = checked(history.at(-1)?.after ?? options.cookbook);
  let ready = false;
  let tail = Promise.resolve();
  const listeners = new Set<(snapshot: AppModelSnapshot) => void>();
  const effectiveId = (model: string) =>
    model.includes(':') ? model : `${options.packageName}:${model}`;
  const documents = () => [
    ...history.flatMap((row) => [row.before, row.after]),
    doc,
  ];
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

  async function validate(doc: Cookbook, archived?: CookbookModels) {
    if (!doc.models) return;
    const models = doc.models;
    if (models.packageName !== options.packageName)
      throw new Error(
        'MODEL_PACKAGE_CONFLICT: import uses a different app package identity',
      );
    const errors = validateCookbookModels(models);
    if (errors.length)
      throw new Error(errors.map((e) => `${e.path}: ${e.message}`).join('; '));
    const used = coveredModels(options.catalog, doc);
    for (const target of Object.keys(models.fields))
      if (!used.has(target) || !ObjectRegistry.getClass(target))
        throw new Error(`MODEL_NOT_IN_APP: ${target}`);
    const names = new Set<string>();
    for (const target of Object.keys(models.fields)) {
      const name = target.split(':').at(-1)!;
      if (names.has(name)) throw new Error(`APP_MODEL_NAME_COLLISION: ${name}`);
      names.add(name);
    }
    const tables = new Set<string>();
    for (const [name, list] of Object.entries(models.lists)) {
      if (names.has(name)) throw new Error(`MODEL_NAME_COLLISION: ${name}`);
      names.add(name);
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
      for (const existing of ObjectRegistry.getAllClasses().values())
        if (
          ObjectRegistry.getTableName(
            existing.qualifiedName ?? existing.name,
          ) === table &&
          existing.qualifiedName !== `${models.packageName}:${name}`
        )
          throw new Error(`MODEL_TABLE_COLLISION: ${table}`);
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
        if (field.type === 'reference') {
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
    const archived = storageModels(documents());

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
        return {
          ...definition,
          customFields: [...new Set(customFields)],
          ...(item ? { label: item.label, icon: item.icon } : {}),
          fieldPolicies: Object.fromEntries(
            doc.policies
              .filter(
                (policy) =>
                  ids.includes(policy.objectRef) && policy.scopeType === 'app',
              )
              .map((policy) => [policy.fieldName, structuredClone(policy)]),
          ),
        };
      }),
    };
  }

  async function activate(
    target: Cookbook,
    all: CookbookModels | undefined,
    db = options.db,
    publishNow = true,
  ) {
    const held = identities(all);
    setRuntimeModelReadiness(held, false);
    ready = false;
    if (all) {
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
      for (const [model, fields] of Object.entries(all.fields))
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
      const tables = new Set(
        identities(all)
          .map((id) => ObjectRegistry.getTableName(id))
          .filter((name): name is string => !!name),
      );
      const pending = await getPendingSchemaStatements(db, {
        engineHint: engine,
        tables,
      });
      if (pending.hasManualDrift)
        throw new Error(
          `MODEL_MIGRATION_REQUIRED: ${JSON.stringify(pending.unactionableChanges)}`,
        );
      await migrateSmrtSchemas({
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
    }
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
  function snapshot(): AppModelSnapshot {
    if (!ready) throw new Error('MODEL_ACTIVATION_PENDING');
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
    const found = (await store.read()).find(
      (row) => row.requestId === context.requestId,
    );
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
    if (!found.receipt || !found.result)
      throw new Error('MODEL_RESULT_UNAVAILABLE');
    return structuredClone(found);
  }

  await withRuntimeSchemaActivation(async () => {
    const started = performance.now();
    if (engine === 'postgres') {
      let restore = () => {};
      try {
        await store.transaction!(async (scoped, db) => {
          history = await scoped.read();
          revision = history.at(-1)?.revision ?? 0;
          doc = checked(history.at(-1)?.after ?? options.cookbook);
          await validate(
            doc,
            storageModels(history.flatMap((row) => [row.before, row.after])),
          );
          restore = ObjectRegistry.checkpointRegistrations(
            identities(storageModels(documents())),
          );
          await activate(doc, storageModels(documents()), db, false);
        });
      } catch (error) {
        // The surrounding transaction can fail while committing, after the
        // migration callback itself succeeded. Restore that boundary too.
        restore();
        throw error;
      }
      await publish();
    } else {
      await validate(
        doc,
        storageModels(history.flatMap((row) => [row.before, row.after])),
      );
      await activate(doc, storageModels(documents()));
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
      history = await store.read();
    }
    release(storageModels(documents()));
  });

  async function apply(
    edit: AppModelEdit,
    context: AppModelEditContext,
  ): Promise<AppModelEditReceipt> {
    edit = structuredClone(edit);
    context = structuredClone(context);
    const execute = async () => {
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
      const latest = await store.read();
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
      const replay = latest.find((row) => row.requestId === context.requestId);
      if (replay) {
        if (replay.command !== print || replay.actor !== context.actor)
          throw new Error('MODEL_REQUEST_ID_REUSED');
        if (replay.status === 'pending')
          throw new Error(
            'MODEL_ACTIVATION_PENDING: reopen the editor to recover',
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
      if (!ready || latest.at(-1)?.status === 'pending')
        throw new Error('MODEL_ACTIVATION_PENDING');
      if (
        context.expectedRevision !== revision ||
        (latest.at(-1)?.revision ?? 0) !== revision
      )
        throw new Error('MODEL_EDIT_CONFLICT');
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
          if (!isCustomIdentifier(edit.name))
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
              row.undoes === undefined ? [] : [row.undoes],
            ),
          );
          const previous = latest.findLast(
            (row) =>
              row.status === 'applied' &&
              row.undoes === undefined &&
              !undone.has(row.revision),
          );
          if (!previous) throw new Error('MODEL_UNDO_EMPTY');
          next = structuredClone(previous.before);
          undoes = previous.revision;
          break;
        }
        default:
          throw new Error('UNKNOWN_MODEL_EDIT');
      }
      next = checked(next);
      const archived = storageModels(documents());
      await validate(next, archived);
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
      if (engine === 'postgres') {
        const previous = { history, revision, doc, ready };
        const all = storageModels([...documents(), next]);
        const held = identities(all);
        const readiness = new Map(
          held.map((id) => [id, getRuntimeModelReadiness(id)]),
        );
        let restore = () => {};
        try {
          await store.transaction!(async (scoped, db) => {
            // Claim before touching the registry. The lock and this CAS fence
            // every process, including two editors created at the same revision.
            await scoped.append(change, revision);
            restore = ObjectRegistry.checkpointRegistrations(held);
            history = [...latest, change];
            revision = change.revision;
            await activate(next, all, db, false);
          });
        } catch (error) {
          restore();
          ({ history, revision, doc, ready } = previous);
          for (const [id, value] of readiness)
            setRuntimeModelReadiness([id], value);
          throw error;
        }
        // Schema + pending history are durable before any external publication.
        // A callback failure stays pending and closed, and boot retries it.
        await publish();
      } else {
        await store.append(change, revision);
        history = [...latest, change];
        revision = change.revision;
        await activate(next, storageModels([...documents(), next]));
      }
      const elapsedMs = performance.now() - began;
      const receipt = receiptFor(projection(), edit, elapsedMs);
      await store.complete(
        revision,
        elapsedMs,
        receipt,
        appOperationResult(change.operation, receipt),
      );
      history = await store.read();
      release(storageModels(documents()));
      const result = snapshot();
      for (const listener of listeners) {
        try {
          listener(result);
        } catch {
          /* Transport subscriber cannot undo a committed revision. */
        }
      }
      return structuredClone(
        history.find((row) => row.revision === change.revision)?.receipt ??
          receipt,
      );
    };
    const operation = tail.then(() => withRuntimeSchemaActivation(execute));
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
