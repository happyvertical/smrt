import type { DatabaseInterface } from '@happyvertical/smrt-core/migrations';
import type {
  CustomerFundsPolicy,
  CustomerFundsReleaseEvidence,
} from './customer-funds.js';
import type {
  HistoricalImportReview,
  HistoricalSourceIdentity,
} from './historical-sales-types.js';

/** Original policy terms are separate from today's account mapping for a new write. */
export type HistoricalCustomerFundsPolicy = Pick<
  CustomerFundsPolicy,
  'version' | 'mode' | 'taxTiming' | 'releaseEligibility'
>;
export interface HistoricalFundsSource extends HistoricalSourceIdentity {
  effectiveOn: string;
  depositedOn: string | null;
  method: string;
  reference: string | null;
  originalActorRef: string | null;
}
export interface HistoricalFundsSnapshot {
  version: 1;
  tenantId: string;
  customerId: string;
  contractId: string | null;
  currency: string;
  origin: 'historical' | 'live';
  paymentId: string | null;
  requestId: string;
  evidenceRef: string;
  review: HistoricalImportReview;
  recordedAt: string;
  source: HistoricalFundsSource;
  polarity: 'magnitudes' | 'signed';
  originalAmountMinor: number;
  kind: 'receipt' | 'refund';
  policy: HistoricalCustomerFundsPolicy;
  accounting: {
    state: 'externally-recorded' | 'source-only' | 'local-journal';
    ownerRef: string | null;
    originalJournalRef: string | null;
  };
  refundSource:
    | { kind: 'unallocated-funds'; receiptId: string }
    | { kind: 'issued-credit'; creditNoteId: string }
    | null;
}
export interface RecordHistoricalCustomerFundsInput {
  db: DatabaseInterface;
  tenantId: string;
  customerId: string;
  contractId?: string | null;
  requestId: string;
  evidenceRef: string;
  review: HistoricalImportReview;
  source: HistoricalFundsSource;
  kind: HistoricalFundsSnapshot['kind'];
  polarity: HistoricalFundsSnapshot['polarity'];
  originalAmountMinor: number;
  currency: string;
  policy: HistoricalCustomerFundsPolicy;
  accounting: HistoricalFundsSnapshot['accounting'];
  refundSource?: HistoricalFundsSnapshot['refundSource'];
}
export interface RecordHistoricalCustomerAllocationInput {
  db: DatabaseInterface;
  tenantId: string;
  invoiceId: string;
  requestId: string;
  evidenceRef: string;
  review: HistoricalImportReview;
  source: HistoricalSourceIdentity & { effectiveOn: string };
  amountMinor: number;
  receiptId?: string;
  creditNoteId?: string;
  sameDayCreditOrder?: 'credit-before-payment' | 'payment-before-credit' | null;
  release: CustomerFundsReleaseEvidence | null;
}
export interface RefundHistoricalCustomerFundsInput {
  db: DatabaseInterface;
  tenantId: string;
  receiptId: string;
  requestId: string;
  evidenceRef: string;
  actorId: string;
  effectiveOn: string;
  amountMinor: number;
  method: import('./types/index.js').PaymentMethod;
  currentPolicy: CustomerFundsPolicy;
}
export interface ApplyHistoricalCustomerFundsInput {
  db: DatabaseInterface;
  tenantId: string;
  receiptId: string;
  invoiceId: string;
  requestId: string;
  evidenceRef: string;
  actorId: string;
  effectiveOn: string;
  amountMinor: number;
  release: CustomerFundsReleaseEvidence;
  currentPolicy: CustomerFundsPolicy;
}
export interface HistoricalCustomerFundsPosition {
  receiptId: string;
  tenantId: string;
  customerId: string;
  contractId: string | null;
  currency: string;
  receivedMinor: number;
  allocatedMinor: number;
  refundedMinor: number;
  availableMinor: number;
  receipt: HistoricalFundsSnapshot;
}
