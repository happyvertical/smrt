/**
 * The generic user-interface preference store (#3727).
 *
 * Two tiers per `(kind, surfaceId)`: the tenant default and the principal's
 * own preference. Every call names a registered kind; the kind validates the
 * payload strictly on save (only its canonical form is stored) and leniently
 * on load (invalid parts are dropped and reported, the row is never
 * rewritten), and names the permission for each tier. Identity always comes
 * from the ambient principal.
 */
import { RuntimeError } from '@happyvertical/smrt-core';
import './kinds/builtin.js';
import { checkOperationPermission } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { UiPreferenceRecordCollection } from './collections/UiPreferenceRecordCollection.js';
import {
  type PreferencePrincipal,
  requirePreferencePrincipal,
  withPrincipal,
} from './context.js';
import {
  PREFERENCE_SURFACE_PATTERN,
  type PreferenceIssue,
  type PreferenceKindDefinition,
  type PreferenceScope,
  requirePreferenceKind,
} from './kinds.js';
import type { UiPreferenceRecord } from './models/UiPreferenceRecord.js';
import { splitPermissionSlug } from './permissions.js';

/** One stored tier, validated for use. */
export interface PreferenceTier {
  /** The kind's canonical payload, invalid parts removed; `null` = none. */
  payload: unknown | null;
  /** Concurrency token: echo it back on save or reset; `null` = no row. */
  revision: string | null;
  /** What was dropped from the stored payload on load, and why. */
  issues: PreferenceIssue[];
}

export interface PreferenceState {
  kind: string;
  surfaceId: string;
  /** The tenant default. */
  tenant: PreferenceTier;
  /** The principal's own preference; `null` without a user. */
  user: PreferenceTier | null;
  /** Every tier's issues, tenant first. */
  issues: PreferenceIssue[];
  /** Whether the principal may write each tier (the kind's permission pair). */
  canCustomize: { tenant: boolean; user: boolean };
}

export type PreferenceWriteFailure =
  | { ok: false; reason: 'not_allowed' }
  | { ok: false; reason: 'conflict' }
  | { ok: false; reason: 'invalid'; issues: PreferenceIssue[] };

export type PreferenceSaveResult =
  | { ok: true; payload: unknown | null; revision: string | null }
  | PreferenceWriteFailure;

export type PreferenceResetResult = { ok: true } | PreferenceWriteFailure;

export interface PreferenceLoadInput {
  /** Kind-specific validation inputs (passed to `validate` as `options`). */
  options?: unknown;
}

export interface PreferenceSaveInput extends PreferenceLoadInput {
  scope: PreferenceScope;
  /** The client's payload (untrusted). `null` resets the tier. */
  payload: unknown;
  /**
   * The `revision` the client loaded for this tier (`null` when it loaded no
   * row). A stale revision fails with `conflict`, never overwrites.
   */
  revision: string | null;
}

export interface PreferenceResetInput {
  scope: PreferenceScope;
  /** Guard the delete with the loaded revision; omit to reset regardless. */
  revision?: string | null;
}

export interface PreferenceStoreOptions {
  db: DatabaseInterface;
}

export interface PreferenceStore {
  /** Read and validate both tiers of `(kind, surfaceId)` for the principal. */
  load(
    kind: string,
    surfaceId: string,
    input?: PreferenceLoadInput,
  ): Promise<PreferenceState>;
  /** Validate and store one tier's payload (canonical form only). */
  save(
    kind: string,
    surfaceId: string,
    input: PreferenceSaveInput,
  ): Promise<PreferenceSaveResult>;
  /** Delete one tier's row, returning that tier to the tier below. */
  reset(
    kind: string,
    surfaceId: string,
    input: PreferenceResetInput,
  ): Promise<PreferenceResetResult>;
}

function isRevisionConflict(error: unknown): boolean {
  return (
    error instanceof RuntimeError && error.code === 'RUNTIME_REVISION_CONFLICT'
  );
}

function assertSurfaceId(surfaceId: string): void {
  if (!PREFERENCE_SURFACE_PATTERN.test(surfaceId)) {
    throw new Error(`Invalid preference surface id "${surfaceId}"`);
  }
}

async function holds(
  principal: PreferencePrincipal,
  slug: string,
  db: DatabaseInterface,
): Promise<boolean> {
  const decision = await checkOperationPermission({
    ...splitPermissionSlug(slug),
    db,
    tenantId: principal.tenantId,
    userId: principal.userId ?? null,
    permissionSet: principal.permissions,
    onDeny: 'return',
  });
  return decision.allowed;
}

async function canWrite(
  principal: PreferencePrincipal,
  kind: PreferenceKindDefinition,
  scope: PreferenceScope,
  db: DatabaseInterface,
): Promise<boolean> {
  if (scope === 'user') {
    return (
      Boolean(principal.userId) &&
      (await holds(principal, kind.permissions.user, db))
    );
  }
  return holds(principal, kind.permissions.tenant, db);
}

/** Validate one stored row for use (lenient). */
function readTier(
  kind: PreferenceKindDefinition,
  surfaceId: string,
  scope: PreferenceScope,
  row: UiPreferenceRecord | null,
  options: unknown,
  tenant?: unknown | null,
): PreferenceTier {
  if (!row) {
    return { payload: null, revision: null, issues: [] };
  }
  const revision = row.revision;
  const payload = row.getPayload();
  if (payload === undefined) {
    return {
      payload: null,
      revision,
      issues: [
        {
          path: null,
          code: 'malformed',
          message: 'stored payload is not JSON',
        },
      ],
    };
  }
  if (row.formatVersion > kind.formatVersion) {
    return {
      payload: null,
      revision,
      issues: [
        {
          path: null,
          code: 'future_version',
          message: 'stored payload was written by a newer format version',
        },
      ],
    };
  }
  const checked = kind.validate(payload, {
    kind: kind.kind,
    surfaceId,
    scope,
    phase: 'load',
    formatVersion: row.formatVersion,
    ...(scope === 'user' ? { tenant: tenant ?? null } : {}),
    options,
  });
  return { payload: checked.canonical, revision, issues: checked.issues };
}

/**
 * The generic preference store. One per database; every call acts as the
 * ambient principal and names a registered kind.
 */
export function createPreferenceStore(
  options: PreferenceStoreOptions,
): PreferenceStore {
  const { db } = options;
  const collection = (): Promise<UiPreferenceRecordCollection> =>
    UiPreferenceRecordCollection.create({ db });

  async function tenantTier(
    records: UiPreferenceRecordCollection,
    principal: PreferencePrincipal,
    kind: PreferenceKindDefinition,
    surfaceId: string,
    kindOptions: unknown,
  ): Promise<PreferenceTier> {
    const row = await records.findTier(
      principal.tenantId,
      kind.kind,
      surfaceId,
      'tenant',
    );
    return readTier(kind, surfaceId, 'tenant', row, kindOptions);
  }

  return {
    async load(kindId, surfaceId, input = {}) {
      const kind = requirePreferenceKind(kindId);
      assertSurfaceId(surfaceId);
      const principal = requirePreferencePrincipal();
      return withPrincipal(principal, async () => {
        const records = await collection();
        const tenant = await tenantTier(
          records,
          principal,
          kind,
          surfaceId,
          input.options,
        );
        const userRow = principal.userId
          ? await records.findTier(
              principal.tenantId,
              kind.kind,
              surfaceId,
              'user',
              principal.userId,
            )
          : null;
        const user = principal.userId
          ? readTier(
              kind,
              surfaceId,
              'user',
              userRow,
              input.options,
              tenant.payload,
            )
          : null;
        const [tenantWrite, userWrite] = await Promise.all([
          canWrite(principal, kind, 'tenant', db),
          canWrite(principal, kind, 'user', db),
        ]);
        return {
          kind: kind.kind,
          surfaceId,
          tenant,
          user,
          issues: [...tenant.issues, ...(user?.issues ?? [])],
          canCustomize: { tenant: tenantWrite, user: userWrite },
        };
      });
    },

    async save(kindId, surfaceId, input) {
      const kind = requirePreferenceKind(kindId);
      assertSurfaceId(surfaceId);
      const principal = requirePreferencePrincipal();
      return withPrincipal(principal, async () => {
        if (!(await canWrite(principal, kind, input.scope, db))) {
          return { ok: false, reason: 'not_allowed' };
        }
        const records = await collection();
        const tenant =
          input.scope === 'user'
            ? (
                await tenantTier(
                  records,
                  principal,
                  kind,
                  surfaceId,
                  input.options,
                )
              ).payload
            : undefined;
        const checked = kind.validate(input.payload, {
          kind: kind.kind,
          surfaceId,
          scope: input.scope,
          phase: 'save',
          formatVersion: kind.formatVersion,
          ...(input.scope === 'user' ? { tenant: tenant ?? null } : {}),
          options: input.options,
        });
        if (!checked.ok) {
          return { ok: false, reason: 'invalid', issues: checked.issues };
        }
        const canonical = checked.canonical ?? null;
        const userId = input.scope === 'user' ? principal.userId : undefined;
        const existing = await records.findTier(
          principal.tenantId,
          kind.kind,
          surfaceId,
          input.scope,
          userId,
        );
        const revision = input.revision ?? null;
        if (canonical === null) {
          // Back on the tier below: store nothing.
          if (!existing) {
            return revision === null
              ? { ok: true, payload: null, revision: null }
              : { ok: false, reason: 'conflict' };
          }
          if (revision === null) return { ok: false, reason: 'conflict' };
          try {
            await existing.delete({ expectedUpdatedAt: revision });
          } catch (error) {
            if (isRevisionConflict(error)) {
              return { ok: false, reason: 'conflict' };
            }
            throw error;
          }
          return { ok: true, payload: null, revision: null };
        }
        if (existing) {
          if (revision === null) return { ok: false, reason: 'conflict' };
          existing.setPayload(canonical);
          existing.formatVersion = kind.formatVersion;
          try {
            await existing.save({ expectedUpdatedAt: revision });
          } catch (error) {
            if (isRevisionConflict(error)) {
              return { ok: false, reason: 'conflict' };
            }
            throw error;
          }
          return { ok: true, payload: canonical, revision: existing.revision };
        }
        if (revision !== null) return { ok: false, reason: 'conflict' };
        try {
          const created = await records.create({
            tenantId: principal.tenantId,
            kind: kind.kind,
            surfaceId,
            scopeType: input.scope,
            userId: userId ?? null,
            payloadJson: JSON.stringify(canonical),
            formatVersion: kind.formatVersion,
            _insertOnly: true,
          });
          return { ok: true, payload: canonical, revision: created.revision };
        } catch (error) {
          // A concurrent first write took the natural key: the strict insert
          // refuses instead of overwriting it.
          const raced = await records.findTier(
            principal.tenantId,
            kind.kind,
            surfaceId,
            input.scope,
            userId,
          );
          if (raced) return { ok: false, reason: 'conflict' };
          throw error;
        }
      });
    },

    async reset(kindId, surfaceId, input) {
      const kind = requirePreferenceKind(kindId);
      assertSurfaceId(surfaceId);
      const principal = requirePreferencePrincipal();
      return withPrincipal(principal, async () => {
        if (!(await canWrite(principal, kind, input.scope, db))) {
          return { ok: false, reason: 'not_allowed' };
        }
        const records = await collection();
        const existing = await records.findTier(
          principal.tenantId,
          kind.kind,
          surfaceId,
          input.scope,
          input.scope === 'user' ? principal.userId : undefined,
        );
        if (!existing) return { ok: true };
        try {
          await existing.delete(
            typeof input.revision === 'string'
              ? { expectedUpdatedAt: input.revision }
              : {},
          );
        } catch (error) {
          if (isRevisionConflict(error)) {
            return { ok: false, reason: 'conflict' };
          }
          throw error;
        }
        return { ok: true };
      });
    },
  };
}
