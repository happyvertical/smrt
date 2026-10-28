import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  getTenantId,
  isSystemContext,
  TenantScoped,
  tenantId,
  withSystemContext,
} from '@happyvertical/smrt-tenancy';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import {
  type PlanVersionReplacement,
  pinSubscriptionPlanVersion,
} from '../plan-versioning.js';
import type {
  JsonObject,
  PlanVersionPinReason,
  Subscriber,
  SubscriberKind,
  SubscriptionStatus,
  TenantSubscriptionOptions,
} from '../types.js';
import {
  assertSubscriberInvariant,
  parseJsonObject,
  stringifyJson,
} from '../utils.js';

/** In-period replacements requested through `replacePlanVersion()`. */
const pendingReplacements = new WeakMap<
  TenantSubscription,
  PlanVersionReplacement
>();

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: '_smrt_tenant_subscriptions',
  api: { include: ['list', 'get', 'create', 'update'] },
  cli: { skipApiCheck: true },
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
  @field({
    description:
      'Whether the subscriber is your own workspace (tenant) or an outside customer (external).',
  })
  subscriberKind: SubscriberKind = 'tenant';

  /**
   * Caller-namespaced opaque identifier for the subscriber when
   * `subscriberKind === 'external'`. Empty string when kind is `'tenant'`.
   *
   * The package treats this as opaque — no FK, no inferred semantics. Callers
   * are expected to namespace (e.g. `buyer-contact:abc123`,
   * `agent:hermes-7`, `email:foo@example.com`).
   */
  @field({
    description:
      'Who the outside subscriber is, when the subscriber type is external.',
  })
  subscriberExternalId: string = '';

  @field({ description: 'The plan this subscription is for.' })
  @foreignKey('SubscriptionPlan')
  planId: string = '';

  @field({
    description:
      'Where the subscription stands: incomplete, trialing, active, past due, unpaid or cancelled.',
  })
  status: SubscriptionStatus = 'incomplete';
  @field({ description: 'The day the subscription began.' })
  startedAt: Date = new Date();
  @field({ description: 'When the current billing period began.' })
  currentPeriodStart: Date | null = null;
  @field({
    description:
      'When the current billing period ends and the next one is due.',
  })
  currentPeriodEnd: Date | null = null;
  @field({ description: 'When the free trial ends, if there is one.' })
  trialEndsAt: Date | null = null;
  @field({
    description:
      'Tick to let the subscription run out at the end of the current period instead of renewing.',
  })
  cancelAtPeriodEnd: boolean = false;
  @field({ description: 'When the subscription was cancelled.' })
  canceledAt: Date | null = null;
  /** Amount selected for this subscription, in integer minor units. */
  @field({
    description:
      'For a pay-what-you-can plan, the amount the subscriber chose to pay, in cents.',
  })
  agreedAmount: number | null = null;
  /**
   * The immutable `SubscriptionPlanVersion` frozen for the current period
   * (#4032). Maintained on save: pinned at period start, re-pinned when
   * `currentPeriodStart` moves (renewal), and replaced mid-period only by an
   * entitlement upgrade or an authorized {@link replacePlanVersion}. Null
   * only for subscriptions to unmigrated legacy plans with no versions.
   */
  @field({
    description:
      'The version of the plan terms this subscription is held to for the current period. It is kept up to date automatically.',
  })
  @foreignKey('SubscriptionPlanVersion')
  planVersionId: string | null = null;
  /** When {@link planVersionId} was last set. */
  planVersionPinnedAt: Date | null = null;
  /** Why {@link planVersionId} was last set (audit). */
  planVersionPinReason: PlanVersionPinReason | null = null;
  /** Caller-supplied reason for an `upgrade`/`authorized` replacement. */
  planVersionPinNote: string = '';
  /**
   * Set when the row was canceled while it entitled (`active`/`trialing`
   * within its period), so the paid period runs to `currentPeriodEnd`.
   * Derived on save from the stored row and never taken from the caller: a
   * subscription canceled while `incomplete`, `past_due` or `unpaid` (for
   * example a provider's `incomplete_expired`) entitles nothing.
   */
  retainsPaidPeriod: boolean = false;
  externalProvider: string | null = null;
  stripeCustomerId: string = '';
  stripeSubscriptionId: string = '';
  stripeCheckoutSessionId: string = '';
  metadata: string = '{}';

  constructor(options: TenantSubscriptionOptions = {}) {
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
    if (options.agreedAmount !== undefined)
      this.agreedAmount = options.agreedAmount;
    if (options.planVersionId !== undefined)
      this.planVersionId = options.planVersionId;
    if (options.planVersionPinnedAt !== undefined)
      this.planVersionPinnedAt = options.planVersionPinnedAt;
    if (options.planVersionPinReason !== undefined)
      this.planVersionPinReason = options.planVersionPinReason;
    if (options.planVersionPinNote !== undefined)
      this.planVersionPinNote = options.planVersionPinNote;
    if (options.retainsPaidPeriod !== undefined)
      this.retainsPaidPeriod = options.retainsPaidPeriod;
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
    if (
      this.agreedAmount !== null &&
      (!Number.isSafeInteger(this.agreedAmount) || this.agreedAmount < 0)
    ) {
      throw new Error(
        'agreedAmount must be a non-negative integer minor-unit amount',
      );
    }
    const plans = await SubscriptionPlanCollection.create({ db: this.db });
    // Ordinary reads inherit the caller's tenancy. The bounded global fallback
    // permits legacy public plans without exposing any other tenant's plan.
    const scopedPlan = await plans.get({ id: this.planId }, { cache: false });
    const plan =
      scopedPlan ??
      (await withSystemContext(() =>
        plans.get({ id: this.planId, tenantId: null }, { cache: false }),
      ));
    if (
      !plan ||
      (!isSystemContext() &&
        plan.tenantId !== null &&
        plan.tenantId !== (this.tenantId ?? getTenantId() ?? null))
    ) {
      throw new Error('Subscription plan is unavailable');
    }
    if (plan.pricingMode === 'pay_what_you_can') {
      if (
        this.agreedAmount === null ||
        this.agreedAmount < plan.minimumAmount
      ) {
        throw new Error('agreedAmount must meet the plan minimumAmount');
      }
    } else if (this.agreedAmount !== null) {
      throw new Error('agreedAmount requires a pay_what_you_can plan');
    }
    const replacement = pendingReplacements.get(this);
    pendingReplacements.delete(this);
    const { TenantSubscriptionCollection } = await import(
      '../collections/TenantSubscriptionCollection.js'
    );
    // The row this save replaces: by id, or — for a create that will
    // upsert onto an existing subscriber row — by the natural key, so a
    // re-create cannot bypass the paid-period rules.
    const subscriptions = await TenantSubscriptionCollection.create({
      db: this.db,
    });
    const persisted =
      (this.id
        ? await subscriptions.get({ id: String(this.id) }, { cache: false })
        : null) ??
      (this.isPersisted
        ? null
        : ((
            await subscriptions.list({
              where: {
                tenantId: this.tenantId ?? getTenantId() ?? null,
                subscriberKind: this.subscriberKind,
                subscriberExternalId: this.subscriberExternalId,
              },
              limit: 1,
            })
          )[0] ?? null));
    if (this.status !== 'canceled') {
      this.retainsPaidPeriod = false;
    } else if (persisted?.status === 'canceled') {
      this.retainsPaidPeriod = persisted.retainsPaidPeriod;
    } else {
      this.retainsPaidPeriod =
        persisted !== null &&
        (persisted.status === 'active' || persisted.status === 'trialing') &&
        persisted.isEntitled();
    }
    await pinSubscriptionPlanVersion(this, persisted, replacement);
  }

  /**
   * Replace the plan version frozen for the current period and save (#4032).
   *
   * - `policy: 'upgrade'` succeeds only when the target's entitlements cover
   *   the frozen version's (see `isEntitlementUpgrade`); otherwise the save
   *   is rejected and the paid period keeps its terms.
   * - `policy: 'authorized'` accepts any target and requires a `reason`,
   *   recorded with `planVersionPinReason: 'authorized'` for audit — use it
   *   for an operator-approved downgrade, refund, or correction.
   *
   * The target is `planVersionId`, else the version of `planId` (as set on
   * this instance) in force now. A plain `planId` change in the same period
   * is treated as `policy: 'upgrade'`.
   */
  async replacePlanVersion(
    options: PlanVersionReplacement & { planId?: string },
  ): Promise<this> {
    const { planId, ...replacement } = options;
    if (planId !== undefined) this.planId = planId;
    pendingReplacements.set(this, replacement);
    try {
      return await this.save();
    } finally {
      pendingReplacements.delete(this);
    }
  }

  /**
   * Whether the subscription grants entitlements at `now`. Active and
   * trialing subscriptions entitle until `currentPeriodEnd`. A subscription
   * canceled while it entitled keeps its paid period ({@link
   * retainsPaidPeriod}) until `currentPeriodEnd`, never without one (#4032).
   * For an immediate cancellation (for example with a refund) set
   * `currentPeriodEnd` to the cancellation time.
   */
  isEntitled(now = new Date()): boolean {
    const end = this.currentPeriodEnd
      ? new Date(this.currentPeriodEnd).getTime()
      : null;
    if (this.status === 'canceled') {
      return this.retainsPaidPeriod && end !== null && now.getTime() <= end;
    }
    if (this.status !== 'active' && this.status !== 'trialing') {
      return false;
    }
    if (end !== null && end < now.getTime()) {
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
