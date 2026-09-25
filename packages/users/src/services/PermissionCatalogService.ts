/**
 * Manifest-derived permission cataloging and syncing
 * @packageDocumentation
 */

import { getPackageConfig } from '@happyvertical/smrt-config';
import {
  findManifestEntryByQualifiedName,
  ObjectRegistry,
  type SmartObjectDefinition,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { PermissionCollection } from '../collections/PermissionCollection.js';
import {
  isValidPermissionSlug,
  type Permission,
  parsePermissionSlug,
} from '../models/Permission.js';

export type PermissionCatalogSource = 'manifest' | 'config' | 'runtime';

export type PostgresPermissionAction =
  | 'SELECT'
  | 'INSERT'
  | 'UPDATE'
  | 'DELETE';

export interface PostgresPermissionBinding {
  action: Lowercase<PostgresPermissionAction> | PostgresPermissionAction;
  permission?: string;
  schemaName?: string;
  tableName: string;
  tenantField?: string;
}

export interface PermissionDefinition {
  category?: string;
  className?: string;
  collection?: string;
  description?: string;
  name?: string;
  postgres?: {
    bindings?: PostgresPermissionBinding[];
  };
  qualifiedName?: string;
  slug: string;
  source?: PermissionCatalogSource;
}

export interface PermissionCatalog {
  customPermissions: PermissionDefinition[];
  manifestPermissions: PermissionDefinition[];
  permissions: PermissionDefinition[];
  runtimePermissions: PermissionDefinition[];
}

export interface PermissionCatalogSyncResult {
  catalog: PermissionCatalog;
  created: string[];
  unchanged: string[];
  updated: string[];
}

export interface UsersConfig extends Record<string, unknown> {
  permissions?: {
    custom?: PermissionDefinition[];
    postgres?: {
      bindings?: PostgresPermissionBinding[];
      enabled?: boolean;
    };
  };
}

export interface ConstructorLike {
  name?: string;
}

export interface CollectionLike {
  getItemClass?: () => ConstructorLike;
}

export type OperationPermissionCollectionInput =
  | string
  | ConstructorLike
  | CollectionLike
  | object;

declare global {
  // eslint-disable-next-line no-var
  var __smrtUsersPermissionRegistrations:
    | Map<number, PermissionDefinition[]>
    | undefined;
  // eslint-disable-next-line no-var
  var __smrtUsersPermissionRegistrationCounter: number | undefined;
}

function getRuntimePermissionRegistrations(): Map<
  number,
  PermissionDefinition[]
> {
  globalThis.__smrtUsersPermissionRegistrations ??= new Map<
    number,
    PermissionDefinition[]
  >();
  return globalThis.__smrtUsersPermissionRegistrations;
}

function toSnakeCase(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[-\s]+/g, '_')
    .toLowerCase();
}

function pluralize(word: string): string {
  if (word.endsWith('y') && !/[aeiou]y$/i.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }

  if (
    word.endsWith('s') ||
    word.endsWith('x') ||
    word.endsWith('z') ||
    word.endsWith('ch') ||
    word.endsWith('sh')
  ) {
    return `${word}es`;
  }

  return `${word}s`;
}

function deriveCollectionName(className: string): string {
  return pluralize(toSnakeCase(className));
}

function humanizeResource(resource: string): string {
  return resource
    .replace(/[._-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function capitalize(value: string): string {
  return `${value[0]?.toUpperCase() ?? ''}${value.slice(1)}`;
}

function defaultPermissionName(slug: string): string {
  const parsed = parsePermissionSlug(slug);
  if (!parsed.isValid) {
    return humanizeResource(slug);
  }

  return `${humanizeResource(parsed.action)} ${humanizeResource(parsed.resource)}`;
}

function defaultPermissionDescription(slug: string): string {
  const parsed = parsePermissionSlug(slug);
  if (!parsed.isValid) {
    return `Allows ${slug}`;
  }

  return `Allows ${humanizeResource(parsed.action).toLowerCase()} access for ${humanizeResource(parsed.resource).toLowerCase()}`;
}

export function normalizeOperationPermissionAction(action: string): string {
  const trimmed = action.trim();
  const lower = trimmed.toLowerCase();

  if (lower === 'list' || lower === 'get') {
    return 'read';
  }

  if (
    lower === 'read' ||
    lower === 'create' ||
    lower === 'update' ||
    lower === 'delete'
  ) {
    return lower;
  }

  return trimmed;
}

function isConstructorLike(value: unknown): value is ConstructorLike {
  return typeof value === 'function';
}

function isCollectionLike(value: unknown): value is CollectionLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CollectionLike).getItemClass === 'function'
  );
}

function resolveConstructor(
  value: OperationPermissionCollectionInput,
): ConstructorLike | undefined {
  if (isConstructorLike(value)) {
    return value;
  }

  if (isCollectionLike(value)) {
    return value.getItemClass?.();
  }

  if (typeof value === 'object' && value !== null) {
    const ctor = value.constructor;
    if (typeof ctor === 'function' && ctor.name && ctor.name !== 'Object') {
      return ctor;
    }
  }

  return undefined;
}

export function deriveOperationPermissionCollectionName(
  input: OperationPermissionCollectionInput,
): string {
  if (typeof input === 'string') {
    const collection = input.trim();
    if (!collection) {
      throw new Error('Operation permission collection must not be empty.');
    }
    return collection;
  }

  const ctor = resolveConstructor(input);
  if (!ctor?.name) {
    throw new Error(
      'Operation permission collection must be a collection slug, model class, model instance, or collection instance.',
    );
  }

  const registered =
    ObjectRegistry.getClassByConstructor(
      ctor as Parameters<typeof ObjectRegistry.getClassByConstructor>[0],
    ) ?? ObjectRegistry.getClass(ctor.name);
  if (!registered) {
    return deriveCollectionName(ctor.name);
  }

  // The catalog's resolution (explicit collection, manifest entry, STI base),
  // so an STI subtype never derives a slug the catalog does not list (#3125).
  // Only the last-resort fallback stays the guard's own: the registration's
  // collection.
  return resolveCollectionName(
    registered,
    manifestEntryFor(registered),
    (target) => target.collection ?? deriveCollectionName(target.name),
  );
}

export function deriveOperationPermissionSlug(
  collection: OperationPermissionCollectionInput,
  action: string,
): string {
  const collectionName = deriveOperationPermissionCollectionName(collection);
  const normalizedAction = normalizeOperationPermissionAction(action);
  if (!normalizedAction) {
    throw new Error('Operation permission action must not be empty.');
  }

  return `${collectionName}.${normalizedAction}`;
}

type RegisteredCatalogClass = NonNullable<
  ReturnType<typeof ObjectRegistry.getClass>
>;

function manifestEntryFor(
  registered: RegisteredCatalogClass,
): SmartObjectDefinition | undefined {
  return registered.qualifiedName
    ? findManifestEntryByQualifiedName(registered.qualifiedName)
    : undefined;
}

/**
 * The STI base of a registered class: its oldest registered prototype
 * ancestor declaring `tableStrategy: 'sti'` — the manifest generator's
 * `findSTIBase` rule. Ancestors resolve by constructor, so another package's
 * same-named class cannot stand in for the base.
 */
function registeredStiBase(
  registered: RegisteredCatalogClass,
): RegisteredCatalogClass | undefined {
  let base: RegisteredCatalogClass | undefined;
  for (
    let parent = Object.getPrototypeOf(registered.constructor);
    parent && parent !== Function.prototype;
    parent = Object.getPrototypeOf(parent)
  ) {
    const ancestor = ObjectRegistry.getClassByConstructor(parent);
    if (ancestor?.config?.tableStrategy === 'sti') base = ancestor;
  }
  return base === registered ? undefined : base;
}

/**
 * The permission collection of a registered class, shared by the catalog and
 * the operation guards (#3125): an explicit `collection`, then the manifest
 * entry's (the scanner gives an STI subtype its base's), then — for an STI
 * subtype with no manifest entry, as in a consumer bundle decorated before its
 * manifest loads — its STI base's. `fallback` names a class with none of
 * these; it differs between the catalog and the guards for historical slugs
 * and is deliberately left unchanged here.
 */
function resolveCollectionName(
  registered: RegisteredCatalogClass,
  manifestEntry: SmartObjectDefinition | undefined,
  fallback: (registered: RegisteredCatalogClass) => string,
): string {
  const objectConfig = manifestEntry?.decoratorConfig ?? registered.config;
  const rawCollection = (objectConfig as { collection?: unknown } | undefined)
    ?.collection;
  if (typeof rawCollection === 'string' && rawCollection.length > 0) {
    return rawCollection;
  }
  if (manifestEntry?.collection) return manifestEntry.collection;
  const stiBase = registeredStiBase(registered);
  return stiBase
    ? resolveCollectionName(stiBase, manifestEntryFor(stiBase), fallback)
    : fallback(registered);
}

function resolveCatalogCollectionName(
  registered: RegisteredCatalogClass,
  manifestEntry: SmartObjectDefinition | undefined,
): string {
  return resolveCollectionName(registered, manifestEntry, (target) =>
    deriveCollectionName(target.name),
  );
}

interface CatalogAncestor {
  entry: SmartObjectDefinition;
  registered: RegisteredCatalogClass;
}

function packagePrefix(qualifiedName: string | undefined): string | undefined {
  const separator = qualifiedName?.lastIndexOf(':') ?? -1;
  return qualifiedName && separator > 0
    ? qualifiedName.slice(0, separator)
    : undefined;
}

function findCatalogClass(
  name: string,
  nearQualifiedName: string | undefined,
): RegisteredCatalogClass | undefined {
  if (name.includes(':')) return ObjectRegistry.getClassByQualifiedName(name);
  const prefix = packagePrefix(nearQualifiedName);
  return (
    (prefix
      ? ObjectRegistry.getClassByQualifiedName(`${prefix}:${name}`)
      : undefined) ?? ObjectRegistry.getClass(name)
  );
}

/**
 * The class and its manifest ancestors, nearest first — mirroring the route
 * generator's collection-ancestry walk so an inherited collection class (one
 * that extends another collection without its own type argument) is detected
 * and resolved to the same item.
 */
function collectCatalogAncestry(
  registered: RegisteredCatalogClass,
  manifestEntry: SmartObjectDefinition | undefined,
): CatalogAncestor[] {
  const chain: CatalogAncestor[] = [];
  const seen = new Set<string>();
  let current: CatalogAncestor | undefined = manifestEntry
    ? { entry: manifestEntry, registered }
    : undefined;
  while (current && chain.length < 32) {
    const key = current.registered.qualifiedName ?? current.registered.name;
    if (seen.has(key)) break;
    seen.add(key);
    chain.push(current);
    const parentName =
      current.entry.extendsQualified || current.entry.extends || undefined;
    if (!parentName || parentName === 'SmrtCollection') break;
    const parent = findCatalogClass(
      parentName,
      current.registered.qualifiedName,
    );
    const parentEntry = parent?.qualifiedName
      ? findManifestEntryByQualifiedName(parent.qualifiedName)
      : undefined;
    current =
      parent && parentEntry
        ? { entry: parentEntry, registered: parent }
        : undefined;
  }
  return chain;
}

function isCollectionClass(
  registered: RegisteredCatalogClass,
  manifestEntry: SmartObjectDefinition | undefined,
): boolean {
  return collectCatalogAncestry(registered, manifestEntry).some(({ entry }) =>
    isCollectionManifestEntry(entry),
  );
}

function resolveCollectionItemRegistration(
  registered: RegisteredCatalogClass,
  manifestEntry: SmartObjectDefinition,
): RegisteredCatalogClass | undefined {
  const ancestry = collectCatalogAncestry(registered, manifestEntry);
  for (const { entry, registered: ancestor } of ancestry) {
    const typeArg = entry.extendsTypeArg;
    if (typeof typeArg === 'string' && typeArg.length > 0) {
      return findCatalogClass(typeArg, ancestor.qualifiedName);
    }
  }
  for (const { registered: ancestor } of ancestry) {
    if (!ancestor.name.endsWith('Collection')) continue;
    const item = findCatalogClass(
      ancestor.name.slice(0, -'Collection'.length),
      ancestor.qualifiedName,
    );
    if (item) return item;
  }
  return undefined;
}

function getCollectionClassActionDefinitions(
  registered: RegisteredCatalogClass,
  manifestEntry: SmartObjectDefinition | undefined,
  standardActions: readonly string[],
): PermissionDefinition[] {
  if (!manifestEntry) return [];
  const item = resolveCollectionItemRegistration(registered, manifestEntry);
  if (!item) return [];
  const itemEntry = item.qualifiedName
    ? findManifestEntryByQualifiedName(item.qualifiedName)
    : undefined;
  if (isCollectionClass(item, itemEntry)) return [];
  const collection = resolveCatalogCollectionName(item, itemEntry);
  const objectConfig = manifestEntry.decoratorConfig ?? registered.config;
  const methodEntries = manifestEntry.methods
    ? Object.values(manifestEntry.methods)
    : Array.from(registered.methods.entries());
  return getPublicCustomMethodNames(methodEntries, standardActions)
    .filter((methodName) => isOperationEnabled(objectConfig?.api, methodName))
    .map((methodName) => ({
      className: item.name,
      collection,
      description: `Allows ${methodName} on ${humanizeResource(collection).toLowerCase()}`,
      name: `${capitalize(methodName)} ${humanizeResource(collection)}`,
      qualifiedName: item.qualifiedName,
      slug: `${collection}.${methodName}`,
    }));
}

function isCollectionManifestEntry(objectDef?: SmartObjectDefinition): boolean {
  return (
    objectDef?.extends === 'SmrtCollection' ||
    objectDef?.extendsTypeArg !== undefined
  );
}

interface ManifestMethodCandidate {
  isPublic?: boolean;
  name?: string;
}

interface FieldReadPermissionCandidate {
  _meta?: {
    readPermission?: unknown;
  };
  readPermission?: unknown;
}

type MethodCandidate =
  | ManifestMethodCandidate
  | readonly [string, ManifestMethodCandidate];

function isMethodEntryTuple(
  method: MethodCandidate,
): method is readonly [string, ManifestMethodCandidate] {
  return Array.isArray(method);
}

function normalizeMethodCandidate(
  method: MethodCandidate,
): ManifestMethodCandidate {
  if (isMethodEntryTuple(method)) {
    const [name, definition] = method;
    return { ...definition, name: definition.name ?? name };
  }
  return method;
}

function getPublicCustomMethodNames(
  methodEntries: MethodCandidate[],
  standardActions: readonly string[],
): string[] {
  return Array.from(
    new Set(
      methodEntries.flatMap((method) => {
        const { isPublic, name } = normalizeMethodCandidate(method);
        if (!name || isPublic !== true || standardActions.includes(name)) {
          return [];
        }
        return [name];
      }),
    ),
  );
}

function getCustomMethodExposureNames(
  config: unknown,
  availableCustomMethods: string[],
): Set<string> {
  if (!config || config === false) {
    return new Set();
  }

  if (config === true || typeof config !== 'object') {
    return new Set(availableCustomMethods);
  }

  const rawInclude = (config as { include?: string[] }).include;
  const include = Array.isArray(rawInclude) ? [...rawInclude] : undefined;
  const rawExclude = (config as { exclude?: string[] }).exclude;
  const exclude: string[] = Array.isArray(rawExclude) ? [...rawExclude] : [];

  if (!include) {
    return new Set(
      availableCustomMethods.filter(
        (methodName) => !exclude.includes(methodName),
      ),
    );
  }

  const baseMethods = include.filter((methodName) =>
    availableCustomMethods.includes(methodName),
  );

  return new Set(
    baseMethods.filter((methodName) => !exclude.includes(methodName)),
  );
}

function isOperationEnabled(config: unknown, action: string): boolean {
  if (config === false) {
    return false;
  }

  if (config && typeof config === 'object') {
    const include = Array.isArray((config as { include?: string[] }).include)
      ? (config as { include?: string[] }).include
      : undefined;
    const rawExclude = (config as { exclude?: string[] }).exclude;
    const exclude: string[] = Array.isArray(rawExclude) ? [...rawExclude] : [];

    if (include && !include.includes(action)) {
      return false;
    }
    if (exclude.includes(action)) {
      return false;
    }
  }

  return true;
}

function normalizePostgresAction(
  action: PostgresPermissionBinding['action'],
): PostgresPermissionAction {
  const normalized = action.toUpperCase();
  if (
    normalized === 'SELECT' ||
    normalized === 'INSERT' ||
    normalized === 'UPDATE' ||
    normalized === 'DELETE'
  ) {
    return normalized;
  }

  throw new Error(
    `Unsupported Postgres permission action '${action}'. Expected SELECT, INSERT, UPDATE, or DELETE.`,
  );
}

function normalizeBinding(
  binding: PostgresPermissionBinding,
  fallbackPermission: string,
): PostgresPermissionBinding {
  return {
    action: normalizePostgresAction(binding.action),
    permission: binding.permission || fallbackPermission,
    schemaName: binding.schemaName,
    tableName: binding.tableName,
    tenantField: binding.tenantField,
  };
}

function mergeStringField(
  fieldName:
    | 'category'
    | 'className'
    | 'collection'
    | 'description'
    | 'name'
    | 'qualifiedName',
  existing: PermissionDefinition,
  incoming: PermissionDefinition,
  slug: string,
): void {
  const existingValue = existing[fieldName];
  const incomingValue = incoming[fieldName];

  if (!incomingValue) {
    return;
  }

  if (!existingValue) {
    existing[fieldName] = incomingValue;
    return;
  }

  if (existingValue !== incomingValue) {
    throw new Error(
      `Conflicting permission metadata for '${slug}' field '${fieldName}': '${existingValue}' !== '${incomingValue}'`,
    );
  }
}

function mergeBindings(
  existing: PermissionDefinition,
  incoming: PermissionDefinition,
): void {
  const existingBindings = existing.postgres?.bindings ?? [];
  const incomingBindings = incoming.postgres?.bindings ?? [];
  if (incomingBindings.length === 0) {
    return;
  }

  const seen = new Set(
    existingBindings.map((binding) =>
      [
        binding.permission,
        binding.action,
        binding.schemaName ?? '',
        binding.tableName,
        binding.tenantField ?? '',
      ].join('|'),
    ),
  );

  const mergedBindings = [...existingBindings];
  for (const binding of incomingBindings) {
    const normalized = normalizeBinding(binding, incoming.slug);
    const key = [
      normalized.permission,
      normalized.action,
      normalized.schemaName ?? '',
      normalized.tableName,
      normalized.tenantField ?? '',
    ].join('|');
    if (!seen.has(key)) {
      seen.add(key);
      mergedBindings.push(normalized);
    }
  }

  existing.postgres = {
    bindings: mergedBindings,
  };
}

function normalizeDefinition(
  definition: PermissionDefinition,
  source: PermissionCatalogSource,
): PermissionDefinition {
  if (!definition.slug || !isValidPermissionSlug(definition.slug.trim())) {
    throw new Error(
      `Invalid permission slug '${definition.slug}'. Expected 'resource.action[.scope...]'.`,
    );
  }

  const slug = definition.slug.trim();
  return {
    category: definition.category ?? parsePermissionSlug(slug).resource,
    className: definition.className,
    collection: definition.collection,
    description: definition.description ?? defaultPermissionDescription(slug),
    name: definition.name ?? defaultPermissionName(slug),
    postgres: definition.postgres?.bindings
      ? {
          bindings: definition.postgres.bindings.map((binding) =>
            normalizeBinding(binding, slug),
          ),
        }
      : undefined,
    qualifiedName: definition.qualifiedName,
    slug,
    source,
  };
}

function mergeDefinitionSet(
  current: Map<string, PermissionDefinition>,
  incomingDefinitions: PermissionDefinition[],
  source: PermissionCatalogSource,
): void {
  for (const rawDefinition of incomingDefinitions) {
    const definition = normalizeDefinition(rawDefinition, source);
    const existing = current.get(definition.slug);

    if (!existing) {
      current.set(definition.slug, definition);
      continue;
    }

    mergeStringField('category', existing, definition, definition.slug);
    mergeStringField('className', existing, definition, definition.slug);
    mergeStringField('collection', existing, definition, definition.slug);
    mergeStringField('description', existing, definition, definition.slug);
    mergeStringField('name', existing, definition, definition.slug);
    mergeStringField('qualifiedName', existing, definition, definition.slug);
    mergeBindings(existing, definition);
  }
}

export function registerPermissionDefinitions(
  definitions: PermissionDefinition[],
): () => void {
  globalThis.__smrtUsersPermissionRegistrationCounter =
    (globalThis.__smrtUsersPermissionRegistrationCounter ?? 0) + 1;
  const registrationId = globalThis.__smrtUsersPermissionRegistrationCounter;
  getRuntimePermissionRegistrations().set(registrationId, definitions);

  return () => {
    getRuntimePermissionRegistrations().delete(registrationId);
  };
}

export class PermissionCatalogService {
  constructor(private readonly options: SmrtClassOptions = {}) {}

  getUsersConfig(): UsersConfig {
    return getPackageConfig<UsersConfig>('users', {});
  }

  getRuntimePermissionDefinitions(): PermissionDefinition[] {
    return Array.from(getRuntimePermissionRegistrations().values()).flat();
  }

  getCustomPermissionDefinitions(): PermissionDefinition[] {
    return this.getUsersConfig().permissions?.custom ?? [];
  }

  getCatalog(): PermissionCatalog {
    const manifestPermissions = this.getManifestPermissionDefinitions();
    const customPermissions = this.getCustomPermissionDefinitions();
    const runtimePermissions = this.getRuntimePermissionDefinitions();

    const merged = new Map<string, PermissionDefinition>();
    mergeDefinitionSet(merged, manifestPermissions, 'manifest');
    mergeDefinitionSet(merged, customPermissions, 'config');
    mergeDefinitionSet(merged, runtimePermissions, 'runtime');

    return {
      customPermissions: customPermissions.map((definition) =>
        normalizeDefinition(definition, 'config'),
      ),
      manifestPermissions: manifestPermissions.map((definition) =>
        normalizeDefinition(definition, 'manifest'),
      ),
      permissions: Array.from(merged.values()).sort((left, right) =>
        left.slug.localeCompare(right.slug),
      ),
      runtimePermissions: runtimePermissions.map((definition) =>
        normalizeDefinition(definition, 'runtime'),
      ),
    };
  }

  deriveOperationPermissionSlug(
    collection: OperationPermissionCollectionInput,
    action: string,
  ): string {
    return deriveOperationPermissionSlug(collection, action);
  }

  hasPermissionSlug(slug: string): boolean {
    return this.getCatalog().permissions.some(
      (permission) => permission.slug === slug,
    );
  }

  async syncPermissionCatalog(): Promise<PermissionCatalogSyncResult> {
    const catalog = this.getCatalog();
    const permissions = await PermissionCollection.create(this.options);

    const created: string[] = [];
    const unchanged: string[] = [];
    const updated: string[] = [];

    // Load the live catalog in ONE read rather than a `findBySlug()` per
    // definition (#3022). The catalog is registry-derived, so its size grows
    // with every consumed package's object and action surface: on a consumer
    // app it is thousands of slugs, and a per-slug SELECT made this bootstrap
    // scale linearly with the registry — it is the dominant cost of a cold
    // first write, and it doubled between 0.51.7 and 0.51.11 purely because
    // the catalog grew. `list({})` applies no implicit bound (see
    // `applyListBounds`), so this is the whole table, exactly what the
    // per-slug probes collectively read.
    const existingBySlug = new Map<string, Permission>();
    for (const permission of await permissions.list({})) {
      if (typeof permission.slug === 'string' && permission.slug.length > 0) {
        existingBySlug.set(permission.slug, permission);
      }
    }

    for (const definition of catalog.permissions) {
      const existing = existingBySlug.get(definition.slug) ?? null;
      if (!existing) {
        // `collection.create()` already persists (it calls `save()`), so a
        // second `save()` here was a redundant UPDATE plus a second change-feed
        // append for every seeded row (#3022).
        const permission = await permissions.create({
          category:
            definition.category ??
            parsePermissionSlug(definition.slug).resource,
          description: definition.description ?? '',
          name: definition.name ?? definition.slug,
          slug: definition.slug,
        });
        // Keep the in-memory view authoritative: the removed per-slug read used
        // to see a row this same loop had just written, so a catalog carrying
        // the same slug twice must still resolve to one row.
        existingBySlug.set(definition.slug, permission);
        created.push(definition.slug);
        continue;
      }

      const nextName = definition.name ?? existing.name;
      const nextDescription = definition.description ?? existing.description;
      const nextCategory = definition.category ?? existing.category;

      if (
        existing.name === nextName &&
        existing.description === nextDescription &&
        existing.category === nextCategory
      ) {
        unchanged.push(definition.slug);
        continue;
      }

      existing.name = nextName;
      existing.description = nextDescription;
      existing.category = nextCategory;
      await existing.save();
      updated.push(definition.slug);
    }

    return {
      catalog,
      created,
      unchanged,
      updated,
    };
  }

  private getManifestPermissionDefinitions(): PermissionDefinition[] {
    const standardActions = ['list', 'get', 'create', 'update', 'delete'];
    const definitions = new Map<string, PermissionDefinition>();
    const seenRegistrations = new Set<object>();

    for (const [, registered] of ObjectRegistry.getAllClasses()) {
      // A source registration can retain its simple key while manifest
      // hydration adds its qualified key. Build the catalog once per concrete
      // registration, preserving package identity instead of a simple-name
      // first-match lookup.
      if (seenRegistrations.has(registered)) continue;
      seenRegistrations.add(registered);

      const manifestEntry = registered?.qualifiedName
        ? findManifestEntryByQualifiedName(registered.qualifiedName)
        : undefined;

      if (isCollectionClass(registered, manifestEntry)) {
        // Mutating custom API actions hosted on a collection class are
        // generated at the item collection's route and gated on
        // `<itemCollection>.<method>` (#2977), so catalog that slug here.
        for (const definition of getCollectionClassActionDefinitions(
          registered,
          manifestEntry,
          standardActions,
        )) {
          definitions.set(definition.slug, definition);
        }
        continue;
      }

      const className = registered.name;
      const qualifiedName = registered.qualifiedName;
      const objectConfig = manifestEntry?.decoratorConfig ?? registered.config;
      const collection = resolveCatalogCollectionName(
        registered,
        manifestEntry,
      );

      const readExposed =
        isOperationEnabled(objectConfig.api, 'list') ||
        isOperationEnabled(objectConfig.api, 'get') ||
        isOperationEnabled(objectConfig.cli, 'list') ||
        isOperationEnabled(objectConfig.cli, 'get') ||
        isOperationEnabled(objectConfig.mcp, 'list') ||
        isOperationEnabled(objectConfig.mcp, 'get');
      if (readExposed) {
        definitions.set(`${collection}.read`, {
          className,
          collection,
          qualifiedName,
          slug: `${collection}.read`,
        });
      }

      const fieldEntries = manifestEntry?.fields
        ? Object.entries(manifestEntry.fields)
        : Array.from(
            (registered.inheritedFields ?? registered.fields).entries(),
          );
      for (const [fieldName, fieldDef] of fieldEntries) {
        const field = fieldDef as FieldReadPermissionCandidate;
        const readPermission =
          typeof field.readPermission === 'string'
            ? field.readPermission
            : typeof field._meta?.readPermission === 'string'
              ? field._meta.readPermission
              : undefined;
        if (!readPermission || definitions.has(readPermission)) {
          continue;
        }
        definitions.set(readPermission, {
          className,
          collection,
          description: `Allows reading ${fieldName} on ${humanizeResource(collection).toLowerCase()}`,
          name: `Read ${humanizeResource(fieldName)} on ${humanizeResource(collection)}`,
          qualifiedName,
          slug: readPermission,
        });
      }

      for (const action of ['create', 'update', 'delete'] as const) {
        const exposed =
          isOperationEnabled(objectConfig.api, action) ||
          isOperationEnabled(objectConfig.cli, action) ||
          isOperationEnabled(objectConfig.mcp, action);
        if (!exposed) {
          continue;
        }

        definitions.set(`${collection}.${action}`, {
          className,
          collection,
          qualifiedName,
          slug: `${collection}.${action}`,
        });
      }

      const methodEntries = manifestEntry?.methods
        ? Object.values(manifestEntry.methods)
        : Array.from(registered.methods.entries());
      const publicCustomMethodNames = getPublicCustomMethodNames(
        methodEntries,
        standardActions,
      );
      const customApiMethods = new Set<string>();
      const customCliMethods = getCustomMethodExposureNames(
        objectConfig.cli,
        publicCustomMethodNames,
      );
      const customMcpMethods = getCustomMethodExposureNames(
        objectConfig.mcp,
        publicCustomMethodNames,
      );

      for (const methodName of publicCustomMethodNames) {
        if (isOperationEnabled(objectConfig.api, methodName)) {
          customApiMethods.add(methodName);
        }
      }

      const customMethods = new Set<string>([
        ...customApiMethods,
        ...customCliMethods,
        ...customMcpMethods,
      ]);

      for (const methodName of customMethods) {
        definitions.set(`${collection}.${methodName}`, {
          className,
          collection,
          description: `Allows ${methodName} on ${humanizeResource(collection).toLowerCase()}`,
          name: `${capitalize(methodName)} ${humanizeResource(collection)}`,
          qualifiedName,
          slug: `${collection}.${methodName}`,
        });
      }
    }

    return Array.from(definitions.values()).sort((left, right) =>
      left.slug.localeCompare(right.slug),
    );
  }

  static create(options: SmrtClassOptions = {}): PermissionCatalogService {
    return new PermissionCatalogService(options);
  }
}

export async function syncPermissionCatalog(
  options: SmrtClassOptions = {},
): Promise<PermissionCatalogSyncResult> {
  return PermissionCatalogService.create(options).syncPermissionCatalog();
}
