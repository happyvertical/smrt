import type { FormRetryStatus } from '@happyvertical/smrt-ui/form-retry';
import type { Snippet } from 'svelte';
import type { HTMLFormAttributes } from 'svelte/elements';

/** Authorized source projection supplied by the application, not fetched by UI. */
export interface InvoicePreparationSource {
  /** Opaque source reference submitted verbatim. */
  id: string;
  /** Caller-localized source description. */
  label: string;
  /** Available integer minor units, including this draft's reservation if editing. */
  availableMinor: number;
  /** Whether the caller permits selecting this source now. */
  selectable?: boolean;
}

/** Lossless native-form values; even invalid submitted strings remain visible. */
export interface InvoiceAllocationDraft {
  /** Stable row identity, unique within one editor. Never minted as a request key. */
  key: string;
  /** Source reference, including references no longer in the source list. */
  sourceId: string;
  /** Currency-unit text as entered (e.g. CAD 125.00). Server parses currency precision. */
  amount: string;
  /** Retained native removal selection after a rejected action. */
  remove?: boolean;
  /** Caller validation feedback for the source field. */
  sourceError?: string;
  /** Caller validation feedback for the amount field. */
  amountError?: string;
}

/** Server-authoritative presentation snapshot; no status is inferred from edits. */
export interface InvoicePreparationReview {
  /** Caller-localized state, including unknown/future states. */
  label: string;
  /** Caller explanation of approval, invalidation, expiry or review requirements. */
  message?: string;
}

/** Native name mapping for adapters. Row names repeat in displayed order. */
export interface InvoicePreparationFields {
  /** Source identifier field, default sourceId. */
  source: string;
  /** Currency-unit text field, default allocationAmount. */
  amount: string;
  /** Checked zero-based row positions, default removeRow. */
  remove: string;
  /** Clicked submitter name, default intent. */
  intent: string;
}

/** Explicit caller request values; arrays preserve repeated native fields. */
export interface InvoicePreparationHiddenField {
  /** Native request field name. */
  name: string;
  /** Value forwarded without normalization or rotation. */
  value: string;
}

/** Invoice preparation and retained-draft editor contract. */
export interface InvoiceEditorProps {
  /** Caller endpoint; no application routes are embedded. */
  action: string;
  /** Native form method (POST by default). */
  method?: 'post' | 'get';
  /** Optional stable form id for enhancement and labels. */
  id?: string;
  /** Caller-localized heading. */
  title?: string;
  /** Currency code; draft amounts are lossless currency-unit text. */
  currency: string;
  /** Caller-owned rows, rerendered from action results after failure/add/remove. */
  allocations: readonly InvoiceAllocationDraft[];
  /** Only authorized source projections should be supplied. */
  sources?: readonly InvoicePreparationSource[];
  /** False renders reference inputs without exposing source labels or balances. */
  mayReadSources?: boolean;
  /** Presentation capability only; server must independently authorize writes. */
  canEdit?: boolean;
  /** Action in flight; prevents another submit without clearing entered values. */
  pending?: boolean;
  /** Optional state from the caller's smrt-ui/form-retry controller. */
  retryStatus?: FormRetryStatus;
  /** Caller-localized form-level error/uncertain-outcome message. */
  message?: string;
  /** Server review snapshot; never changed automatically by this component. */
  review?: InvoicePreparationReview;
  /** Caller-owned tokens, currency, revision/fingerprint and other request fields. */
  hiddenFields?: readonly InvoicePreparationHiddenField[];
  /** Adapt native names without rewriting component markup. */
  fields?: Partial<InvoicePreparationFields>;
  /** Native submitter value for saving, default save. */
  saveIntent?: string;
  /** Native submitter value for adding a row, default addAllocation. */
  addIntent?: string;
  /** Caller-localized save label. */
  saveLabel?: string;
  /** Optional cancel URL. */
  cancelHref?: string;
  /** Extra domain fields inside the form. */
  children?: Snippet;
  /** Optional native enhancement; call preventDefault only when handling transport. */
  onsubmit?: HTMLFormAttributes['onsubmit'];
}
