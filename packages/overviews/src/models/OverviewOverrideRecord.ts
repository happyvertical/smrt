import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { assertOperationPermission } from '@happyvertical/smrt-users';
import { OverviewAccessError, requireOverviewPrincipal } from '../context.js';
import {
  CUSTOMIZE_OVERVIEW_PERMISSION,
  ensureOverviewPermissionsRegistered,
  OVERVIEW_PERMISSION_COLLECTION,
  PERSONALIZE_OVERVIEW_PERMISSION,
} from '../permissions.js';

// Direct model imports (tests, server integrations) must still find the two
// custom slugs in the shared users catalog before any guard asks for them.
ensureOverviewPermissionsRegistered();

type SaveOptions = NonNullable<Parameters<SmrtObject['save']>[0]>;
type DeleteOptions = NonNullable<Parameters<SmrtObject['delete']>[0]>;

/** The two tiers a stored override can belong to. */
export const OVERVIEW_SCOPES = ['tenant', 'user'] as const;
export type OverviewScope = (typeof OVERVIEW_SCOPES)[number];

/** `scopeKey` of a tenant-default row (user rows use the user id). */
export const TENANT_SCOPE_KEY = '__tenant__';

/** Longest overview id the table accepts (`OVERVIEW_PAGE_ID_PATTERN`). */
const MAX_OVERVIEW_ID_LENGTH = 96;

/**
 * One stored overview override (#3727 phase 3): the canonical sparse
 * `OverviewOverride` of `@happyvertical/smrt-svelte/overview` for one overview
 * id at one tier of one tenant.
 *
 * - `scopeType: 'tenant'` is the tenant default (`userId` null). Writing it
 *   requires `overviews.customize`.
 * - `scopeType: 'user'` is one person's override on top of the tenant
 *   default, inside that tenant. Only that user may write it, and it requires
 *   `overviews.personalize`.
 *
 * Every row carries its tenant, so the table is `@TenantScoped` (required):
 * the tenancy interceptor filters reads and refuses foreign rows, and the
 * save/delete guards below re-check tier ownership and permission against the
 * PERSISTED row. The JSON is validated against the widget registry by the
 * store (`saveOverviewOverride`), which owns content validation; this model
 * owns identity, scope shape and authorization.
 *
 * No generated surface: an override is only meaningful after validation with
 * the page's widget registry, which a generated route does not have.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_overview_overrides',
  conflictColumns: ['tenant_id', 'overview_id', 'scope_type', 'scope_key'],
  api: { include: [] },
  cli: false,
  mcp: { include: [] },
})
export class OverviewOverrideRecord extends SmrtObject {
  /** Owning tenant (native UUID on PostgreSQL/DuckDB). */
  @tenantId()
  tenantId: string = '';

  /** The overview's stable id (`OverviewDefinition.id`, e.g. `events.home`). */
  @field({ required: true })
  overviewId: string = '';

  /** `tenant` (the tenant default) or `user` (one person's override). */
  @field({ required: true })
  scopeType: OverviewScope = 'tenant';

  /** The owning user of a user-scope row; NULL on the tenant default. */
  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  userId: string | null = null;

  /**
   * `userId ?? '__tenant__'`, set on save. Exists only to keep the
   * `conflictColumns` unique index total while `userId` is nullable (NULLs
   * are distinct in a unique index). Never read it for scoping.
   */
  @field({ type: 'text', required: true })
  scopeKey: string = '';

  /** The canonical override as JSON text (`OverviewOverride`, version 1). */
  @field({ type: 'text', required: true })
  overrideJson: string = '';

  /** `OverviewOverride.version` of `overrideJson`. */
  @field({ type: 'integer' })
  formatVersion: number = 1;

  /** Who last wrote the row; stamped from the ambient principal. */
  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  updatedBy: string | null = null;

  /** The stored override, parsed. `null` when the text is not JSON. */
  getOverride(): unknown {
    try {
      return JSON.parse(this.overrideJson);
    } catch {
      return null;
    }
  }

  /** Store an override; the caller passes the canonical value. */
  setOverride(value: unknown): void {
    this.overrideJson = JSON.stringify(value);
  }

  /** The optimistic-concurrency token a client echoes back on save. */
  get revision(): string | null {
    const at = this.updated_at;
    if (!at) return null;
    const date = at instanceof Date ? at : new Date(at as string);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  override async save(options: SaveOptions = {}): Promise<this> {
    const principal = requireOverviewPrincipal();
    if (!this.tenantId) this.tenantId = principal.tenantId;
    this.syncScopeKey();
    await this.assertPersistedIdentityUnchanged();
    this.validateShape();
    await this.authorize(this);
    this.updatedBy = principal.userId ?? null;
    return super.save(options);
  }

  override async delete(options: DeleteOptions = {}): Promise<void> {
    // Recomputed from the in-memory owner, so a row whose userId was edited
    // before delete() no longer matches its stored identity and is refused.
    this.syncScopeKey();
    await this.assertPersistedIdentityUnchanged();
    await this.authorize(this);
    return super.delete(options);
  }

  private syncScopeKey(): void {
    if (this.scopeType === 'tenant' && this.userId === null) {
      this.scopeKey = TENANT_SCOPE_KEY;
    } else if (this.scopeType === 'user' && this.userId) {
      this.scopeKey = this.userId;
    }
  }

  private validateShape(): void {
    if (
      !this.overviewId ||
      this.overviewId.length > MAX_OVERVIEW_ID_LENGTH ||
      !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(this.overviewId)
    ) {
      throw new Error('OverviewOverrideRecord.overviewId is not a valid id');
    }
    if (!OVERVIEW_SCOPES.includes(this.scopeType)) {
      throw new Error(
        'OverviewOverrideRecord.scopeType must be tenant or user',
      );
    }
    if (this.scopeType === 'tenant' && this.userId !== null) {
      throw new Error('A tenant-default overview row has no userId');
    }
    if (this.scopeType === 'user' && !this.userId) {
      throw new Error('A user overview row needs its userId');
    }
    if (this.formatVersion !== 1) {
      throw new Error('OverviewOverrideRecord.formatVersion must be 1');
    }
    const parsed = this.getOverride();
    if (
      parsed === null ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1
    ) {
      throw new Error('OverviewOverrideRecord.overrideJson must be version 1');
    }
  }

  /**
   * Fail-closed tier guard, applied to the persisted row when there is one.
   * The tenant must be the principal's (the interceptor checks this too; a
   * super-admin bypass does not filter reads, so it is re-checked here), a
   * user row must belong to the principal (a principal with no user id may
   * not touch the user tier), and each tier needs its permission.
   */
  private async authorize(scope: {
    tenantId: string;
    scopeType: string;
    userId: string | null;
  }): Promise<void> {
    const principal = requireOverviewPrincipal();
    if (scope.tenantId !== principal.tenantId) {
      throw new OverviewAccessError(
        'This overview layout belongs to another tenant',
      );
    }
    if (scope.scopeType === 'user') {
      if (!principal.userId || scope.userId !== principal.userId) {
        throw new OverviewAccessError(
          'A personal overview layout can only be changed by its owner',
        );
      }
    }
    const slug =
      scope.scopeType === 'user'
        ? PERSONALIZE_OVERVIEW_PERMISSION
        : CUSTOMIZE_OVERVIEW_PERMISSION;
    await assertOperationPermission({
      collection: OVERVIEW_PERMISSION_COLLECTION,
      action: slug.slice(OVERVIEW_PERMISSION_COLLECTION.length + 1),
      db: this.options.db ?? this.options.persistence,
      tenantId: principal.tenantId,
      userId: principal.userId ?? null,
      permissionSet: principal.permissions,
    });
  }

  /**
   * A persisted row keeps its identity: the stored tenant, overview id and
   * tier must be the ones in memory, so the guard in {@link authorize} always
   * judges the row as stored. Matched by predicate rather than by reading the
   * columns back, because DuckDB returns raw UUID columns as lossy HUGEINTs.
   */
  private async assertPersistedIdentityUnchanged(): Promise<void> {
    if (!this.id) return;
    const byId = await this.db.get(this.tableName, { id: this.id });
    if (!byId) return;
    const same = await this.db.get(this.tableName, {
      id: this.id,
      tenant_id: this.tenantId,
      overview_id: this.overviewId,
      scope_type: this.scopeType,
      scope_key: this.scopeKey,
    });
    if (!same) {
      throw new OverviewAccessError(
        'An overview layout row cannot change its tenant, overview or owner',
      );
    }
  }
}
