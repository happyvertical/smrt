/** Registry-driven minimum-data fixtures and persistence contracts. Vitest only. */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  isFrameworkBaseClass,
  ObjectRegistry,
  type SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, it } from 'vitest';
import { setupSmrtManifests } from './index.js';
import {
  type MinimalRowExpectedFailure,
  minimalRowExpectedFailures,
} from './minimal-row-expected-failures.js';
import { getTestManifestPath } from './test-db.js';

export type MinimalRow = Record<string, unknown>;

export interface MinimalRowOptions {
  /** Required when a required relationship needs a persisted parent. */
  db?: DatabaseInterface;
  /** Shared by required tenant fields on the row and its required parents. */
  tenantId?: string;
}

export interface MinimalRowTestOptions {
  /** Package directory. Defaults to the current Vitest project's directory. */
  root?: string;
}

type Registration = NonNullable<ReturnType<typeof ObjectRegistry.getClass>>;
type RegisteredField =
  Registration['fields'] extends Map<string, infer Field> ? Field : never;
type BuildContext = MinimalRowOptions & {
  ancestors: string[];
  /** One identity per named relationship target within this fixture's parent graph. */
  parents: Map<string, string>;
};

class RequiredFieldError extends Error {
  constructor(
    readonly model: string,
    readonly field: string,
    cause: unknown,
  ) {
    super(`Model ${model}: required field ${field}: ${errorText(cause)}`, {
      cause,
    });
  }
}

// These are framework-maintained values, not optional business data.
const systemFields = new Set([
  'id',
  'slug',
  'context',
  'created_at',
  'updated_at',
  'createdAt',
  'updatedAt',
  '_meta_type',
  '_meta_data',
]);

// Inferred return: an option a subclass cleared is `null` in `_meta` (#4942).
function fieldOptions(field: RegisteredField) {
  return { ...field._meta, ...field.options, ...field };
}

function required(
  model: string,
  name: string,
  field: RegisteredField,
): boolean {
  const options = fieldOptions(field);
  const tenancy = options.__tenancy;
  const scoped = ObjectRegistry.getClass(model)?.tenantScopedConfig;
  return (
    options.required === true ||
    (tenancy?.isTenantIdField === true && tenancy.mode === 'required') ||
    (scoped?.mode === 'required' && scoped.field === name)
  );
}

function isTenantField(
  model: string,
  name: string,
  field: RegisteredField,
): boolean {
  return (
    fieldOptions(field).__tenancy?.isTenantIdField === true ||
    ObjectRegistry.getClass(model)?.tenantScopedConfig?.field === name
  );
}

function sample(field: RegisteredField, populated = false): unknown {
  const options = fieldOptions(field);
  if (options.enum?.length) {
    const value = options.enum[0];
    if (
      (typeof value === 'number' &&
        (value < (options.min ?? -Infinity) ||
          value > (options.max ?? Infinity))) ||
      (typeof value === 'string' &&
        (value.length < (options.minLength ?? 0) ||
          value.length > (options.maxLength ?? Infinity)))
    ) {
      throw new Error(
        'The first enum value does not satisfy the declared bounds',
      );
    }
    return value;
  }
  switch (field.type) {
    case 'integer':
    case 'decimal': {
      const low =
        field.type === 'integer'
          ? Math.max(
              Number.MIN_SAFE_INTEGER,
              Math.ceil(options.min ?? -Infinity),
            )
          : (options.min ?? -Infinity);
      const high =
        field.type === 'integer'
          ? Math.min(
              Number.MAX_SAFE_INTEGER,
              Math.floor(options.max ?? Infinity),
            )
          : (options.max ?? Infinity);
      const value = Math.min(high, Math.max(low, 1));
      if (!Number.isFinite(value) || low > high) {
        throw new Error('No value satisfies the numeric bounds');
      }
      return value;
    }
    case 'boolean':
      return populated;
    case 'datetime':
      return new Date('2030-01-01T00:00:00.000Z');
    case 'json':
      return populated ? { minimal: true } : {};
    case 'oneToMany':
    case 'manyToMany':
      return [];
    default: {
      if (options.sqlType?.toUpperCase() === 'UUID') return randomUUID();
      const min = Math.max(1, Math.ceil(options.minLength ?? 1));
      const max = Math.floor(options.maxLength ?? Math.max(min, 7));
      if (min > max) throw new Error('No value satisfies the length bounds');
      return 'minimal'.repeat(Math.ceil(min / 7)).slice(0, max);
    }
  }
}

function registration(model: string): Registration {
  const found = ObjectRegistry.getClass(model);
  if (!found) throw new Error(`Model ${model}: not registered`);
  return found;
}

async function relatedModel(
  owner: Registration,
  field: RegisteredField,
): Promise<string> {
  const related = field.related;
  if (!related)
    throw new Error(`Unresolved required relationship on ${owner.name}`);
  if (related.includes(':') && !ObjectRegistry.hasClass(related)) {
    await ObjectRegistry.ensureManifestLoaded(related);
  }
  const found = related.includes(':')
    ? ObjectRegistry.getClass(related)
    : (owner.packageName &&
        ObjectRegistry.getClassInPackage(owner.packageName, related)) ||
      ObjectRegistry.getClass(related);
  if (!found) throw new Error(`Required parent ${related} is not registered`);
  return found.qualifiedName ?? found.name;
}

/** Build required input only. Required parents are saved on the supplied database. */
export async function buildMinimalRow(
  model: string,
  options: MinimalRowOptions = {},
): Promise<MinimalRow> {
  const fields = await ObjectRegistry.getAllFields(model);
  const tenant = [...fields].find(([name, field]) =>
    isTenantField(model, name, field),
  );
  return buildRow(model, {
    ...options,
    tenantId:
      options.tenantId ??
      (tenant && !required(model, tenant[0], tenant[1])
        ? undefined
        : randomUUID()),
    ancestors: [],
    parents: new Map(),
  });
}

async function buildRow(
  model: string,
  context: BuildContext,
): Promise<MinimalRow> {
  const owner = registration(model);
  const identity = owner.qualifiedName ?? owner.name;
  if (context.ancestors.includes(identity)) {
    throw new Error(
      `Model ${identity}: required foreign-key cycle: ${[...context.ancestors, identity].join(' -> ')}`,
    );
  }
  const fields = await ObjectRegistry.getAllFields(identity);
  if (
    context.tenantId === undefined &&
    [...fields].some(
      ([name, field]) =>
        isTenantField(identity, name, field) && required(identity, name, field),
    )
  ) {
    context = { ...context, tenantId: randomUUID() };
  }
  const row: MinimalRow = {};
  for (const [name, field] of fields) {
    const tenant = isTenantField(identity, name, field);
    // A required child may reference an optionally scoped parent. Its parent
    // must belong to the same tenant, rather than defaulting to global scope.
    const parentTenant =
      tenant && context.ancestors.length > 0 && context.tenantId !== undefined;
    if (
      systemFields.has(name) ||
      (!required(identity, name, field) && !parentTenant)
    )
      continue;
    try {
      if (isTenantField(identity, name, field)) {
        row[name] = context.tenantId;
      } else if (
        field.type === 'foreignKey' ||
        field.type === 'crossPackageRef'
      ) {
        row[name] = await parentId(owner, name, field, context);
      } else {
        row[name] = sample(field);
      }
    } catch (cause) {
      throw new RequiredFieldError(identity, name, cause);
    }
  }
  return row;
}

async function parentId(
  owner: Registration,
  name: string,
  field: RegisteredField,
  context: BuildContext,
): Promise<string | null> {
  if (!context.db)
    throw new Error('A database is needed to create the required parent');
  const target = await relatedModel(owner, field);
  // Preserve semantic roles: sellerTenantId and payerTenantId must be distinct,
  // while courseId on a child and on its revision names the same ancestor.
  const key = `${target}:${name}`;
  const existing = context.parents.get(key);
  if (existing) return existing;
  await loadConstructor(target);
  const parentRow = await buildRow(target, {
    ...context,
    ancestors: [...context.ancestors, owner.qualifiedName ?? owner.name],
  });
  const parents = await ObjectRegistry.getCollection(target, {
    db: context.db,
  });
  let parent: SmrtObject;
  try {
    parent = await parents.create(parentRow);
  } catch (cause) {
    throw new Error(
      `Model ${target}: required parent could not be saved: ${errorText(cause)}`,
      { cause },
    );
  }
  if (!parent.id)
    throw new Error(`Model ${target}: parent creation did not return an id`);
  context.parents.set(key, parent.id);
  return parent.id;
}

function sourcePath(file: string, root: string): string {
  if (isAbsolute(file) && existsSync(file)) return file;
  const src = file.replaceAll('\\', '/').lastIndexOf('/src/');
  if (src >= 0) return join(root, file.slice(src + 1));
  if (file.startsWith('src/')) return join(root, file);
  return resolve(root, file);
}

async function loadConstructor(model: string): Promise<void> {
  const found = registration(model);
  if (ObjectRegistry.hasRuntimeConstructor(model)) return;
  if (!found.sourceFilePath)
    throw new Error(`Model ${model}: manifest has no source path`);
  let root = process.cwd();
  if (found.packageName) {
    const workspace = join(
      root,
      '..',
      found.packageName.replace('@happyvertical/smrt-', ''),
    );
    if (existsSync(join(workspace, 'package.json'))) root = workspace;
  }
  const module = await import(
    /* @vite-ignore */ sourcePath(found.sourceFilePath, root)
  );
  if (
    !ObjectRegistry.hasRuntimeConstructor(model) &&
    typeof module[found.name] === 'function'
  ) {
    // Undecorated subclasses and collections are legitimate manifest entries.
    smrt({ ...found.config, packageName: found.packageName })(
      module[found.name] as typeof SmrtObject,
    );
  }
  // Collection registration belongs to the item model. Private helper
  // collections need no exported constructor; no row is instantiated for them.
  if (ObjectRegistry.isCollectionClass(model)) return;
  if (!ObjectRegistry.hasRuntimeConstructor(model)) {
    throw new Error(`Model ${model}: real constructor was not registered`);
  }
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return `${error.message}${error.cause ? `: ${errorText(error.cause)}` : ''}`;
}

function errorField(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const details = (error as Error & { details?: { field?: unknown } }).details;
  return typeof details?.field === 'string'
    ? details.field
    : errorField(error.cause);
}

function empty(value: unknown): boolean {
  return (
    value == null ||
    value === '' ||
    value === 0 ||
    value === false ||
    (Array.isArray(value) && value.length === 0) ||
    (typeof value === 'object' &&
      !(value instanceof Date) &&
      Object.keys(value).length === 0)
  );
}

class OptionalFieldError extends Error {
  constructor(
    readonly model: string,
    readonly field: string,
    detail: string,
    cause?: unknown,
  ) {
    super(`Model ${model}: optional field ${field} ${detail}`, { cause });
  }
}

async function exercise(model: string, populatedField?: string): Promise<void> {
  const classes = new Set<string>();
  const visited = new Set<string>();
  function includePackageTables(packageName: string | undefined): void {
    if (!packageName) return;
    for (const [name, entry] of ObjectRegistry.getAllClasses()) {
      if (
        entry.packageName === packageName &&
        !ObjectRegistry.isCollectionClass(name) &&
        !isFrameworkBaseClass(entry.name, entry.packageName) &&
        !/(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|test-support|fixtures|tests)\/)/.test(
          entry.sourceFilePath ?? '',
        )
      ) {
        classes.add(name);
      }
    }
  }
  async function includeRequiredParents(name: string): Promise<void> {
    if (visited.has(name)) return;
    visited.add(name);
    classes.add(name);
    await loadConstructor(name);
    const owner = registration(name);
    // Hooks may query sibling tables even when those tables contain no rows.
    // Prepare the package schema, while keeping seed data minimal.
    includePackageTables(owner.packageName);
    for (const [key, field] of await ObjectRegistry.getAllFields(name)) {
      if (
        !isTenantField(name, key, field) &&
        (field.type === 'foreignKey' || field.type === 'crossPackageRef')
      ) {
        if (required(name, key, field)) {
          await includeRequiredParents(await relatedModel(owner, field));
        } else {
          // Hooks may inspect an empty optional reference. Prepare known
          // dependency tables, without loading unused optional dependencies.
          const target =
            field.related &&
            (field.related.includes(':')
              ? ObjectRegistry.getClass(field.related)
              : (owner.packageName &&
                  ObjectRegistry.getClassInPackage(
                    owner.packageName,
                    field.related,
                  )) ||
                ObjectRegistry.getClass(field.related));
          if (target) {
            classes.add(target.qualifiedName ?? target.name);
            includePackageTables(target.packageName);
          }
        }
      }
    }
  }
  await includeRequiredParents(model);
  const populated =
    populatedField &&
    (await ObjectRegistry.getAllFields(model)).get(populatedField);
  if (
    populated &&
    !isTenantField(model, populatedField as string, populated) &&
    (populated.type === 'foreignKey' || populated.type === 'crossPackageRef')
  ) {
    await includeRequiredParents(
      await relatedModel(registration(model), populated),
    );
  }
  const db = await getTestDatabase({ type: 'sqlite', classes: [] });
  try {
    await getTestDatabase({
      db,
      classes: [...classes],
      includeSystemTables: false,
    });
    const fields = await ObjectRegistry.getAllFields(model);
    const row = await buildMinimalRow(model, { db });
    if (populatedField) {
      const field = fields.get(populatedField);
      if (!field)
        throw new Error(`Model ${model}: unknown field ${populatedField}`);
      row[populatedField] = isTenantField(model, populatedField, field)
        ? randomUUID()
        : field.type === 'foreignKey' || field.type === 'crossPackageRef'
          ? await parentId(registration(model), populatedField, field, {
              db,
              ancestors: [],
              tenantId: row[
                ObjectRegistry.getClass(model)?.tenantScopedConfig?.field ??
                  'tenantId'
              ] as string | undefined,
              parents: new Map(),
            })
          : sample(field, true);
    }
    const defaultsAt = Date.now();
    const defaultObject = new (registration(model).constructor)({ ...row, db });
    await defaultObject.initialize();
    const defaults = defaultObject as unknown as MinimalRow;
    const serializedDefaults = defaultObject.toJSON() as MinimalRow;
    const collection = await ObjectRegistry.getCollection(model, { db });
    // Collection.create() invokes the model's save(). A second save would test
    // updates and incorrectly reject append-only models.
    const created = await collection.create(row);
    const read = await collection.get({ id: created.id });
    if (!read)
      throw new Error(`Model ${model}: get did not return the saved row`);
    const listed = await collection.list({ where: { id: created.id } });
    if (!listed.some((item) => item.id === created.id)) {
      throw new Error(`Model ${model}: list did not return the saved row`);
    }
    for (const item of [read, ...listed]) {
      for (const [name, field] of fields) {
        if (
          name === populatedField ||
          systemFields.has(name) ||
          required(model, name, field) ||
          field.type === 'oneToMany' ||
          field.type === 'manyToMany' ||
          fieldOptions(field).transient
        )
          continue;
        const actual = (item as unknown as MinimalRow)[name];
        const serializedDefault =
          serializedDefaults[name] ??
          serializedDefaults[
            name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
          ];
        let serializedEmptyDefault = false;
        // JSON helpers can store an empty object/array as text. Compare to the
        // unsaved serializer's default, preserving nonempty text assertions.
        if (
          typeof actual === 'string' &&
          typeof serializedDefault === 'object' &&
          empty(serializedDefault)
        ) {
          try {
            serializedEmptyDefault = isDeepStrictEqual(
              JSON.parse(actual),
              serializedDefault,
            );
          } catch {
            /* Ordinary text stays text. */
          }
        }
        // A constructor's `new Date()` default is a clock value, not a literal.
        const dynamicDateDefault =
          defaults[name] instanceof Date &&
          actual instanceof Date &&
          actual.getTime() >= (defaults[name] as Date).getTime() &&
          actual.getTime() - (defaults[name] as Date).getTime() <=
            Date.now() - defaultsAt;
        if (
          !empty(actual) &&
          !isDeepStrictEqual(actual, defaults[name]) &&
          !isDeepStrictEqual(actual, fieldOptions(field).default) &&
          !dynamicDateDefault &&
          !serializedEmptyDefault
        ) {
          throw new OptionalFieldError(
            model,
            name,
            `read back populated: ${JSON.stringify(actual)}`,
          );
        }
      }
    }
  } finally {
    await db.close?.();
  }
}

/** Run the full contract, probing one optional input at a time on fresh databases. */
export async function assertMinimalRow(model: string): Promise<void> {
  try {
    await loadConstructor(model);
    await exercise(model);
  } catch (cause) {
    if (cause instanceof OptionalFieldError) throw cause;
    // A required parent or required value failed before optional inputs on
    // this model were used. Do not misattribute its field to this child.
    if (cause instanceof RequiredFieldError) throw cause;
    const message = errorText(cause);
    const fields = await ObjectRegistry.getAllFields(model);
    const optional = [...fields].filter(
      ([name, field]) =>
        (!systemFields.has(name) ||
          name === 'createdAt' ||
          name === 'updatedAt') &&
        !required(model, name, field),
    );
    const structuredField = errorField(cause);
    if (
      structuredField &&
      optional.some(([name]) => name === structuredField)
    ) {
      throw new OptionalFieldError(
        model,
        structuredField,
        `failed: ${message}`,
        cause,
      );
    }
    const named = optional.find(([name]) => {
      const snake = name.replace(
        /[A-Z]/g,
        (letter) => `_${letter.toLowerCase()}`,
      );
      return new RegExp(
        `\\b(?:field ['"]?(?:${name}|${snake})['"]?\\b|(?:${name}|${snake}) (?:is required|must|cannot|is invalid))`,
        'i',
      ).test(message);
    });
    if (named)
      throw new OptionalFieldError(
        model,
        named[0],
        `failed: ${message}`,
        cause,
      );
    for (const [name] of optional) {
      try {
        await exercise(model, name);
      } catch (probeError) {
        // Reaching the readback assertions proves that this input repaired
        // the original create/save/read/list failure, even if another field
        // now violates the empty/default contract.
        if (!(probeError instanceof OptionalFieldError)) continue;
      }
      throw new OptionalFieldError(
        model,
        name,
        `is needed by model code: ${message}`,
        cause,
      );
    }
    throw new Error(
      `Model ${model}: minimal row failed (optional field not determined): ${message}`,
      { cause },
    );
  }
}

/** Resolve a ledger field through required-parent metadata, never model code. */
async function ledgerField(
  model: string,
  path: string,
): Promise<RegisteredField | undefined> {
  const [name, ...rest] = path.split('.');
  const field = (await ObjectRegistry.getAllFields(model)).get(name);
  if (!field || !rest.length) return field;
  if (field.type !== 'foreignKey' && field.type !== 'crossPackageRef')
    return undefined;
  return ledgerField(
    await relatedModel(registration(model), field),
    rest.join('.'),
  );
}

/** Enforce a known finding without hiding changed failures or newly passing models. */
export async function checkMinimalRowExpectedFailure(
  model: string,
  expected: MinimalRowExpectedFailure | undefined,
  run: () => Promise<void> = () => assertMinimalRow(model),
): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (
      !expected ||
      expected.model !== model ||
      !errorText(error).includes(expected.error)
    )
      throw error;
    const kind = expected.kind ?? 'optional-field';
    if (kind === 'service-only') {
      if (expected.field !== '(service-only write)') throw error;
    } else {
      const paths = expected.field.split(',').map((path) => path.trim());
      if (
        error instanceof RequiredFieldError &&
        (error.model !== model ||
          !paths.every((path) => path.startsWith(`${error.field}.`)))
      )
        throw error;
      for (const path of paths) {
        const field = await ledgerField(model, path);
        // Nested JSON properties cannot be resolved by relationship metadata;
        // record their owning field (e.g. promotion) in the ledger instead.
        if (
          !field ||
          (kind === 'optional-field' && fieldOptions(field).required === true)
        )
          throw error;
      }
      if (
        error instanceof OptionalFieldError &&
        (error.model !== model || !paths.includes(error.field))
      )
        throw error;
    }
    return;
  }
  if (expected)
    throw new Error(
      `Model ${model}: ${expected.kind ?? 'optional-field'} ${expected.field} now passes; remove this entry from minimal-row-expected-failures.ts`,
    );
}

/** Register one test per local model. Call with top-level await in a test file. */
export async function registerMinimalRowTests(
  options: MinimalRowTestOptions = {},
): Promise<void> {
  const root = resolve(options.root ?? process.cwd());
  const packageName = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ).name as string;
  await setupSmrtManifests({ root });
  const manifest = JSON.parse(
    readFileSync(getTestManifestPath(root), 'utf8'),
  ) as {
    objects: Record<
      string,
      { className: string; packageName?: string; filePath?: string }
    >;
  };
  // Import models AND collections; metadata stubs do not exercise model code.
  const files = new Set(
    Object.values(manifest.objects)
      .filter(
        (entry) =>
          (!entry.packageName || entry.packageName === packageName) &&
          entry.filePath &&
          !/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry.filePath) &&
          !/(?:^|\/)(?:__tests__|test-support|fixtures|tests)\//.test(
            entry.filePath,
          ),
      )
      .flatMap((entry) =>
        entry.filePath ? [sourcePath(entry.filePath, root)] : [],
      ),
  );
  for (const file of [...files].sort()) await import(/* @vite-ignore */ file);
  const models = [...ObjectRegistry.getAllClasses()].filter(
    ([, entry]) => entry.packageName === packageName,
  );
  if (models.length === 0)
    throw new Error(`No registered models found for ${packageName}`);
  // Collections without their own decorator still carry custom create/list hooks.
  for (const [model, entry] of models) {
    if (
      ObjectRegistry.isCollectionClass(model) &&
      !isFrameworkBaseClass(entry.name, entry.packageName) &&
      entry.sourceFilePath &&
      !/(?:^|\/)(?:__tests__|test-support|fixtures|tests)\//.test(
        entry.sourceFilePath,
      )
    ) {
      await loadConstructor(model);
    }
  }
  const candidates = models.map(([model, entry]) => ({
    model,
    reason:
      entry.sourceFilePath &&
      /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:__tests__|test-support|fixtures|tests)\/)/.test(
        entry.sourceFilePath,
      )
        ? 'test fixture'
        : isFrameworkBaseClass(entry.name, entry.packageName)
          ? 'framework base'
          : ObjectRegistry.isCollectionClass(model)
            ? 'collection-only class'
            : entry.config.abstract
              ? 'abstract model'
              : undefined,
  }));
  const skipped = candidates
    .filter((entry) => entry.reason)
    .map((entry) => `${entry.model}: ${entry.reason}`);
  const localFailures = minimalRowExpectedFailures.filter((entry) =>
    entry.model.startsWith(`${packageName}:`),
  );
  for (const entry of localFailures) {
    if (
      !entry.reason.trim() ||
      !entry.error.trim() ||
      !candidates.some(
        (candidate) => candidate.model === entry.model && !candidate.reason,
      )
    ) {
      throw new Error(
        `Model ${entry.model}: remove this entry or provide its failure evidence; it is not a tested model`,
      );
    }
  }
  describe(`minimal rows: ${packageName}`, () => {
    for (const { model, reason } of candidates) {
      if (reason) {
        it.skip(`${model} (${reason})`, () => {});
        continue;
      }
      const expected = localFailures.find((entry) => entry.model === model);
      const contract =
        expected?.kind === 'service-only'
          ? 'service-only: refuses direct writes'
          : expected?.kind === 'needs-domain-value'
            ? 'needs-domain-value: preserves the specific domain refusal'
            : 'create, save, get, list with optional fields empty/default';
      it(`${model}: ${contract}`, async () => {
        await checkMinimalRowExpectedFailure(model, expected);
      });
    }
  });
  const counts = ['optional-field', 'service-only', 'needs-domain-value'].map(
    (kind) =>
      `${kind}=${localFailures.filter((entry) => (entry.kind ?? 'optional-field') === kind).length}`,
  );
  console.info(
    `[minimal-row] findings: ${counts.join('; ')}\n` +
      `[minimal-row] ${packageName}: ${candidates.length - skipped.length} tested; ${skipped.length} skipped${skipped.length ? `\n${skipped.join('\n')}` : ''}`,
  );
}
