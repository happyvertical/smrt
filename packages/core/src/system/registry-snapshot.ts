/**
 * Sanitized, serializable snapshot of the booted `ObjectRegistry` (#1831).
 *
 * The registry holds live constructors, validators, tool payloads, and
 * absolute source paths. None of that may cross a process or wire boundary:
 * a development agent observing a booted runtime gets *this* DTO, built by
 * projection, never the raw `RegisteredClass`. Every value here is plain JSON
 * (strings, numbers, booleans, arrays, plain objects), which the test suite
 * asserts structurally rather than by allow-list alone.
 *
 * The snapshot is a read of in-process state: it never touches a database,
 * never boots project code, and never mutates the registry.
 */

import { relative, sep } from 'node:path';
import type { RegisteredClass, RegisteredField } from '../registry/types.js';
import { ObjectRegistry } from '../registry.js';
import type { MethodDefinition } from '../scanner/types.js';

/** Provenance label for facts read from the booted in-process registry. */
export const BOOTED_PROVENANCE = 'booted (registry)';

export interface RegistrySnapshotField {
  name: string;
  type: string;
  required: boolean;
  /** Relationship target for foreignKey / crossPackageRef / *ToMany fields. */
  related: string | null;
  transient: boolean;
  /** Inherited from a base class rather than declared on the object. */
  inherited: boolean;
  /** Declared on a tenant-scoped/sensitive field policy — the value is never here. */
  sqlType: string | null;
}

export interface RegistrySnapshotMethodParameter {
  name: string;
  type: string;
  optional: boolean;
}

export interface RegistrySnapshotMethod {
  name: string;
  async: boolean;
  isStatic: boolean;
  isPublic: boolean;
  parameters: RegistrySnapshotMethodParameter[];
  returnType: string;
  inherited: boolean;
}

export interface RegistrySnapshotObject {
  name: string;
  qualifiedName: string | null;
  packageName: string | null;
  tableName: string | null;
  collection: string | null;
  extends: string | null;
  extendsTypeArg: string | null;
  inheritanceChain: string[];
  visibility: string | null;
  /** Source path relative to `projectRoot`; absolute paths never leave the process. */
  sourceFile: string | null;
  tenantScoped: {
    mode: 'required' | 'optional';
    field: string;
  } | null;
  fieldCount: number;
  methodCount: number;
  fields: RegistrySnapshotField[];
  methods: RegistrySnapshotMethod[];
}

export interface RegistrySnapshotDiagnostic {
  severity: 'warn' | 'error';
  code: string;
  message: string;
}

export interface RegistrySnapshotSummary {
  objectCount: number;
  packages: Array<{ name: string; objectCount: number }>;
  tables: string[];
  diagnosticCount: number;
}

export interface RuntimeRegistrySnapshot {
  provenance: typeof BOOTED_PROVENANCE;
  generatedAt: string;
  summary: RegistrySnapshotSummary;
  objects: RegistrySnapshotObject[];
  diagnostics: RegistrySnapshotDiagnostic[];
}

export interface RegistrySnapshotOptions {
  /** Root used to relativize source paths. Defaults to `process.cwd()`. */
  projectRoot?: string;
  /** Restrict `objects` to these simple or qualified names (summary stays global). */
  objects?: string[];
  /** Include per-object field and method detail (default `true`). */
  detail?: boolean;
  /** Clock for `generatedAt` (defaults to `new Date()`). */
  now?: Date;
}

function toStringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function relativeSourcePath(
  filePath: unknown,
  projectRoot: string,
): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const rel = relative(projectRoot, filePath);
  // A path outside the project root (installed package, symlinked workspace)
  // would still leak the absolute layout through `../..` walking; report only
  // the basename in that case.
  if (rel.startsWith(`..${sep}`) || rel === '..' || rel.startsWith('/')) {
    return filePath.split(sep).pop() ?? null;
  }
  return rel.split(sep).join('/');
}

function toSnapshotField(
  name: string,
  field: RegisteredField,
  inherited: boolean,
): RegistrySnapshotField {
  return {
    name,
    type: String(field.type ?? 'unknown'),
    required: field.required === true,
    related: toStringOrNull(field.related),
    transient: field.transient === true,
    inherited,
    sqlType: toStringOrNull(field.sqlType),
  };
}

function toSnapshotMethod(
  method: MethodDefinition,
  inherited: boolean,
): RegistrySnapshotMethod {
  return {
    name: method.name,
    async: method.async === true,
    isStatic: method.isStatic === true,
    isPublic: method.isPublic === true,
    parameters: (method.parameters ?? []).map((parameter) => ({
      name: String(parameter.name),
      type: String(parameter.type ?? 'unknown'),
      optional: parameter.optional === true,
    })),
    returnType: String(method.returnType ?? 'unknown'),
    inherited,
  };
}

function toSnapshotObject(
  registered: RegisteredClass,
  projectRoot: string,
  detail: boolean,
): RegistrySnapshotObject {
  const fields: RegistrySnapshotField[] = [];
  const methods: RegistrySnapshotMethod[] = [];
  if (detail) {
    for (const [name, field] of registered.inheritedFields ?? []) {
      fields.push(toSnapshotField(name, field, true));
    }
    for (const [name, field] of registered.fields) {
      fields.push(toSnapshotField(name, field, false));
    }
    for (const [, method] of registered.inheritedMethods ?? []) {
      methods.push(toSnapshotMethod(method, true));
    }
    for (const [, method] of registered.methods) {
      methods.push(toSnapshotMethod(method, false));
    }
    fields.sort((a, b) => a.name.localeCompare(b.name));
    methods.sort((a, b) => a.name.localeCompare(b.name));
  }
  return {
    name: registered.name,
    qualifiedName: toStringOrNull(registered.qualifiedName),
    packageName: toStringOrNull(registered.packageName),
    tableName: ObjectRegistry.getTableName(registered.name) ?? null,
    collection: toStringOrNull(registered.collection),
    extends: toStringOrNull(registered.extends),
    extendsTypeArg: toStringOrNull(registered.extendsTypeArg),
    inheritanceChain: [...(registered.inheritanceChain ?? [])],
    visibility: toStringOrNull(registered.visibility),
    sourceFile: relativeSourcePath(registered.sourceFilePath, projectRoot),
    tenantScoped: registered.tenantScopedConfig
      ? {
          mode: registered.tenantScopedConfig.mode,
          field: registered.tenantScopedConfig.field,
        }
      : null,
    fieldCount:
      registered.fields.size + (registered.inheritedFields?.size ?? 0),
    methodCount:
      registered.methods.size + (registered.inheritedMethods?.size ?? 0),
    fields,
    methods,
  };
}

function matchesFilter(
  registered: RegisteredClass,
  filter: Set<string> | null,
): boolean {
  if (!filter) return true;
  return (
    filter.has(registered.name) ||
    (typeof registered.qualifiedName === 'string' &&
      filter.has(registered.qualifiedName))
  );
}

/**
 * Project the booted registry into a sanitized, JSON-serializable snapshot.
 *
 * Pure read of in-process registry state: no database, no project code, no
 * registry mutation. Objects are sorted by qualified name for stable output.
 */
export function snapshotRegistry(
  options: RegistrySnapshotOptions = {},
): RuntimeRegistrySnapshot {
  const projectRoot = options.projectRoot ?? process.cwd();
  const detail = options.detail !== false;
  const filter =
    options.objects && options.objects.length > 0
      ? new Set(options.objects)
      : null;
  const all = [...ObjectRegistry.getAllClasses().values()].sort((a, b) =>
    String(a.qualifiedName ?? a.name).localeCompare(
      String(b.qualifiedName ?? b.name),
    ),
  );

  const packageCounts = new Map<string, number>();
  const tables = new Set<string>();
  for (const registered of all) {
    const pkg = toStringOrNull(registered.packageName) ?? '(unqualified)';
    packageCounts.set(pkg, (packageCounts.get(pkg) ?? 0) + 1);
    const table = ObjectRegistry.getTableName(registered.name);
    if (table) tables.add(table);
  }

  // `context` may carry absolute paths; only the stable code, severity, and
  // message are projected.
  const diagnostics: RegistrySnapshotDiagnostic[] =
    ObjectRegistry.getDiagnostics().map((diagnostic) => ({
      severity: diagnostic.severity,
      code: diagnostic.code,
      message: diagnostic.message,
    }));

  return {
    provenance: BOOTED_PROVENANCE,
    generatedAt: (options.now ?? new Date()).toISOString(),
    summary: {
      objectCount: all.length,
      packages: [...packageCounts.entries()]
        .map(([name, objectCount]) => ({ name, objectCount }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      tables: [...tables].sort(),
      diagnosticCount: diagnostics.length,
    },
    objects: all
      .filter((registered) => matchesFilter(registered, filter))
      .map((registered) => toSnapshotObject(registered, projectRoot, detail)),
    diagnostics,
  };
}

/**
 * Assert a value is plain JSON: no functions, classes, symbols, or cycles.
 * Exposed so callers and tests can prove a snapshot is wire-safe.
 */
export function assertPlainJson(value: unknown, path = '$'): void {
  const seen = new WeakSet<object>();
  const walk = (node: unknown, at: string): void => {
    if (node === null) return;
    const kind = typeof node;
    if (kind === 'string' || kind === 'number' || kind === 'boolean') return;
    if (kind !== 'object') {
      throw new Error(`non-JSON value (${kind}) at ${at}`);
    }
    const obj = node as object;
    if (seen.has(obj)) throw new Error(`cycle at ${at}`);
    seen.add(obj);
    if (Array.isArray(obj)) {
      for (const [index, item] of obj.entries()) {
        walk(item, `${at}[${index}]`);
      }
      return;
    }
    const proto = Object.getPrototypeOf(obj);
    if (proto !== Object.prototype && proto !== null) {
      throw new Error(`non-plain object at ${at}`);
    }
    for (const [key, item] of Object.entries(obj)) walk(item, `${at}.${key}`);
  };
  walk(value, path);
}
