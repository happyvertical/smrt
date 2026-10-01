/**
 * Tenant natural-key detector for `db:status`.
 *
 * A tenant-owned table (declared tenant scope, or an undeclared `tenantId`
 * field — `ObjectRegistry.getOwnershipTenantColumn()`) upserts on a
 * tenant-led key such as `(tenant_id, slug, context)`. A live database created
 * before that default can still carry the GLOBAL `(slug, context)` unique:
 * then a second tenant's same-slug save collides with a row it cannot see.
 * Before the save-time ownership guard, `ON CONFLICT … DO UPDATE` rewrote that
 * row's `id` and `tenant_id` (the Anytown Ludis takeover); now the save is
 * refused, and on engines that require an exact ON CONFLICT target the create
 * fails until `smrt db:migrate` swaps the index.
 *
 * Rollout is expand, then contract: `smrt db:migrate` builds the tenant-led
 * unique beside the global one (an `error` until it exists, so db:status exits
 * 1), and the global one stays — reported as a `warning` — until
 * `smrt db:migrate --drop-legacy-natural-key` once no old code is running.
 * Explicit `@smrt({ conflictColumns })` that omit the tenant column are the
 * author's declared contract and are not reported here (the tenancy
 * package's `auditTenantScopedRegistrations()` flags runtime-registered ones).
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { isCollectionRegistration } from './db-parity.js';

/** Live index shape this detector reads (`getTableSchema().indexes`). */
type LiveIndexLike = {
  name?: string;
  columns?: string[];
  unique?: boolean;
  where?: string;
};

/** Live table shape this detector reads. */
export type LiveTableLike = { indexes?: LiveIndexLike[] } | null | undefined;

/**
 * One tenant natural-key finding, shaped as a `db:status` precondition.
 * `global_unique` is an `error` (db:status exits 1): the release that keys
 * the table by tenant needs its migration, and a rollout must not miss it.
 */
export interface TenantNaturalKeyFinding {
  name: string;
  status: 'warning' | 'error';
  message: string;
  recommendation: string;
  details: {
    className: string;
    tableName: string;
    conflictColumns: string[];
    liveIndex?: string;
    kind: 'global_unique' | 'legacy_global_unique' | 'missing_tenant_unique';
  };
}

function sameColumnSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((column) => b.includes(column));
}

/**
 * Compare every tenant-owned table's upsert target with its live unique
 * indexes. Tables absent from `liveSchemas` (not created yet, or not
 * introspected) are skipped — the schema diff reports those.
 */
export function checkTenantNaturalKeyUniques(
  liveSchemas: ReadonlyMap<string, LiveTableLike>,
): TenantNaturalKeyFinding[] {
  const findings: TenantNaturalKeyFinding[] = [];
  const seenTables = new Set<string>();

  for (const className of ObjectRegistry.getQualifiedClassNames()) {
    if (isCollectionRegistration(className)) continue;
    const tableName = ObjectRegistry.getTableName(className);
    if (!tableName || seenTables.has(tableName)) continue;

    const tenantColumn = ObjectRegistry.getOwnershipTenantColumn(className);
    if (!tenantColumn) continue;
    const conflictColumns = ObjectRegistry.getConflictColumns(className);
    if (!conflictColumns.includes(tenantColumn)) continue;

    const live = liveSchemas.get(tableName);
    if (!live) continue;
    seenTables.add(tableName);

    const uniques = (live.indexes ?? []).filter(
      (index) => index.unique === true && !index.where,
    );
    const naturalKey = conflictColumns.filter(
      (column) => column !== tenantColumn,
    );
    const global = uniques.find((index) =>
      sameColumnSet(index.columns ?? [], naturalKey),
    );
    const target = `(${conflictColumns.join(', ')})`;
    if (
      uniques.some((index) =>
        sameColumnSet(index.columns ?? [], conflictColumns),
      )
    ) {
      // Expanded: the tenant-led unique exists. A surviving global unique is
      // the legacy key db:migrate keeps for code still on the previous
      // release; it is a pending contract step, not a failure.
      if (global) {
        findings.push({
          name: `${tableName}.${global.name ?? '(unnamed unique)'}`,
          status: 'warning',
          message:
            `Tenant-owned table "${tableName}" (${className}) still carries the legacy unique ` +
            `index on (${naturalKey.join(', ')}) beside the tenant-led ${target}. Until it is ` +
            'dropped, a second tenant cannot store a key another tenant already uses (the save ' +
            'fails with a unique violation; nothing is overwritten).',
          recommendation:
            'Once every running instance is on the release that upserts on the tenant-led key, run ' +
            '`smrt db:migrate --drop-legacy-natural-key` to drop it.',
          details: {
            className,
            tableName,
            conflictColumns,
            liveIndex: global.name,
            kind: 'legacy_global_unique',
          },
        });
      }
      continue;
    }

    if (global) {
      findings.push({
        name: `${tableName}.${global.name ?? '(unnamed unique)'}`,
        status: 'error',
        message:
          `Tenant-owned table "${tableName}" (${className}) has a unique index on ` +
          `(${naturalKey.join(', ')}) shared by every tenant, but the model upserts on ${target}. ` +
          'A second tenant cannot store a key another tenant already uses; saves that collide ' +
          'are refused (TENANT_ISOLATION_VIOLATION), and creates can fail outright until the ' +
          'index matches the upsert target.',
        recommendation:
          'Run `smrt db:migrate` BEFORE deploying the release that upserts on the tenant-led ' +
          'key: it builds the tenant-inclusive unique under its own name (a superset, so it ' +
          'cannot fail on existing rows) and keeps this one, so old code (ON CONFLICT on the ' +
          'global key) and new code (ON CONFLICT on the tenant-led key) both keep working. ' +
          'After the rollout, `smrt db:migrate --drop-legacy-natural-key` drops the legacy index.',
        details: {
          className,
          tableName,
          conflictColumns,
          liveIndex: global.name,
          kind: 'global_unique',
        },
      });
    } else {
      findings.push({
        name: `${tableName}.${target}`,
        status: 'warning',
        message:
          `Tenant-owned table "${tableName}" (${className}) has no unique index on ${target}, ` +
          'the key the model upserts on.',
        recommendation:
          'Run `smrt db:migrate` to create the tenant-inclusive unique index.',
        details: {
          className,
          tableName,
          conflictColumns,
          kind: 'missing_tenant_unique',
        },
      });
    }
  }

  return findings;
}
