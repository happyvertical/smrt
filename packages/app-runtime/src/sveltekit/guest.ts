/**
 * Guest admission for the SvelteKit runtime (#5196).
 *
 * An UNAUTHENTICATED request (no valid session) may act as a guest of the
 * tenant its address names, with the permission set the tenant grants guests
 * (`TenantGuestGrant`), narrowed by a code ceiling. Admission fails closed:
 * every gate that is missing, unverified or throws yields `null`, and the
 * caller then runs exactly the anonymous path it always did, so a response
 * never differs between "unknown tenant", "no grants" and "guests off".
 *
 * Gates, all required:
 * - the app configures `packages.users.permissions.guest` (strictly parsed);
 * - the default subdomain selector is in use (a custom selector may read
 *   headers) and `TENANT_BASE_DOMAIN` is set (without it the selector falls
 *   back to the first host label);
 * - the selector resolved an ACTIVE tenant;
 * - PostgreSQL row-level security is truly active (`postgresRls`), tenancy is
 *   enabled, the connection role neither is SUPERUSER nor has BYPASSRLS, and
 *   every ceiling table has policies enabled AND forced, read from the
 *   catalog (cached per process on success).
 *
 * Guests are a documented exception to the rule that a tenant selection is
 * never ambient authority: the address picks the tenant, and the grants and
 * the database policies bound what that tenant's guests can reach.
 *
 * @packageDocumentation
 */

import {
  type AuditWriter,
  createGuestRuntime,
  type GuestRuntime,
  type SmrtClassOptions,
} from '@happyvertical/smrt-core';
import { createAuditWriter } from '@happyvertical/smrt-profiles';
import { isTenancyEnabled } from '@happyvertical/smrt-tenancy';
import {
  assertGuestRuntimeActive,
  GUEST_AUDIT_TABLE_DEFAULTS,
  type GuestAuditTablePosture,
  type GuestPermissionConfig,
  GuestPermissionResolver,
  type GuestRlsTablePosture,
  generatePostgresPermissionSql,
  guestAuditPolicyName,
  guestCeilingTables,
  parseGuestPermissionConfig,
} from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';

/** The catalog facts the guest gates need. `null` means unverified. */
export interface GuestCatalogPosture {
  rolePosture: { rolsuper: boolean; rolbypassrls: boolean };
  ceilingTables: GuestRlsTablePosture[];
  expectedCeilingTables: string[];
  /** Audit table posture; `null` when it could not be verified or is absent. */
  auditTable: GuestAuditTablePosture | null;
}

export interface GuestAdmissionDeps {
  /** The app's raw `permissions.guest` value (parsed strictly here). */
  readonly rawConfig: () => unknown;
  /** Truly active request RLS: deployed PostgreSQL with the RLS transaction. */
  readonly postgresRls: () => boolean;
  /** The default subdomain selector is in use (no custom `selectTenant`). */
  readonly defaultSelector: boolean;
  /** `TENANT_BASE_DOMAIN` / `tenantBaseDomain`. */
  readonly baseDomain: () => string | undefined;
  /** Base (never request-scoped) options for the resolver. */
  readonly baseClassOptions: () => SmrtClassOptions;
  /** Base connection for the catalog query. */
  readonly baseDatabase: () => Promise<DatabaseInterface>;
  /** Test seam: replace the catalog query. */
  readonly probeCatalog?: (
    db: DatabaseInterface,
    tables: readonly { schemaName: string; tableName: string }[],
    options: { audit: boolean },
  ) => Promise<GuestCatalogPosture | null>;
  /** Test seam: replace the ceiling tables derived from the policy targets. */
  readonly ceilingTables?: () => readonly {
    schemaName: string;
    tableName: string;
  }[];
  /** Test seam: replace the audit writer (default: profiles `createAuditWriter()`). */
  readonly auditWriter?: () => AuditWriter | undefined;
  /** Test seam: replace the resolver. */
  readonly resolver?: () => Promise<{
    resolveGuestPermissions(tenantId: string): Promise<Set<string>>;
    resolveGuestAdmission?(tenantId: string): Promise<{
      permissions: Set<string>;
      slugModels: Map<string, string>;
    }>;
  }>;
}

/** What admission yields: the one tenant and the guest permission set. */
export interface GuestAdmission {
  readonly tenantId: string;
  readonly permissions: string[];
  /** Slug to the qualified name of the one model the ceiling admitted it for. */
  readonly slugModels: ReadonlyArray<readonly [string, string]>;
  /** The process-wide guest runtime (limiters, create field lists, audit). */
  readonly runtime: GuestRuntime;
}

export interface GuestAdmitter {
  /**
   * Cheap synchronous precheck: guests are configured and every static gate
   * holds for this selection. A `false` means the request takes today's path
   * with no extra work.
   */
  mayAdmit(selectedTenantId: string | null | undefined): boolean;
  /** The admission for the selected tenant, or `null` (anonymous path). */
  admit(selectedTenantId: string | null): Promise<GuestAdmission | null>;
}

function rowsOf(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) return result as Array<Record<string, unknown>>;
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

/**
 * Read the connection role's attributes and each ceiling table's
 * row-security state from the catalog. `null` when anything is missing or
 * not the expected type (unverified is not passed).
 */
export async function probeGuestCatalog(
  db: DatabaseInterface,
  tables: readonly { schemaName: string; tableName: string }[],
  options: { audit: boolean } = { audit: true },
): Promise<GuestCatalogPosture | null> {
  const query = db.query.bind(db) as (
    sql: string,
    ...values: unknown[]
  ) => Promise<unknown>;
  const roles = rowsOf(
    await query(
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    ),
  );
  if (roles.length !== 1) return null;
  const rolsuper = bool(roles[0].rolsuper);
  const rolbypassrls = bool(roles[0].rolbypassrls);
  if (rolsuper === undefined || rolbypassrls === undefined) return null;

  const ceilingTables: GuestRlsTablePosture[] = [];
  for (const table of tables) {
    const rows = rowsOf(
      await query(
        `SELECT c.relrowsecurity AS row_security,
                c.relforcerowsecurity AS force_row_security,
                (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policy_count
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`,
        table.schemaName,
        table.tableName,
      ),
    );
    // Exactly one relation: none means unverified, never "no policies needed".
    if (rows.length !== 1) return null;
    const rowSecurity = bool(rows[0].row_security);
    const forceRowSecurity = bool(rows[0].force_row_security);
    const policyCount = Number(rows[0].policy_count);
    if (
      rowSecurity === undefined ||
      forceRowSecurity === undefined ||
      !Number.isInteger(policyCount)
    ) {
      return null;
    }
    ceilingTables.push({
      table: `${table.schemaName}.${table.tableName}`,
      rowSecurity,
      forceRowSecurity,
      policyCount,
    });
  }
  let auditTable: GuestAuditTablePosture | null = null;
  if (options.audit) {
    const { schemaName, tableName } = GUEST_AUDIT_TABLE_DEFAULTS;
    const rows = rowsOf(
      await query(
        `SELECT c.relrowsecurity AS row_security,
                c.relforcerowsecurity AS force_row_security,
                EXISTS (
                  SELECT 1 FROM pg_policy p
                   WHERE p.polrelid = c.oid AND p.polname = $3 AND p.polcmd = 'a'
                ) AS guest_insert_policy
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`,
        schemaName,
        tableName,
        guestAuditPolicyName({ schemaName, tableName }),
      ),
    );
    // Missing table or any unexpected value stays unverified (null).
    if (rows.length === 1) {
      const rowSecurity = bool(rows[0].row_security);
      const forceRowSecurity = bool(rows[0].force_row_security);
      const guestInsertPolicy = bool(rows[0].guest_insert_policy);
      if (
        rowSecurity !== undefined &&
        forceRowSecurity !== undefined &&
        guestInsertPolicy !== undefined
      ) {
        auditTable = {
          table: `${schemaName}.${tableName}`,
          rowSecurity,
          forceRowSecurity,
          guestInsertPolicy,
        };
      }
    }
  }
  return {
    rolePosture: { rolsuper, rolbypassrls },
    ceilingTables,
    auditTable,
    expectedCeilingTables: tables.map(
      (table) => `${table.schemaName}.${table.tableName}`,
    ),
  };
}

/** How long a failed catalog check is remembered before it is retried. */
const POSTURE_RETRY_MS = 10_000;

export function createGuestAdmitter(deps: GuestAdmissionDeps): GuestAdmitter {
  let posture: GuestCatalogPosture | undefined;
  let postureFailedAt = 0;
  let postureInFlight: Promise<GuestCatalogPosture | null> | undefined;
  let resolverPromise:
    | Promise<{
        resolveGuestPermissions(tenantId: string): Promise<Set<string>>;
        resolveGuestAdmission?(tenantId: string): Promise<{
          permissions: Set<string>;
          slugModels: Map<string, string>;
        }>;
      }>
    | undefined;

  /** The tables guests could reach NOW: recomputed, never remembered. */
  const currentTables = (guest: GuestPermissionConfig) =>
    deps.ceilingTables
      ? deps.ceilingTables()
      : guestCeilingTables(
          guest,
          generatePostgresPermissionSql(deps.baseClassOptions()).targets,
        );
  const nameOf = (table: { schemaName: string; tableName: string }) =>
    `${table.schemaName}.${table.tableName}`;
  let failedFor = '';

  /**
   * The verified catalog posture covering EVERY table guests can reach right
   * now. The table list is recomputed on each call (a run-time model can be
   * registered, and opted in, after the first guest request); the cached
   * posture is kept only while it covers all of them, and is dropped and
   * re-verified as soon as one is missing. A failed or throwing verification
   * is `null`: the caller grants nothing.
   */
  const loadPosture = async (
    guest: GuestPermissionConfig,
  ): Promise<GuestCatalogPosture | null> => {
    const tables = currentTables(guest);
    // No ceiling table means nothing a guest could ever hold.
    if (tables.length === 0) return null;
    const signature = tables.map(nameOf).sort().join(',');
    if (
      posture &&
      tables.every((table) =>
        posture?.expectedCeilingTables.includes(nameOf(table)),
      )
    ) {
      return posture;
    }
    posture = undefined;
    if (
      postureFailedAt &&
      failedFor === signature &&
      Date.now() - postureFailedAt < POSTURE_RETRY_MS
    ) {
      return null;
    }
    postureInFlight ??= (async () => {
      try {
        const probe = deps.probeCatalog ?? probeGuestCatalog;
        // Every guest config needs the protected audit table, read-only
        // ones included: a config can gain a create collection at any
        // deploy, and "refuse unless protected" must not depend on it.
        const result = await probe(await deps.baseDatabase(), tables, {
          audit: true,
        });
        if (!result) return null;
        const verdict = assertGuestRuntimeActive({
          postgresRls: true,
          tenancyEnabled: true,
          rolePosture: result.rolePosture,
          ceilingTables: result.ceilingTables,
          expectedCeilingTables: result.expectedCeilingTables,
          auditRequired: true,
          auditTable: result.auditTable,
        });
        return verdict.active ? result : null;
      } catch {
        return null;
      }
    })();
    try {
      const result = await postureInFlight;
      if (result) {
        posture = result;
      } else {
        postureFailedAt = Date.now();
        failedFor = signature;
      }
      return result;
    } finally {
      postureInFlight = undefined;
    }
  };

  // One runtime per application: every route and collection shares its
  // limiters, so the per-tenant limit is per tenant and not per route.
  let runtime: GuestRuntime | undefined;
  const loadRuntime = (guest: GuestPermissionConfig): GuestRuntime => {
    runtime ??= createGuestRuntime({
      createFields: guest.createFields,
      trustedHops: guest.trustedProxyHops ?? 0,
      auditWriter: deps.auditWriter ? deps.auditWriter() : createAuditWriter(),
      create: {
        windowMs: guest.rateLimits?.windowMs,
        perClient: guest.rateLimits?.createPerClient,
        perTenant: guest.rateLimits?.createPerTenant,
      },
      read: {
        windowMs: guest.rateLimits?.windowMs,
        perClient: guest.rateLimits?.readPerClient,
        perTenant: guest.rateLimits?.readPerTenant,
      },
    });
    return runtime;
  };

  const loadResolver = (guest: GuestPermissionConfig) => {
    if (deps.resolver) return deps.resolver();
    resolverPromise ??= GuestPermissionResolver.create(
      deps.baseClassOptions(),
      guest,
    ).catch((error: unknown) => {
      resolverPromise = undefined;
      throw error;
    });
    return resolverPromise;
  };

  const staticGates = (
    selectedTenantId: string | null | undefined,
  ): GuestPermissionConfig | null => {
    const guest = parseGuestPermissionConfig(deps.rawConfig());
    if (!guest) return null;
    if (!deps.defaultSelector) return null;
    const baseDomain = deps
      .baseDomain()
      ?.trim()
      .replace(/^\.+|\.+$/g, '');
    if (!baseDomain) return null;
    if (typeof selectedTenantId !== 'string' || !selectedTenantId) return null;
    if (deps.postgresRls() !== true || isTenancyEnabled() !== true) return null;
    return guest;
  };

  return {
    mayAdmit(selectedTenantId) {
      try {
        return staticGates(selectedTenantId) !== null;
      } catch {
        return false;
      }
    },
    async admit(selectedTenantId) {
      try {
        const guest = staticGates(selectedTenantId);
        if (!guest || typeof selectedTenantId !== 'string') return null;
        // Resolve first, then verify the tables as they are NOW: the
        // registry only grows, so what was resolved is covered by the list
        // recomputed afterwards. Nothing is granted unless that holds.
        const resolver = await loadResolver(guest);
        // Uncached: every request reads live grants, DENYs and tenant status.
        // A resolver without the admitted-model map admits no route.
        const { permissions, slugModels } = resolver.resolveGuestAdmission
          ? await resolver.resolveGuestAdmission(selectedTenantId)
          : {
              permissions:
                await resolver.resolveGuestPermissions(selectedTenantId),
              slugModels: new Map<string, string>(),
            };
        if (permissions.size === 0) return null;
        const verified = await loadPosture(guest);
        if (!verified) return null;
        // Re-assert with the live gates on every request: RLS and tenancy
        // are read now, the catalog facts come from the verified cache.
        const verdict = assertGuestRuntimeActive({
          postgresRls: deps.postgresRls(),
          rolePosture: verified.rolePosture,
          ceilingTables: verified.ceilingTables,
          expectedCeilingTables: verified.expectedCeilingTables,
          auditRequired: true,
          auditTable: verified.auditTable,
        });
        if (!verdict.active) return null;
        return {
          tenantId: selectedTenantId,
          permissions: [...permissions],
          slugModels: [...slugModels],
          runtime: loadRuntime(guest),
        };
      } catch {
        // Any failure is the anonymous path: no error that tells a client
        // whether a tenant exists or has grants.
        return null;
      }
    },
  };
}
