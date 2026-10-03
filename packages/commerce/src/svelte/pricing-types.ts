import type { QuoteRevision } from './quote-types.js';

/** A retained pricing source; application policy owns selection and eligibility. */
export interface PricingVersionSource {
  /** Stable retained source identity. */
  id: string;
  /** Human-readable source label supplied by the consumer. */
  label: string;
  /** Included amount in the version currency's integer minor units; null is unknown. */
  amountMinor: number | null;
  /** Retained explanation, scope or exclusion text. */
  description?: string;
}

/** Pricing version snapshot reuses the quote/estimate revision contract. */
export interface PricingVersionData extends QuoteRevision {
  /** Retained pricing sources, already authorized for this viewer. */
  sources?: readonly PricingVersionSource[];
}

/** Native submitter contract; the UI does not infer available decisions. */
export interface PricingDecisionAction {
  /** Visible localized action label supplied by the application. */
  label: string;
  /** Exact native submitter field name. */
  name: string;
  /** Exact native submitter intent value. */
  value: string;
  /** Whether this action is unavailable in the current server-owned state. */
  disabled?: boolean;
  /** Optional native action URL overriding the enclosing form action. */
  formAction?: string;
}

/** Caller-owned hidden entry; arrays preserve repeated names and order. */
export interface PricingHiddenField {
  /** Exact native field name, including request/tenant/version identity if needed. */
  name: string;
  /** Exact retained value; never generated or rotated by the component. */
  value: string;
}
