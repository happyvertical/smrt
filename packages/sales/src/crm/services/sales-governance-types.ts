/** Public host contracts for governed sales. Monetary values are integer cents. */
import type { DatabaseInterface } from '@happyvertical/sql';

/** Owned connection options. Schema creation and arbitrary adapter injection are excluded. */
export type SalesGovernanceDatabaseConfig = {
  type: 'postgres';
  url: string;
  /** Owned adapters are never cached; true is rejected before opening SQL. */
  cache?: false;
  dbid?: string;
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
};

/** UUID identities accept either case; all service/host values use lowercase. */
export interface SellerContext {
  tenantId: string;
  actorProfileId: string;
}
export interface SellerOperation extends SellerContext {
  /** Globally unique UUID; exact retries must reuse it. */
  operationId: string;
}
export interface SellerPolicy {
  version: string;
  /** Exact integer basis points, 0..10000. */
  maxDiscountBps: number;
  leaseDurationMs: number;
  approvalDurationMs: number;
}
export interface SalesQuoteTerms {
  quoteId: string;
  revision: number;
  sellerId: string;
  /** Canonical advertiser UUID; quote actions require this seller's live lease. */
  advertiserId: string;
  rateCardVersion: string;
  subtotalCents: number;
  totalCents: number;
  currency: string;
  /** Opaque inventory revision validated authoritatively by the host. */
  inventoryVersion: string;
}
export interface SalesQuoteSnapshot extends SalesQuoteTerms {
  tenantId: string;
  makerProfileId: string;
  policy: SellerPolicy;
  status: 'draft' | 'issued' | 'signed';
  approval: SalesDiscountApproval | null;
}
export interface SalesDiscountApproval {
  requestId: string;
  status: 'pending' | 'approved' | 'rejected' | 'revoked';
  termsHash: string;
  checkerProfileId: string | null;
  expiresAtMs: number;
  reason: string;
}
export interface SalesAdvertiserLease {
  tenantId: string;
  advertiserId: string;
  sellerId: string;
  leaseId: string;
  expiresAtMs: number;
  released: boolean;
}
export interface SellerPolicyContext extends SellerContext {
  sellerId: string;
}
/**
 * Mandatory host predicates. Return literal true to authorize; false, missing
 * results, and thrown upstream errors all fail closed. Use the supplied executor
 * to lock authoritative membership, suspension, policy and inventory sources.
 * Network calls cannot establish transactionally stable authority.
 */
export interface SalesGovernanceHost {
  isMember(context: SellerContext, db: DatabaseInterface): Promise<boolean>;
  isUnsuspended(
    context: SellerContext,
    db: DatabaseInterface,
  ): Promise<boolean>;
  canSell(
    context: SellerPolicyContext,
    db: DatabaseInterface,
  ): Promise<boolean>;
  canApprove(context: SellerContext, db: DatabaseInterface): Promise<boolean>;
  advertiserExists(
    context: SellerContext & { advertiserId: string },
    db: DatabaseInterface,
  ): Promise<boolean>;
  policy(
    context: SellerPolicyContext,
    db: DatabaseInterface,
  ): Promise<SellerPolicy>;
  validateQuote(
    quote: SalesQuoteTerms & { tenantId: string },
    db: DatabaseInterface,
  ): Promise<boolean>;
}
export interface SalesLeaseInput extends SellerOperation {
  sellerId: string;
  advertiserId: string;
}
export interface SalesLeaseChangeInput extends SalesLeaseInput {
  /** Optimistic owner token: prevents delayed release/renew of a newer lease. */
  leaseId: string;
}
export interface SalesCreateQuoteInput extends SellerOperation {
  terms: SalesQuoteTerms;
}
export interface SalesQuoteOperation extends SellerOperation {
  quoteId: string;
  revision: number;
}
export interface SalesApprovalDecision extends SalesQuoteOperation {
  requestId: string;
  decision: 'approved' | 'rejected' | 'revoked';
  reason: string;
}
