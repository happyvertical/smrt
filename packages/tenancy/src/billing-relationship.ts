/** Reseller parentage and billing ownership, independent of user permissions. */
import {
  crossPackageRef,
  field,
  isEmbeddedDatabase,
  isPostgresDatabase,
  type SmrtClassOptions,
  SmrtCollection,
  SmrtObject,
  smrt,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import {
  getTenantId,
  isSuperAdminBypass,
  isSystemContext,
  TenantIsolationError,
} from './context.js';

export type BillingOwnerMode = 'self' | 'reseller';

export interface BillingRelationshipView {
  childTenantId: string;
  resellerTenantId: string;
  billingOwnerMode: BillingOwnerMode;
  billingOwnerTenantId: string;
}

export type BillingRelationshipAction = 'read' | 'manage';

export interface BillingRelationshipServiceOptions extends SmrtClassOptions {
  /** Resolve tenant IDs against the host tenant directory. */
  tenantExists: (tenantId: string) => Promise<boolean>;
  /** Optional host permission check for access beyond the built-in context rules. */
  authorize?: (request: {
    action: BillingRelationshipAction;
    childTenantId: string;
    resellerTenantId?: string;
  }) => Promise<boolean>;
}

export class BillingRelationshipError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'INVALID_TENANT'
      | 'INVALID_OWNER_MODE'
      | 'TENANT_NOT_FOUND'
      | 'CIRCULAR_RELATIONSHIP',
  ) {
    super(message);
    this.name = 'BillingRelationshipError';
  }
}

@smrt({
  tableName: '_smrt_billing_relationships',
  conflictColumns: ['child_tenant_id'],
  api: false,
  cli: false,
  mcp: false,
})
export class BillingRelationship extends SmrtObject {
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  @field({ required: true })
  childTenantId: string = '';
  @crossPackageRef('@happyvertical/smrt-users:Tenant')
  @field({ required: true })
  resellerTenantId: string = '';
  billingOwnerMode: BillingOwnerMode = 'self';

  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    assertTenantId(this.childTenantId);
    assertTenantId(this.resellerTenantId);
    assertMode(this.billingOwnerMode);
    if (this.childTenantId === this.resellerTenantId) {
      throw new BillingRelationshipError(
        'A tenant cannot resell to itself.',
        'CIRCULAR_RELATIONSHIP',
      );
    }
  }
}

export class BillingRelationshipCollection extends SmrtCollection<BillingRelationship> {
  static readonly _itemClass = BillingRelationship;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertTenantId(id: string): void {
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    throw new BillingRelationshipError(
      'Tenant IDs must be UUIDs.',
      'INVALID_TENANT',
    );
  }
}

function assertMode(mode: BillingOwnerMode): void {
  if (mode !== 'self' && mode !== 'reseller') {
    throw new BillingRelationshipError(
      'Billing owner mode must be self or reseller.',
      'INVALID_OWNER_MODE',
    );
  }
}

function view(row: BillingRelationship): BillingRelationshipView {
  assertTenantId(row.childTenantId);
  assertTenantId(row.resellerTenantId);
  assertMode(row.billingOwnerMode);
  return {
    childTenantId: row.childTenantId,
    resellerTenantId: row.resellerTenantId,
    billingOwnerMode: row.billingOwnerMode,
    billingOwnerTenantId:
      row.billingOwnerMode === 'reseller'
        ? row.resellerTenantId
        : row.childTenantId,
  };
}

/**
 * The one-row-per-child billing graph. The host supplies tenant existence and
 * any additional authorization; absent a host authorizer, only an explicit
 * system context can mutate relationships.
 */
export class BillingRelationshipService {
  private constructor(
    private readonly relationships: BillingRelationshipCollection,
    private readonly options: BillingRelationshipServiceOptions,
  ) {}

  static async create(
    options: BillingRelationshipServiceOptions,
  ): Promise<BillingRelationshipService> {
    if (typeof options.tenantExists !== 'function') {
      throw new Error('Billing relationships require a tenantExists resolver.');
    }
    const relationships = await BillingRelationshipCollection.create(options);
    if (/^(?:https?|libsql):\/\//iu.test(relationships.db.url ?? '')) {
      throw new Error(
        'Billing relationships require a local SQL or PostgreSQL database with serialized transactions.',
      );
    }
    if (!relationships.db.transaction) {
      throw new Error('Billing relationships require database transactions.');
    }
    return new BillingRelationshipService(relationships, options);
  }

  /** A tenant without a relationship always pays for itself. */
  async resolveBillingOwner(childTenantId: string): Promise<string> {
    assertTenantId(childTenantId);
    const row = await this.relationships.get({ childTenantId });
    await this.assertReadable(childTenantId, row?.resellerTenantId);
    await this.assertExists(childTenantId);
    if (row) await this.assertExists(row.resellerTenantId);
    return row ? view(row).billingOwnerTenantId : childTenantId;
  }

  async getRelationship(
    childTenantId: string,
  ): Promise<BillingRelationshipView | null> {
    assertTenantId(childTenantId);
    const row = await this.relationships.get({ childTenantId });
    await this.assertReadable(childTenantId, row?.resellerTenantId);
    await this.assertExists(childTenantId);
    if (row) await this.assertExists(row.resellerTenantId);
    return row ? view(row) : null;
  }

  /** List direct children billed to an owner, with no collection page limit. */
  async listChildrenBilledTo(ownerTenantId: string): Promise<string[]> {
    assertTenantId(ownerTenantId);
    await this.assertReadable(ownerTenantId);
    await this.assertExists(ownerTenantId);
    const result = await this.relationships.db.query(
      'SELECT child_tenant_id FROM _smrt_billing_relationships WHERE reseller_tenant_id = ? AND billing_owner_mode = ? ORDER BY child_tenant_id',
      ownerTenantId,
      'reseller',
    );
    return result.rows.map((row) => {
      const childTenantId = String(row.child_tenant_id);
      assertTenantId(childTenantId);
      return childTenantId;
    });
  }

  /** Create or replace parentage and its default billing owner in one row. */
  async setRelationship(input: {
    childTenantId: string;
    resellerTenantId: string;
    billingOwnerMode: BillingOwnerMode;
  }): Promise<BillingRelationshipView> {
    const { childTenantId, resellerTenantId, billingOwnerMode } = input;
    assertTenantId(childTenantId);
    assertTenantId(resellerTenantId);
    assertMode(billingOwnerMode);
    await this.assertManage(childTenantId, resellerTenantId);
    await this.assertExists(childTenantId);
    await this.assertExists(resellerTenantId);
    if (childTenantId === resellerTenantId) {
      throw new BillingRelationshipError(
        'A tenant cannot resell to itself.',
        'CIRCULAR_RELATIONSHIP',
      );
    }
    return withEmbeddedWriteTransaction(
      this.relationships.db,
      isEmbeddedDatabase(this.relationships.db),
      async (db) => {
        if (isPostgresDatabase(db)) {
          await db.query(
            "SELECT pg_advisory_xact_lock(hashtext('smrt-billing-relationships'))",
          );
        }
        const relationships = await BillingRelationshipCollection.create({
          db,
        });
        await this.assertAcyclic(
          relationships,
          childTenantId,
          resellerTenantId,
        );
        const existing = await relationships.get({ childTenantId });
        if (existing && existing.resellerTenantId !== resellerTenantId) {
          await this.assertManage(childTenantId, existing.resellerTenantId);
        }
        const row = existing
          ? Object.assign(existing, { resellerTenantId, billingOwnerMode })
          : await relationships.create({
              childTenantId,
              resellerTenantId,
              billingOwnerMode,
            });
        if (existing) await row.save();
        return view(row);
      },
    );
  }

  /** Remove reseller parentage. The child becomes self-billed. */
  async clearRelationship(childTenantId: string): Promise<void> {
    assertTenantId(childTenantId);
    await withEmbeddedWriteTransaction(
      this.relationships.db,
      isEmbeddedDatabase(this.relationships.db),
      async (db) => {
        if (isPostgresDatabase(db)) {
          await db.query(
            "SELECT pg_advisory_xact_lock(hashtext('smrt-billing-relationships'))",
          );
        }
        const relationships = await BillingRelationshipCollection.create({
          db,
        });
        const current = await relationships.get({ childTenantId });
        await this.assertManage(childTenantId, current?.resellerTenantId);
        if (current?.id) {
          // SmrtObject.delete() starts its own cascade transaction, which
          // DuckDB cannot nest. This row has no dependents, so delete it on
          // the already-bound transaction handle.
          await db.delete('_smrt_billing_relationships', { id: current.id });
        }
      },
    );
  }

  private async assertAcyclic(
    relationships: BillingRelationshipCollection,
    childTenantId: string,
    resellerTenantId: string,
  ): Promise<void> {
    const visited = new Set([childTenantId]);
    let cursor: string | undefined = resellerTenantId;
    while (cursor) {
      if (visited.has(cursor)) {
        throw new BillingRelationshipError(
          'Reseller relationships cannot form a cycle.',
          'CIRCULAR_RELATIONSHIP',
        );
      }
      visited.add(cursor);
      const row = await relationships.get({ childTenantId: cursor });
      cursor = row?.resellerTenantId;
    }
  }

  private async assertExists(tenantId: string): Promise<void> {
    assertTenantId(tenantId);
    if (!(await this.options.tenantExists(tenantId))) {
      throw new BillingRelationshipError(
        `Tenant not found: ${tenantId}`,
        'TENANT_NOT_FOUND',
      );
    }
  }

  private async assertReadable(
    childTenantId: string,
    resellerTenantId?: string,
  ): Promise<void> {
    if (
      isSystemContext() ||
      isSuperAdminBypass() ||
      getTenantId() === childTenantId ||
      (resellerTenantId && getTenantId() === resellerTenantId) ||
      (await this.options.authorize?.({
        action: 'read',
        childTenantId,
        resellerTenantId,
      }))
    ) {
      return;
    }
    throw new TenantIsolationError('Billing relationship access denied.');
  }

  private async assertManage(
    childTenantId: string,
    resellerTenantId?: string,
  ): Promise<void> {
    if (
      isSystemContext() ||
      isSuperAdminBypass() ||
      (await this.options.authorize?.({
        action: 'manage',
        childTenantId,
        resellerTenantId,
      }))
    ) {
      return;
    }
    throw new TenantIsolationError('Billing relationship mutation denied.');
  }
}
