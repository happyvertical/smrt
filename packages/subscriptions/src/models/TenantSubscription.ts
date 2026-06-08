import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  JsonObject,
  Subscriber,
  SubscriberKind,
  SubscriptionStatus,
} from '../types.js';
import {
  assertSubscriberInvariant,
  parseJsonObject,
  stringifyJson,
} from '../utils.js';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_tenant_subscriptions',
  api: { include: ['list', 'get', 'create', 'update'] },
  cli: true,
  mcp: { include: ['list', 'get'] },
  // The conflict key includes the subscriber discriminator so an issuing tenant
  // can host many distinct external subscribers without collisions on the
  // unique index:
  //   - tenant-kind rows always have subscriber_external_id = '' → uniqueness
  //     reduces to (tenant_id, 'tenant', '') = at most one tenant-kind row per
  //     tenant (preserves the pre-polymorphic invariant).
  //   - external-kind rows are unique on (tenant_id, 'external', externalId) =
  //     at most one active subscription per (issuer, external subscriber).
  //
  // UPGRADE NOTE: databases created against the pre-#1454 conflict key
  // ['tenant_id'] still carry the legacy `_smrt_tenant_subscriptions_tenant_id_idx`.
  // `smrt db:migrate` does not sweep orphan indexes by default, so the legacy
  // index persists and continues to reject external subscriptions until it's
  // dropped. Run scripts/migrate-1454-drop-legacy-conflict-index.ts once on
  // upgrade, or pass `--drop-indexes` to `db:migrate`. Fresh databases need
  // neither — the generated schema already reflects the new key.
  conflictColumns: ['tenant_id', 'subscriber_kind', 'subscriber_external_id'],
})
export class TenantSubscription extends SmrtObject {
  @tenantId()
  tenantId?: string;

  /**
   * Discriminator for the subscriber identity.
   *
   * - `'tenant'` (default): the subscriber IS the owning `tenantId` — the
   *   pre-polymorphic shape. All existing rows continue to behave this way.
   * - `'external'`: the subscriber is `subscriberExternalId`, scoped under the
   *   issuing `tenantId`. Used for B2C buyers, anonymous-email subscribers,
   *   agent identities, and any other caller-defined identity.
   */
  subscriberKind: SubscriberKind = 'tenant';

  /**
   * Caller-namespaced opaque identifier for the subscriber when
   * `subscriberKind === 'external'`. Empty string when kind is `'tenant'`.
   *
   * The package treats this as opaque — no FK, no inferred semantics. Callers
   * are expected to namespace (e.g. `buyer-contact:abc123`,
   * `agent:hermes-7`, `email:foo@example.com`).
   */
  subscriberExternalId: string = '';

  @foreignKey('SubscriptionPlan')
  planId: string = '';

  status: SubscriptionStatus = 'incomplete';
  startedAt: Date = new Date();
  currentPeriodStart: Date | null = null;
  currentPeriodEnd: Date | null = null;
  trialEndsAt: Date | null = null;
  cancelAtPeriodEnd: boolean = false;
  canceledAt: Date | null = null;
  externalProvider: string = 'stripe';
  stripeCustomerId: string = '';
  stripeSubscriptionId: string = '';
  stripeCheckoutSessionId: string = '';
  metadata: string = '{}';

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.subscriberKind !== undefined)
      this.subscriberKind = options.subscriberKind;
    if (options.subscriberExternalId !== undefined)
      this.subscriberExternalId = options.subscriberExternalId;
    // Enforce the subscriber XOR invariant at construction time so callers
    // catch mistakes early. The same check also runs in `validateBeforeSave`
    // below so the generated PUT/PATCH update path — which mutates an existing
    // instance via `Object.assign()` and bypasses this constructor — can't
    // sneak a malformed row past us either.
    assertSubscriberInvariant('TenantSubscription', {
      subscriberKind: this.subscriberKind,
      subscriberExternalId: this.subscriberExternalId,
    });
    if (options.planId !== undefined) this.planId = options.planId;
    if (options.status !== undefined) this.status = options.status;
    if (options.startedAt !== undefined) this.startedAt = options.startedAt;
    if (options.currentPeriodStart !== undefined) {
      this.currentPeriodStart = options.currentPeriodStart;
    }
    if (options.currentPeriodEnd !== undefined) {
      this.currentPeriodEnd = options.currentPeriodEnd;
    }
    if (options.trialEndsAt !== undefined)
      this.trialEndsAt = options.trialEndsAt;
    if (options.cancelAtPeriodEnd !== undefined) {
      this.cancelAtPeriodEnd = options.cancelAtPeriodEnd;
    }
    if (options.canceledAt !== undefined) this.canceledAt = options.canceledAt;
    if (options.externalProvider !== undefined) {
      this.externalProvider = options.externalProvider;
    }
    if (options.stripeCustomerId !== undefined) {
      this.stripeCustomerId = options.stripeCustomerId;
    }
    if (options.stripeSubscriptionId !== undefined) {
      this.stripeSubscriptionId = options.stripeSubscriptionId;
    }
    if (options.stripeCheckoutSessionId !== undefined) {
      this.stripeCheckoutSessionId = options.stripeCheckoutSessionId;
    }
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Validates the subscriber XOR invariant before every save. Critical for the
   * generated update path: `SmrtCollection.update()` mutates the existing
   * instance via `Object.assign()` and calls `save()` directly — the
   * constructor never re-runs, so without this hook a partial update like
   * `{ subscriberExternalId: 'buyer:alice' }` on a tenant-kind row would
   * persist a malformed conflict key and let two tenant-kind rows coexist
   * under the same tenant.
   */
  protected async validateBeforeSave(): Promise<void> {
    await super.validateBeforeSave();
    assertSubscriberInvariant('TenantSubscription', {
      subscriberKind: this.subscriberKind,
      subscriberExternalId: this.subscriberExternalId,
    });
  }

  isEntitled(now = new Date()): boolean {
    if (this.status !== 'active' && this.status !== 'trialing') {
      return false;
    }
    if (
      this.currentPeriodEnd &&
      this.currentPeriodEnd.getTime() < now.getTime()
    ) {
      return false;
    }
    return true;
  }

  /**
   * Project this row's polymorphic subscriber columns onto the
   * {@link Subscriber} discriminated union. Returns `null` when the owning
   * tenant is absent — that's an invalid row that should not be acted on.
   */
  getSubscriber(): Subscriber | null {
    if (!this.tenantId) {
      return null;
    }
    if (this.subscriberKind === 'external') {
      if (!this.subscriberExternalId) {
        return null;
      }
      return {
        kind: 'external',
        tenantId: this.tenantId,
        externalId: this.subscriberExternalId,
      };
    }
    return { kind: 'tenant', tenantId: this.tenantId };
  }

  getMetadata(): JsonObject {
    return parseJsonObject(this.metadata, {});
  }

  setMetadata(metadata: JsonObject): void {
    this.metadata = stringifyJson(metadata);
  }
}

export default TenantSubscription;
