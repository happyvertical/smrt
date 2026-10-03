import type { QuoteMoneyMinor } from './quote-types.js';

/** Caller-owned purchasing source identity and display evidence. */
export interface PurchaseSourceOption {
  /** Stable source selection value, interpreted by the server. */
  id: string;
  /** Human source label. */
  label: string;
  /** Vendor display name; no identity migration is implied. */
  vendor: string;
  /** Caller-selected source availability; never an authorization grant. */
  disabled?: boolean;
  /** Reason unavailable, expiry/supersession or other evidence. */
  notice?: string;
}

/** Fixed retained allocation or a caller-added draft row. */
export interface PurchaseAllocationDraft {
  /** Stable allocation identity posted even for explicit zero. */
  id: string;
  /** Caller-provided allocation label; no construction-specific semantics. */
  label: string;
  /** Raw major-unit input string, including invalid rejected input. */
  amount: string;
  /** Whether this row exists in the predecessor; reductions must retain it. */
  retained?: boolean;
  /** Caller-selected requirement for non-reduction editing. */
  required?: boolean;
  /** Optional retained/source amount; null means unknown, not zero. */
  sourceMinor?: number | null;
  /** Optional caller-calculated lower bound, displayed in currency units. */
  minimumMinor?: number;
  /** Optional caller-calculated upper bound, displayed in currency units. */
  maximumMinor?: number;
}

/** Input values remain strings until the application validates them. */
export interface PurchaseDraftValues {
  /** Caller-defined instrument (e.g. purchase-order or subcontract). */
  instrument: string;
  /** Tax included in allocation amounts, as raw major-unit text. */
  tax: string;
  /** Explicit awarded or ordered scope. */
  scope: string;
  /** Included goods or services. */
  inclusions: string;
  /** Excluded goods or services. */
  exclusions: string;
  /** Human decision evidence or amendment reason. */
  reason: string;
  /** Every retained allocation, even when its submitted amount is empty or zero. */
  allocations: PurchaseAllocationDraft[];
}

/** A server-produced review snapshot; rendering it never approves the command. */
export interface PurchaseReviewSnapshot {
  /** Caller-owned fingerprint that the server validates against submitted values. */
  fingerprint: string;
  /** Human vendor/source label retained by the reviewed command. */
  sourceLabel: string;
  /** Exact reviewed total. */
  total: QuoteMoneyMinor;
  /** Included tax in the same currency and scale as total. */
  taxMinor: number;
  /** Retained awarded scope. */
  scope: string;
  /** Caller-owned status, exceptions or historical-source notices. */
  notices?: string[];
}

/** Native POST field-name adaptation without changing an existing route contract. */
export interface PurchaseFieldNames {
  /** Instrument field name. */
  instrument: string;
  /** Included tax field name. */
  tax: string;
  /** Scope field name. */
  scope: string;
  /** Inclusions field name. */
  inclusions: string;
  /** Exclusions field name. */
  exclusions: string;
  /** Decision/amendment reason field name. */
  reason: string;
  /** Repeated allocation ID and major-unit amount fields. */
  allocationId: string;
  /** Repeated major-unit input field. */
  allocationAmount: string;
  /** Caller review fingerprint name. */
  fingerprint: string;
  /** Explicit confirmation checkbox name. */
  confirmation: string;
}

/** Conventional defaults; existing consumers can adapt every payload field. */
export const purchaseFieldNames: PurchaseFieldNames = {
  instrument: 'instrument',
  tax: 'tax',
  scope: 'scope',
  inclusions: 'inclusions',
  exclusions: 'exclusions',
  reason: 'reason',
  allocationId: 'allocationId',
  allocationAmount: 'allocationAmount',
  fingerprint: 'reviewFingerprint',
  confirmation: 'confirm',
};
