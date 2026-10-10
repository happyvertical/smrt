import {
  crossPackageRef,
  field,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { assertOperationPermission } from '@happyvertical/smrt-users';
import {
  PreferenceAccessError,
  requirePreferencePrincipal,
} from '../context.js';
import {
  PREFERENCE_KIND_PATTERN,
  PREFERENCE_SCOPES,
  PREFERENCE_SURFACE_PATTERN,
  type PreferenceScope,
  requirePreferenceKind,
} from '../kinds.js';
import {
  ensurePreferencePermissionsRegistered,
  splitPermissionSlug,
} from '../permissions.js';

// Direct model imports (tests, server integrations) must still find the
// built-in slugs in the shared users catalog before any guard asks for them.
ensurePreferencePermissionsRegistered();

type SaveOptions = NonNullable<Parameters<SmrtObject['save']>[0]>;
type DeleteOptions = NonNullable<Parameters<SmrtObject['delete']>[0]>;

/** `scopeKey` of a tenant-default row (user rows use the user id). */
export const TENANT_SCOPE_KEY = '__tenant__';

/**
 * One stored user-interface preference (#3727): the canonical payload of a
 * registered preference kind (`overview`, `shell-layout`, ...) for one surface
 * at one tier of one tenant.
 *
 * - `scopeType: 'tenant'` is the tenant default (`userId` null), written with
 *   the kind's tenant permission.
 * - `scopeType: 'user'` is one person's preference on top of the tenant
 *   default, inside that tenant. Only that user may write it, with the kind's
 *   user permission.
 *
 * Every row carries its tenant, so the table is `@TenantScoped` (required):
 * the tenancy interceptor filters reads and refuses foreign rows, and the
 * save/delete guards below re-check identity, tier ownership and the kind's
 * permission. The kind's validator (run by the store) owns the payload's
 * content; this model owns identity, scope shape and authorization, and
 * refuses any kind that is not registered.
 *
 * No generated surface: a payload is only meaningful after its kind's
 * validation, which a generated route would skip.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_ui_preferences',
  conflictColumns: [
    'tenant_id',
    'kind',
    'surface_id',
    'scope_type',
    'scope_key',
  ],
  api: { include: [] },
  cli: false,
  mcp: { include: [] },
})
export class UiPreferenceRecord extends SmrtObject {
  /** Owning tenant (native UUID on PostgreSQL/DuckDB). */
  @tenantId()
  tenantId: string = '';

  /** The registered preference kind (`overview`, `shell-layout`, ...). */
  @field({ required: true })
  kind: string = '';

  /** The surface within the kind (an overview id, a shell key). */
  @field({ required: true })
  surfaceId: string = '';

  /** `tenant` (the tenant default) or `user` (one person's preference). */
  @field({ required: true })
  scopeType: PreferenceScope = 'tenant';

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

  /** The kind's canonical payload as JSON text. */
  @field({ type: 'text', required: true })
  payloadJson: string = '';

  /** The kind's format version the payload was written at. */
  @field({ type: 'integer' })
  formatVersion: number = 1;

  /** Who last wrote the row; stamped from the ambient principal. */
  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  updatedBy: string | null = null;

  /** The stored payload, parsed. `undefined` when the text is not JSON. */
  getPayload(): unknown {
    try {
      return JSON.parse(this.payloadJson);
    } catch {
      return undefined;
    }
  }

  /** Store a payload; the caller passes the kind's canonical value. */
  setPayload(value: unknown): void {
    this.payloadJson = JSON.stringify(value);
  }

  /** The optimistic-concurrency token a client echoes back on save. */
  get revision(): string | null {
    const at = this.updated_at;
    if (!at) return null;
    const date = at instanceof Date ? at : new Date(at as string);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }

  override async save(options: SaveOptions = {}): Promise<this> {
    const principal = requirePreferencePrincipal();
    if (!this.tenantId) this.tenantId = principal.tenantId;
    this.syncScopeKey();
    await this.assertPersistedIdentityUnchanged();
    this.validateShape();
    await this.authorize();
    this.updatedBy = principal.userId ?? null;
    return super.save(options);
  }

  override async delete(options: DeleteOptions = {}): Promise<void> {
    // Recomputed from the in-memory owner, so a row whose userId was edited
    // before delete() no longer matches its stored identity and is refused.
    this.syncScopeKey();
    await this.assertPersistedIdentityUnchanged();
    await this.authorize();
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
    if (!PREFERENCE_KIND_PATTERN.test(this.kind)) {
      throw new Error('UiPreferenceRecord.kind is not a valid kind id');
    }
    if (!PREFERENCE_SURFACE_PATTERN.test(this.surfaceId)) {
      throw new Error('UiPreferenceRecord.surfaceId is not a valid id');
    }
    if (!PREFERENCE_SCOPES.includes(this.scopeType)) {
      throw new Error('UiPreferenceRecord.scopeType must be tenant or user');
    }
    if (this.scopeType === 'tenant' && this.userId !== null) {
      throw new Error('A tenant-default preference row has no userId');
    }
    if (this.scopeType === 'user' && !this.userId) {
      throw new Error('A user preference row needs its userId');
    }
    if (!Number.isSafeInteger(this.formatVersion) || this.formatVersion < 1) {
      throw new Error('UiPreferenceRecord.formatVersion must be positive');
    }
    if (this.getPayload() === undefined) {
      throw new Error('UiPreferenceRecord.payloadJson must be JSON');
    }
  }

  /**
   * Fail-closed tier guard. The tenant must be the principal's (the
   * interceptor checks this too; a super-admin bypass does not filter reads,
   * so it is re-checked here), a user row must belong to the principal (a
   * principal with no user id may not touch the user tier), the kind must be
   * registered, and its permission for the tier must be held.
   */
  private async authorize(): Promise<void> {
    const principal = requirePreferencePrincipal();
    const kind = requirePreferenceKind(this.kind);
    if (this.tenantId !== principal.tenantId) {
      throw new PreferenceAccessError(
        'This preference belongs to another tenant',
      );
    }
    if (this.scopeType === 'user') {
      if (!principal.userId || this.userId !== principal.userId) {
        throw new PreferenceAccessError(
          'A personal preference can only be changed by its owner',
        );
      }
    }
    const slug =
      this.scopeType === 'user'
        ? kind.permissions.user
        : kind.permissions.tenant;
    await assertOperationPermission({
      ...splitPermissionSlug(slug),
      db: this.options.db ?? this.options.persistence,
      tenantId: principal.tenantId,
      userId: principal.userId ?? null,
      permissionSet: principal.permissions,
    });
  }

  /**
   * A persisted row keeps its identity: the stored tenant, kind, surface and
   * tier must be the ones in memory, so {@link authorize} always judges the
   * row as stored. Matched by predicate rather than by reading the columns
   * back, because DuckDB returns raw UUID columns as lossy HUGEINTs.
   */
  private async assertPersistedIdentityUnchanged(): Promise<void> {
    if (!this.id) return;
    const byId = await this.db.get(this.tableName, { id: this.id });
    if (!byId) return;
    const same = await this.db.get(this.tableName, {
      id: this.id,
      tenant_id: this.tenantId,
      kind: this.kind,
      surface_id: this.surfaceId,
      scope_type: this.scopeType,
      scope_key: this.scopeKey,
    });
    if (!same) {
      throw new PreferenceAccessError(
        'A preference row cannot change its tenant, kind, surface or owner',
      );
    }
  }
}
