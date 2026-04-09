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
    .replace(/[_-]+/g, ' ')
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

  return `${capitalize(parsed.action)} ${humanizeResource(parsed.resource)}`;
}

function defaultPermissionDescription(slug: string): string {
  const parsed = parsePermissionSlug(slug);
  if (!parsed.isValid) {
    return `Allows ${slug}`;
  }

  return `Allows ${parsed.action} access for ${humanizeResource(parsed.resource).toLowerCase()}`;
}

function isCollectionManifestEntry(objectDef?: SmartObjectDefinition): boolean {
  return (
    objectDef?.extends === 'SmrtCollection' ||
    objectDef?.extendsTypeArg !== undefined
  );
}

function getCustomMethodExposureNames(config: unknown): Set<string> {
  if (!config || config === true || typeof config !== 'object') {
    return new Set();
  }

  const include = Array.isArray((config as { include?: string[] }).include)
    ? (config as { include?: string[] }).include
    : [];
  return new Set(include);
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
      `Invalid permission slug '${definition.slug}'. Expected 'resource.action'.`,
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

  async syncPermissionCatalog(): Promise<PermissionCatalogSyncResult> {
    const catalog = this.getCatalog();
    const permissions = await PermissionCollection.create(this.options);

    const created: string[] = [];
    const unchanged: string[] = [];
    const updated: string[] = [];

    for (const definition of catalog.permissions) {
      const existing = await permissions.findBySlug(definition.slug);
      if (!existing) {
        const permission = await permissions.create({
          category:
            definition.category ??
            parsePermissionSlug(definition.slug).resource,
          description: definition.description ?? '',
          name: definition.name ?? definition.slug,
          slug: definition.slug,
        });
        await permission.save();
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

    for (const metadata of ObjectRegistry.getAllObjectMetadata()) {
      const registered =
        ObjectRegistry.getClassByConstructor(metadata.constructor as any) ??
        ObjectRegistry.getClass(metadata.name);
      const manifestEntry = registered?.qualifiedName
        ? findManifestEntryByQualifiedName(registered.qualifiedName)
        : undefined;

      if (isCollectionManifestEntry(manifestEntry)) {
        continue;
      }

      const className = metadata.name;
      const qualifiedName = registered?.qualifiedName;
      const objectConfig = manifestEntry?.decoratorConfig ?? metadata.config;
      const rawCollection = (
        objectConfig as { collection?: unknown } | undefined
      )?.collection;
      const configuredCollection =
        typeof rawCollection === 'string' && rawCollection.length > 0
          ? rawCollection
          : undefined;
      const collection =
        configuredCollection ??
        manifestEntry?.collection ??
        deriveCollectionName(metadata.name);

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

      const customApiMethods = new Set<string>();
      const customCliMethods = getCustomMethodExposureNames(objectConfig.cli);
      const customMcpMethods = getCustomMethodExposureNames(objectConfig.mcp);
      const methodEntries = manifestEntry?.methods
        ? Object.values(manifestEntry.methods)
        : Array.from(metadata.methods.values());

      for (const method of methodEntries) {
        if (
          !method ||
          !method.name ||
          standardActions.includes(method.name) ||
          method.isPublic !== true
        ) {
          continue;
        }

        if (isOperationEnabled(objectConfig.api, method.name)) {
          customApiMethods.add(method.name);
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
