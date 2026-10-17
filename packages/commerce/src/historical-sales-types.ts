import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import type { TaxCodeKind } from './money.js';

/** Original source identity is independent of the human importing it. */
export interface HistoricalSourceIdentity {
  namespace: string;
  key: string;
  version: string;
}
export interface HistoricalImportReview {
  actorId: string;
  policyRef: string;
}
export interface HistoricalSalesTaxComponent {
  sourceKey: string;
  label: string;
  amountMinor: number;
  classification: TaxCodeKind | null;
  taxCodeId: string | null;
  taxComponentId: string | null;
  taxableMinor: number | null;
  netMinor: number | null;
  liabilityAccountId: string | null;
}
/** A real source child. Unknown tax/quantity/rate remains null, never calculated. */
export interface HistoricalSalesLineInput {
  creditedLineId: string | null;
  sourceKey: string;
  description: string;
  netMinor: number;
  taxMinor: number | null;
  grossMinor: number | null;
  quantityText: string | null;
  unitRateText: string | null;
  sourceFields: Record<string, string>;
}
/** Source values retain their original explicit polarity. Canonical headers use magnitudes. */
export interface HistoricalSalesMoneyFacts {
  currency: string;
  kind: 'invoice' | 'credit_note';
  polarity: 'magnitudes' | 'signed';
  netMinor: number;
  taxMinor: number;
  grossMinor: number;
  taxComponents: HistoricalSalesTaxComponent[] | null;
  detail:
    | { kind: 'header-only' }
    | { kind: 'lines'; lines: HistoricalSalesLineInput[] };
}
export interface HistoricalSalesRetention {
  retainedMinor: number;
  creditPolicy: 'retained-first';
  policyRef: string;
  effectiveOn: string;
  evidenceRef: string;
  originalActorRef: string | null;
  releases: {
    sourceKey: string;
    amountMinor: number;
    effectiveOn: string;
    sameDayCreditOrder?:
      | 'credit-before-release'
      | 'release-before-credit'
      | null;
    evidenceRef: string;
    originalActorRef: string | null;
  }[];
}
export interface HistoricalSalesSource extends HistoricalSourceIdentity {
  /** Omitted/null means no original retention; dated releases never use import time. */
  retention?: HistoricalSalesRetention | null;
  issuedOn: string;
  dueOn: string | null;
  timeZone: string;
  approval: { actorRef: string; approvedOn: string | null } | null;
}
export interface HistoricalSalesMoneySnapshot {
  version: 1;
  requestId: string;
  evidenceRef: string;
  review: HistoricalImportReview;
  recordedAt: string;
  source: HistoricalSalesSource;
  facts: HistoricalSalesMoneyFacts;
  creditedSource: { invoiceId: string; moneySnapshotId: string } | null;
}
export interface RecordHistoricalSalesMoneyInput {
  db: DatabaseInterface;
  tenantId: string;
  invoiceId: string;
  requestId: string;
  evidenceRef: string;
  review: HistoricalImportReview;
  source: HistoricalSalesSource;
  facts: HistoricalSalesMoneyFacts;
  creditedSource?: { invoiceId: string; moneySnapshotId: string };
}
