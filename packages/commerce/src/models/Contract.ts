/**
 * Contract model with STI for different contract types
 * @packageDocumentation
 */

import {
  foreignKey,
  type Meta,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  type ContractOptions,
  ContractStatus,
  ContractType,
  type LicenseSaleOptions,
} from '../types/index.js';
import { Customer } from './Customer.js';
import { Vendor } from './Vendor.js';

/**
 * Legal status transitions for a Contract (and all its STI subtypes), keyed by
 * the prior persisted status. A status re-saved unchanged (no-op) and a
 * brand-new row are always permitted; this map governs *changes* only.
 *
 * Flow: DRAFT → SENT → (ACCEPTED | DECLINED); ACCEPTED → (COMPLETED |
 * CANCELLED). An estimate/order may also be cancelled directly from DRAFT/SENT.
 * DECLINED / COMPLETED / CANCELLED are terminal. This guards against raw
 * mass-assignment forcing, e.g., a DECLINED contract back to ACCEPTED or a
 * COMPLETED one back to DRAFT. See S5 audit #1390.
 */
const CONTRACT_STATUS_TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  [ContractStatus.DRAFT]: [
    ContractStatus.SENT,
    ContractStatus.ACCEPTED,
    ContractStatus.DECLINED,
    ContractStatus.CANCELLED,
  ],
  [ContractStatus.SENT]: [
    ContractStatus.ACCEPTED,
    ContractStatus.DECLINED,
    ContractStatus.CANCELLED,
  ],
  [ContractStatus.ACCEPTED]: [
    ContractStatus.COMPLETED,
    ContractStatus.CANCELLED,
  ],
  [ContractStatus.DECLINED]: [],
  [ContractStatus.COMPLETED]: [],
  [ContractStatus.CANCELLED]: [],
};

/**
 * Module-scoped record of the status each Contract instance was loaded with,
 * for the save-time transition guard. WeakMap keeps it out of the schema and
 * GCs with the instance — same pattern as the other commerce models.
 */
const loadedContractStatus = new WeakMap<Contract, ContractStatus>();

/**
 * Contract is the base class for all commercial agreements.
 *
 * Uses Single Table Inheritance (STI) to support different contract types:
 * - Estimate: Quote/proposal for customer
 * - Order: Customer purchase order
 * - Lease: Rental/lease agreement
 * - Agreement: Service/maintenance agreement
 * - PurchaseOrder: Order to vendor/supplier
 *
 * @example
 * ```typescript
 * // Create a customer order
 * const order = await contracts.create({
 *   _meta_type: 'Order',
 *   customerId: customer.id,
 *   totalAmount: 1500.00,
 *   status: ContractStatus.DRAFT
 * });
 *
 * // Create a purchase order to vendor
 * const po = await contracts.create({
 *   _meta_type: 'PurchaseOrder',
 *   vendorId: vendor.id,
 *   totalAmount: 5000.00,
 *   reference: 'PO-2024-001'
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class Contract extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   * Nullable to support both tenant-scoped and global contracts
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Contract type discriminator (STI)
   */
  contractType: ContractType = ContractType.ORDER;

  /**
   * Current status of the contract
   */
  status: ContractStatus = ContractStatus.DRAFT;

  /**
   * Customer ID (for sales contracts: Estimate, Order, Agreement)
   */
  @foreignKey(Customer)
  customerId: string = '';

  /**
   * Vendor ID (for purchase contracts: PurchaseOrder)
   */
  @foreignKey(Vendor)
  vendorId: string = '';

  /**
   * Subtotal before tax
   */
  subtotal: number = 0.0;

  /**
   * Tax amount
   */
  taxAmount: number = 0.0;

  /**
   * Total amount including tax
   */
  totalAmount: number = 0.0;

  /**
   * Currency code (ISO 4217)
   */
  currency: string = 'USD';

  /**
   * Date contract was issued
   */
  issueDate: Date = new Date();

  /**
   * Payment due date
   */
  dueDate: Date | null = null;

  /**
   * Expiry date (for estimates/quotes)
   */
  expiryDate: Date | null = null;

  /**
   * External reference number (PO number, quote number, etc.)
   */
  reference: string = '';

  /**
   * Internal notes
   */
  notes: string = '';

  /**
   * Terms and conditions
   */
  terms: string = '';

  /**
   * Sales channel that owns this contract.
   *
   * Plain string so consumers can model their own channels without an enum
   * change (e.g. `dtc-web`, `wholesale-b2b`, `pos-store-1`, `marketplace-faire`).
   * Empty string means "unattributed / legacy".
   */
  channelId: string = '';

  /**
   * STI discriminator field
   */
  static readonly _stiField = 'contractType';

  constructor(options: ContractOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.contractType !== undefined)
      this.contractType = options.contractType;
    if (options.status !== undefined) this.status = options.status;
    if (options.customerId !== undefined) this.customerId = options.customerId;
    if (options.vendorId !== undefined) this.vendorId = options.vendorId;
    if (options.subtotal !== undefined) this.subtotal = options.subtotal;
    if (options.taxAmount !== undefined) this.taxAmount = options.taxAmount;
    if (options.totalAmount !== undefined)
      this.totalAmount = options.totalAmount;
    if (options.currency !== undefined) this.currency = options.currency;
    if (options.issueDate !== undefined) this.issueDate = options.issueDate;
    if (options.dueDate !== undefined) this.dueDate = options.dueDate;
    if (options.expiryDate !== undefined) this.expiryDate = options.expiryDate;
    if (options.reference !== undefined) this.reference = options.reference;
    if (options.notes !== undefined) this.notes = options.notes;
    if (options.terms !== undefined) this.terms = options.terms;
    if (options.channelId !== undefined) this.channelId = options.channelId;
  }

  /**
   * Check if contract is in draft state
   */
  isDraft(): boolean {
    return this.status === ContractStatus.DRAFT;
  }

  /**
   * Check if contract is accepted
   */
  isAccepted(): boolean {
    return this.status === ContractStatus.ACCEPTED;
  }

  /**
   * Check if contract is completed
   */
  isCompleted(): boolean {
    return this.status === ContractStatus.COMPLETED;
  }

  /**
   * Check if contract is expired (for estimates)
   */
  isExpired(): boolean {
    if (!this.expiryDate) return false;
    return new Date() > this.expiryDate;
  }

  /**
   * Check if contract is overdue
   */
  isOverdue(): boolean {
    if (!this.dueDate) return false;
    if (this.status === ContractStatus.COMPLETED) return false;
    return new Date() > this.dueDate;
  }

  /**
   * Calculate and update totals from line items
   */
  async recalculateTotals(): Promise<void> {
    // This would typically query ContractLineItems and sum them
    // For now, just ensure totalAmount = subtotal + taxAmount
    this.totalAmount = this.subtotal + this.taxAmount;
  }

  /**
   * Capture the status the row was loaded with so the save-time transition
   * guard can reject illegal status flips made via raw field assignment
   * (mass-assignment on the generated update route, a stale caller, etc.).
   * Only persisted rows carry a prior status.
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved()) {
      loadedContractStatus.set(this, this.status);
    }
    return this;
  }

  /**
   * Validate the status transition before persisting, then save. Inherited by
   * every STI subtype (Estimate/Order/Lease/.../LicenseSale), so a forged
   * `status` on any of them is caught here. LicenseSale layers its own
   * rights-immutability guard on top via `super.save()`. See S5 audit #1390.
   */
  override async save(): Promise<this> {
    const prior = await this.resolvePriorStatus();
    this.assertContractStatusTransition(prior);
    const result = (await super.save()) as this;
    loadedContractStatus.set(this, this.status);
    return result;
  }

  /**
   * Reject an illegal status flip done via raw assignment. No-op transitions
   * and brand-new rows are always allowed.
   */
  protected assertContractStatusTransition(
    prior: ContractStatus | undefined,
  ): void {
    if (prior === undefined) return; // new row — any starting status is fine
    if (prior === this.status) return; // no-op re-save
    const allowed = CONTRACT_STATUS_TRANSITIONS[prior] ?? [];
    if (!allowed.includes(this.status)) {
      throw new Error(
        `Contract ${this.reference || this.id}: illegal status transition ` +
          `'${prior}' → '${this.status}'.`,
      );
    }
  }

  /**
   * Resolve the AUTHORITATIVE prior status (S5 audit #1390 round 5, codex
   * MEDIUM#2). The WeakMap is only populated when {@link initialize} loaded the
   * row from the DB; it is empty for an instance built via
   * `collection.create({ id: <existing>, _skipLoad: true })` — the upsert path
   * that lets a caller write onto an existing row without hydrating it. Trusting
   * an empty WeakMap there would treat the write as a brand-new row and skip the
   * transition guard entirely (a poisonable prior-state). Mirrors the
   * authoritative-prior-load applied to Payment/PaymentIntent/Invoice/Payout.
   *
   * So when this instance carries an `id`, read the persisted row straight from
   * the database and treat its `status` as the prior — a create-onto-existing is
   * an update. Only when no row exists in the DB (truly new) do we fall back to
   * the WeakMap (which is also empty then), i.e. `undefined` = genuinely new.
   * The raw row's `status` column is single-word (no snake_case transform).
   */
  protected async resolvePriorStatus(): Promise<ContractStatus | undefined> {
    if (this.id) {
      try {
        const row = await this.db.get(this.tableName, { id: this.id });
        if (row && row.status != null) {
          return row.status as ContractStatus;
        }
      } catch {
        // DB not ready / table absent — fall through to the in-memory record.
      }
    }
    return loadedContractStatus.get(this);
  }
}

// Every STI child below MUST repeat the `@TenantScoped` decoration. The
// tenancy registry keys off the concrete className passed by the
// collection, not the inheritance chain — `OrderCollection.list()` sends
// `'Order'` to the interceptor, which then misses the `'Contract'`
// registration and skips tenant auto-filter/auto-populate. Without an
// explicit `@TenantScoped` on each subclass, saves end up with
// `tenantId: null` (the row becomes global / invisible to tenant-scoped
// queries) and lists return rows across tenants.

/**
 * Estimate - Quote or proposal for a customer
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class Estimate extends Contract {
  override contractType = ContractType.ESTIMATE;
}

/**
 * Order - Customer purchase order
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class Order extends Contract {
  override contractType = ContractType.ORDER;
}

/**
 * Lease - Rental or lease agreement
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class Lease extends Contract {
  override contractType = ContractType.LEASE;
}

/**
 * Agreement - Service or maintenance agreement
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class Agreement extends Contract {
  override contractType = ContractType.AGREEMENT;
}

/**
 * PurchaseOrder - Order sent to vendor/supplier
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class PurchaseOrder extends Contract {
  override contractType = ContractType.PURCHASE_ORDER;
}

/**
 * WholesaleOrder - B2B order placed by a wholesale customer.
 *
 * Behaves like an Order but is conventionally created against a customer with
 * `customerType: 'wholesale'`, uses NET-30/60 payment terms, and is delivered
 * via the wholesale-portal channel rather than retail checkout.
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class WholesaleOrder extends Contract {
  override contractType = ContractType.WHOLESALE_ORDER;
}

/**
 * ProductionOrder - instruction to commission goods from an internal or
 * external factory.
 *
 * The manufacturing equivalent of a {@link PurchaseOrder} — but instead of
 * buying finished inventory, you're paying to *make* it. A ProductionOrder
 * consumes raw materials per a Bill of Materials (see
 * `@happyvertical/smrt-manufacturing`) and produces finished SKU stock when
 * posted (see `@happyvertical/smrt-inventory`).
 *
 * Carries two STI-meta fields that `ProductionService.consumeMaterials` /
 * `runProduction` read from the loaded row to resolve which BOM to walk:
 *
 *   - `productId` — plain string ref to the upstream `Product` (or any
 *     STI subtype, e.g. apparel `Style`). Used to look up the *active*
 *     BOM via `BomService.findActiveForProduct` when no explicit
 *     revision was pinned at the time the order was placed.
 *   - `bomId` — optional pin to a specific BOM revision. When set, the
 *     manufacturing service consumes against that exact revision even
 *     if a newer BOM has become active in the meantime (keeps a
 *     posted run from silently switching recipes mid-flight).
 *
 * Both fields are `Meta<string>` so the scanner routes them into the
 * shared `_meta_data` JSON column on the Contract STI table instead of
 * widening the base schema with manufacturing-specific columns.
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class ProductionOrder extends Contract {
  override contractType = ContractType.PRODUCTION_ORDER;

  /**
   * Plain string reference to the upstream product the order is asked
   * to make. Cross-package id; never `@foreignKey()`. Required by
   * `ProductionService.consumeMaterials` unless `bomId` is supplied.
   */
  productId: Meta<string> = '';

  /**
   * Optional explicit BOM revision the order locked to at posting
   * time. When set, manufacturing uses this exact row even if the
   * product's active BOM has since changed. When empty, falls back
   * to the active BOM for `productId`.
   */
  bomId: Meta<string> = '';
}

/**
 * Cart - transient order-in-progress for a shopper.
 *
 * Persisted as a Contract so it can hold the same line items, totals, and
 * customer reference as a real Order, then convert in place (the application
 * promotes the row from `_meta_type: Cart` to `_meta_type: Order` at checkout
 * rather than copying data between tables).
 *
 * A Cart starts in {@link ContractStatus.DRAFT} via the base `Contract.status`
 * default — the subclass doesn't need its own override. Application code
 * is responsible for promoting the row to `ContractStatus.PENDING` /
 * `ACCEPTED` at checkout time; the framework doesn't enforce a state
 * machine on the cart → order transition.
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class Cart extends Contract {
  override contractType = ContractType.CART;
}

/**
 * Snapshot of the rights granted by a {@link LicenseSale}. The fields are
 * intentionally typed (not a generic JSON blob) so they survive schema
 * migrations and downstream consumers (PDF templating, hash-registry
 * publishers) can rely on the shape without re-parsing.
 *
 * Each field is opaque text — the values that make sense vary by
 * industry. A stock-media marketplace might use:
 *
 * - `medium`: `web,print,social`
 * - `distributionScope`: `worldwide` / `territorial`
 * - `exclusivity`: `exclusive` / `non-exclusive`
 * - `duration`: `perpetual` / `12-months` / `event-only`
 * - `territory`: ISO-3166 list or `worldwide`
 *
 * Booleans (`sublicensing`, `derivatives`) are typed as such; everything
 * else is a string so the model doesn't dictate vocabulary.
 */
export interface LicenseRightsSnapshot {
  medium: string;
  distributionScope: string;
  exclusivity: string;
  duration: string;
  territory: string;
  sublicensing: boolean;
  derivatives: boolean;
}

/**
 * Module-scoped WeakMap of "rights snapshot the row was loaded with".
 *
 * Used by {@link LicenseSale}'s immutability guard. We can't store the
 * captured snapshot as an instance field because the AST scanner would
 * pick it up as a persisted column; we can't store it as a `Meta<T>`
 * because then it'd round-trip with the row and the comparison would
 * always tautologically succeed. A WeakMap keyed by the instance is
 * the cleanest scope: no schema interaction, garbage-collected with
 * the instance.
 */
const issuedRightsSnapshot = new WeakMap<LicenseSale, string>();

/**
 * LicenseSale — industry-neutral licensing primitive.
 *
 * Sits alongside the other Contract STI subtypes (Estimate, Order,
 * Lease, Agreement, PurchaseOrder, WholesaleOrder, ProductionOrder,
 * Cart) and represents a single sale of rights for a fee. A
 * stock-media marketplace selling a one-time license, a music-
 * licensing platform issuing a sync license, a code-asset marketplace
 * granting a redistribution right — all use the same primitive.
 *
 * Immutability invariant: once a `LicenseSale` is saved with
 * {@link ContractStatus.ACCEPTED}, its rights snapshot becomes
 * frozen. Re-saving with mutated rights throws. The only legal
 * transition out of ACCEPTED is `revoke()` (which moves status to
 * CANCELLED without changing the rights). If a different snapshot
 * is genuinely needed, the operator's contract is to issue a *new*
 * LicenseSale row and let the old one stand as historical record.
 *
 * All subtype-specific fields are declared as `Meta<T>` so the
 * scanner routes them into the shared `_meta_data` JSON column on
 * the `contracts` STI table — no migration of the base schema needed
 * to land this subtype.
 */
@TenantScoped({ mode: 'optional' })
@smrt()
export class LicenseSale extends Contract {
  override contractType = ContractType.LICENSE_SALE;

  /**
   * Plain string reference to the upstream `Sku` (from
   * `@happyvertical/smrt-products`) that this license was sold against.
   * Cross-package id; never `@foreignKey()`.
   */
  skuId: Meta<string> = '';

  /**
   * Plain string reference to the `Payment` that satisfied the
   * purchase. Cross-model reference matches the rest of the
   * package's convention.
   */
  paymentId: Meta<string> = '';

  /**
   * The licensee's email address — the primary identity carried
   * forward into PDF generation and any downstream hash-registry
   * publication. Required; without it, downstream rights cannot be
   * attributed.
   */
  licenseeEmail: Meta<string> = '';

  /**
   * Optional legal-entity name of the licensee for purchases that
   * warrant it (typically high-tier B2B licenses). Empty string for
   * individual-buyer licenses where the email *is* the legal identity.
   */
  licenseeLegalEntity: Meta<string> = '';

  /**
   * Optional ISO-3166 jurisdiction code of the licensee, captured for
   * tax / disclosure / governing-law purposes. Empty when not
   * required.
   */
  licenseeJurisdiction: Meta<string> = '';

  // -------- Rights snapshot (immutable once issued) --------

  /** Permitted media — `web,print,social`, `broadcast`, etc. */
  rightsMedium: Meta<string> = '';

  /** Distribution scope — `worldwide`, `territorial`, `private`, etc. */
  rightsDistributionScope: Meta<string> = '';

  /** Exclusivity — `exclusive` / `non-exclusive` / `co-exclusive`. */
  rightsExclusivity: Meta<string> = '';

  /** Duration — `perpetual` / `12-months` / `event-only`, etc. */
  rightsDuration: Meta<string> = '';

  /** Territory — ISO-3166 list, `worldwide`, region name, etc. */
  rightsTerritory: Meta<string> = '';

  /** Whether the licensee may sublicense the rights. */
  rightsSublicensing: Meta<boolean> = false;

  /** Whether the licensee may create derivative works. */
  rightsDerivatives: Meta<boolean> = false;

  // -------- Artefacts --------

  /** URL of the signed PDF (typically a cloud-storage public URL). */
  pdfUrl: Meta<string> = '';

  /**
   * SHA-256 of the signed PDF bytes (hex string, no `0x` prefix).
   * Lets downstream consumers verify the PDF the licensee holds is
   * the one this row was issued for, without re-fetching.
   */
  pdfHash: Meta<string> = '';

  /**
   * Optional reference to an on-chain hash-registry entry — set when
   * the LicenseSale's `pdfHash` has been anchored on a public chain
   * for tamper-evidence. Format is whatever the hash-registry
   * service emits (e.g. `chain:tx-hash:log-index`). Empty for
   * deployments that don't publish hashes on-chain.
   */
  onChainHashRegistryRef: Meta<string> = '';

  constructor(options: LicenseSaleOptions = {}) {
    super(options);
    if (options.skuId !== undefined) this.skuId = options.skuId;
    if (options.paymentId !== undefined) this.paymentId = options.paymentId;
    if (options.licenseeEmail !== undefined)
      this.licenseeEmail = options.licenseeEmail;
    if (options.licenseeLegalEntity !== undefined)
      this.licenseeLegalEntity = options.licenseeLegalEntity;
    if (options.licenseeJurisdiction !== undefined)
      this.licenseeJurisdiction = options.licenseeJurisdiction;
    if (options.rightsMedium !== undefined)
      this.rightsMedium = options.rightsMedium;
    if (options.rightsDistributionScope !== undefined)
      this.rightsDistributionScope = options.rightsDistributionScope;
    if (options.rightsExclusivity !== undefined)
      this.rightsExclusivity = options.rightsExclusivity;
    if (options.rightsDuration !== undefined)
      this.rightsDuration = options.rightsDuration;
    if (options.rightsTerritory !== undefined)
      this.rightsTerritory = options.rightsTerritory;
    if (options.rightsSublicensing !== undefined)
      this.rightsSublicensing = options.rightsSublicensing;
    if (options.rightsDerivatives !== undefined)
      this.rightsDerivatives = options.rightsDerivatives;
    if (options.pdfUrl !== undefined) this.pdfUrl = options.pdfUrl;
    if (options.pdfHash !== undefined) this.pdfHash = options.pdfHash;
    if (options.onChainHashRegistryRef !== undefined)
      this.onChainHashRegistryRef = options.onChainHashRegistryRef;
  }

  /**
   * Once `super.initialize()` has applied the framework's option-
   * override pass, capture the rights snapshot if (and only if) the
   * row arrived already issued. That's how the immutability guard
   * tells "freshly drafting a license" (snapshot still mutable) apart
   * from "loaded an already-issued row" (snapshot frozen).
   */
  override async initialize(): Promise<this> {
    await super.initialize();
    if (this.status === ContractStatus.ACCEPTED && (await this.isSaved())) {
      issuedRightsSnapshot.set(this, this.serializeRightsSnapshot());
    }
    return this;
  }

  /**
   * Return the current rights snapshot as a typed object. Read-only
   * for callers — mutation should go through assignment to the
   * individual `rights*` fields, gated by the issued-immutability
   * guard.
   */
  getRightsSnapshot(): LicenseRightsSnapshot {
    return {
      medium: this.rightsMedium,
      distributionScope: this.rightsDistributionScope,
      exclusivity: this.rightsExclusivity,
      duration: this.rightsDuration,
      territory: this.rightsTerritory,
      sublicensing: this.rightsSublicensing,
      derivatives: this.rightsDerivatives,
    };
  }

  /**
   * Revoke an issued license — moves status to `CANCELLED` without
   * touching the rights snapshot (which stays frozen). Throws if
   * called on a non-issued license; a draft license should be
   * deleted, not revoked.
   */
  revoke(): void {
    if (this.status !== ContractStatus.ACCEPTED) {
      throw new Error(
        `LicenseSale ${this.id ?? '<new>'}: cannot revoke from status '${this.status}' — only ACCEPTED licenses can be revoked`,
      );
    }
    this.status = ContractStatus.CANCELLED;
  }

  /**
   * Save with the immutability check: if the row was loaded with
   * `ACCEPTED` status, the rights snapshot at save time must match
   * the snapshot at load time. Anything else means an out-of-band
   * mutation crept in and we surface it instead of letting the row
   * drift silently.
   *
   * Newly-drafted licenses (where the row was constructed without
   * `ACCEPTED` status) capture their snapshot at the moment the
   * caller transitions to `ACCEPTED` and saves — `validateImmutable`
   * picks that up post-save on the next call.
   */
  override async save(): Promise<this> {
    this.validateImmutable();
    const result = (await super.save()) as this;
    // If this save transitioned the row to ACCEPTED, freeze the
    // snapshot for future saves.
    if (
      this.status === ContractStatus.ACCEPTED &&
      !issuedRightsSnapshot.has(this)
    ) {
      issuedRightsSnapshot.set(this, this.serializeRightsSnapshot());
    }
    return result;
  }

  /**
   * Compare the current rights against the captured snapshot
   * (populated either at load time by `initialize` or at first
   * issuance by `save`). Throws on mismatch.
   */
  private validateImmutable(): void {
    const captured = issuedRightsSnapshot.get(this);
    if (!captured) return;
    const current = this.serializeRightsSnapshot();
    if (captured !== current) {
      throw new Error(
        `LicenseSale ${this.id ?? '<new>'}: rights snapshot is immutable once issued (status=ACCEPTED). ` +
          'Use revoke() to cancel the existing license and issue a new one with the updated rights.',
      );
    }
  }

  private serializeRightsSnapshot(): string {
    // Stable key ordering so a re-serialization after a no-op
    // assignment doesn't trip the equality check.
    return JSON.stringify({
      medium: this.rightsMedium,
      distributionScope: this.rightsDistributionScope,
      exclusivity: this.rightsExclusivity,
      duration: this.rightsDuration,
      territory: this.rightsTerritory,
      sublicensing: this.rightsSublicensing,
      derivatives: this.rightsDerivatives,
    });
  }
}

export default Contract;
