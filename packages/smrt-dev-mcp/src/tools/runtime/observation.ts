/**
 * Level 2 read-only observation tools over the booted runtime (#1831).
 *
 * Three facts planes, labelled separately in every envelope:
 * - `declared (manifest)`: what the confined boot registered ({@link bootRuntime});
 * - `booted (registry)`: the in-process `ObjectRegistry` projected through the
 *   sanitized {@link snapshotRegistry} DTO;
 * - `runtime (live DB)`: the optional read-only connection, reused from Level 1.
 *
 * Nothing here mutates: no writes, no `do()`, no generated CRUD, no project
 * code execution. `runtime-schema-diff` only *introspects* the live schema.
 */

import {
  ObjectRegistry,
  type RegistrySnapshotObject,
  snapshotRegistry,
} from '@happyvertical/smrt-core';
import { SchemaComparer } from '@happyvertical/smrt-core/migrations';
import { bootRuntime, getBootedProjectRoot, type RuntimeBoot } from './boot.js';
import type { RuntimeDatabaseArgs } from './connection.js';
import {
  type RuntimeDiagnostic,
  type RuntimeToolEnvelope,
  withRuntimeConnection,
} from './tools.js';

/** Row budget for `runtime-schema-diff` change lists. */
const SCHEMA_DIFF_CHANGE_LIMIT = 200;

export interface RuntimeProjectArgs {
  /** Project root to boot from (defaults to the server's cwd). */
  projectPath?: string;
}

function bootDiagnostics(boot: RuntimeBoot): RuntimeDiagnostic[] {
  return boot.diagnostics
    .filter((d) => d.severity !== 'info')
    .map((d) => ({
      severity: d.severity === 'error' ? 'warning' : d.severity,
      code: `boot_${d.code}`,
      message: d.message,
    }));
}

function bootSummary(boot: RuntimeBoot) {
  return {
    provenance: boot.provenance,
    bootedAt: boot.bootedAt,
    projectName: boot.projectName,
    manifests: boot.manifests,
    objectCount: boot.objectCount,
  };
}

export interface RuntimeRegistryArgs extends RuntimeProjectArgs {
  /** Restrict object detail to these simple or qualified names. */
  objects?: string[];
  /** Include field/method detail (default: only when `objects` is given). */
  detail?: boolean;
  /**
   * Resume after this object key: the qualified name when the object has
   * one, otherwise its simple name — exactly the value a previous response
   * returned as `page.nextCursor` (#2779). Objects are sorted by that key.
   */
  cursor?: string;
  /** Objects per page (default {@link REGISTRY_PAGE_LIMIT}, max 500). */
  limit?: number;
}

/** Default objects per `runtime-registry` page. */
export const REGISTRY_PAGE_LIMIT = 50;

function objectKey(object: {
  qualifiedName: string | null;
  name: string;
}): string {
  return object.qualifiedName ?? object.name;
}

/** `runtime-registry`: sanitized snapshot of the booted registry. */
export async function runtimeRegistry(
  args: RuntimeRegistryArgs = {},
): Promise<RuntimeToolEnvelope> {
  const boot = await bootRuntime({ projectRoot: args.projectPath });
  // Paths are relativized against the root the process actually booted from,
  // never the per-request argument (which is ignored after the first boot).
  const snapshot = snapshotRegistry({
    projectRoot: getBootedProjectRoot() ?? undefined,
    objects: args.objects,
    detail: args.detail ?? Boolean(args.objects?.length),
  });
  // Page the object list (summary stays global). A 76-object app answered in
  // 56 KB before paging; an agent hunting one class needs a cursor, not a cut.
  const limit = Math.min(
    Math.max(Math.floor(args.limit ?? REGISTRY_PAGE_LIMIT), 1),
    500,
  );
  // The cursor is compared against the same key `page.nextCursor` carries.
  const cursor =
    typeof args.cursor === 'string' && args.cursor.length > 0
      ? args.cursor
      : null;
  const all = snapshot.objects;
  const afterCursor = cursor
    ? all.filter((object) => objectKey(object).localeCompare(cursor) > 0)
    : all;
  const objects = afterCursor.slice(0, limit);
  const nextCursor =
    afterCursor.length > objects.length && objects.length > 0
      ? objectKey(objects[objects.length - 1])
      : null;
  return {
    ok: true,
    coverage: null,
    diagnostics: bootDiagnostics(boot),
    data: {
      provenance: snapshot.provenance,
      boot: bootSummary(boot),
      page: {
        returned: objects.length,
        matched: all.length,
        limit,
        cursor,
        nextCursor,
      },
      snapshot: { ...snapshot, objects },
    },
  };
}

export interface RuntimeObjectArgs extends RuntimeProjectArgs {
  /** Simple or qualified object name. */
  name: string;
  /** Engine for the generated DDL preview (default: the registry's default). */
  engine?: 'sqlite' | 'postgres' | 'duckdb';
}

/** `runtime-object`: one object's sanitized definition plus its generated DDL. */
export async function runtimeObject(
  args: RuntimeObjectArgs,
): Promise<RuntimeToolEnvelope> {
  const boot = await bootRuntime({ projectRoot: args.projectPath });
  const name = typeof args.name === 'string' ? args.name.trim() : '';
  const snapshot = snapshotRegistry({
    projectRoot: getBootedProjectRoot() ?? undefined,
    objects: name ? [name] : [],
    detail: true,
  });
  const diagnostics = bootDiagnostics(boot);
  let object: RegistrySnapshotObject | null = snapshot.objects[0] ?? null;
  if (snapshot.objects.length > 1) {
    // Two packages registering the same simple name is legal; picking one
    // silently would misreport identity. Ask for the qualified name instead.
    object = null;
    diagnostics.push({
      severity: 'warning',
      code: 'object_ambiguous',
      message: `${name} is registered by several packages; pass a qualified name: ${snapshot.objects
        .map((candidate) => candidate.qualifiedName ?? candidate.name)
        .join(', ')}`,
    });
  } else if (!object) {
    diagnostics.push({
      severity: 'warning',
      code: 'object_not_found',
      message: name
        ? `No booted object named ${name}; use runtime-registry to list names.`
        : 'name is required.',
    });
  }
  let ddl: string | null = null;
  if (object) {
    try {
      // Resolve by qualified identity so a same-name class in another package
      // can never answer for this one.
      ddl =
        ObjectRegistry.getSchemaDDL(
          object.qualifiedName ?? object.name,
          args.engine,
        ) ?? null;
    } catch (error) {
      diagnostics.push({
        severity: 'warning',
        code: 'ddl_unavailable',
        message: `Generated DDL unavailable: ${error instanceof Error ? error.message : 'unknown error'}`,
      });
    }
  }
  return {
    ok: true,
    coverage: null,
    diagnostics,
    data: {
      provenance: snapshot.provenance,
      boot: bootSummary(boot),
      object,
      ddl,
    },
  };
}

export interface RuntimeSchemaDiffArgs
  extends RuntimeDatabaseArgs,
    RuntimeProjectArgs {}

/**
 * `runtime-schema-diff`: booted registry schemas versus the live database,
 * using the same comparer `db:diff`/`db:migrate` use. Introspection only —
 * drop/relax options are pinned off and nothing is executed.
 */
export async function runtimeSchemaDiff(
  args: RuntimeSchemaDiffArgs = {},
): Promise<RuntimeToolEnvelope> {
  const boot = await bootRuntime({ projectRoot: args.projectPath });
  const envelope = await withRuntimeConnection(
    args,
    async (db) => {
      const comparer = new SchemaComparer(db, {
        includeDroppedTables: false,
        includeDroppedColumns: false,
        includeDroppedIndexes: false,
        relaxColumns: false,
      });
      const diff = await comparer.compare(
        ObjectRegistry.getAllSchemasAsDefinitions(),
      );
      const byType: Record<string, number> = {};
      for (const change of diff.changes) {
        const type = String((change as { type?: unknown }).type ?? 'unknown');
        byType[type] = (byType[type] ?? 0) + 1;
      }
      return {
        data: {
          boot: bootSummary(boot),
          hasChanges: diff.has_changes,
          addedTables: diff.added_tables.map((t) => t.tableName),
          droppedTables: diff.dropped_tables,
          orphanTables: diff.orphan_tables ?? [],
          changeCount: diff.changes.length,
          changesByType: byType,
          changes: diff.changes.slice(0, SCHEMA_DIFF_CHANGE_LIMIT),
          truncated: diff.changes.length > SCHEMA_DIFF_CHANGE_LIMIT,
        },
        diagnostics: [],
      };
    },
    'booted registry schemas only; connect a dev database to diff against live tables',
  );
  envelope.diagnostics = [...bootDiagnostics(boot), ...envelope.diagnostics];
  return envelope;
}
