import type { AttachmentPanelProps } from '@happyvertical/smrt-assets/svelte';
import type { FormRetryStatus } from '@happyvertical/smrt-ui/form-retry';
import type { Snippet } from 'svelte';
import type { HTMLFormAttributes } from 'svelte/elements';
import type { Expense } from '../models/Expense.js';

/** Lossless native form strings, separate from Expense's integer model amount. */
export interface ExpenseDraftValues {
  /** Ordinary currency-unit text, e.g. '125.00' CAD; parsed server-side. */
  amount: string;
  /** Currency as submitted, even if invalid; server validates. */
  currency: string;
  /** Calendar-date text, normally YYYY-MM-DD; invalid strings remain visible. */
  incurredOn: string;
  /** Caller-entered cost description. */
  description: string;
  /** Caller-entered category; server validates its vocabulary. */
  category: string;
  /** Commerce Vendor reference, not an identity merge. */
  vendorId: string;
  /** Commerce Contract commitment reference. */
  commitmentId: string;
  /** Payer text, normally company or person; unknown submitted values retained. */
  paidBy: string;
  /** Profile reference for a person payer. */
  paidByProfileId: string;
  /** Caller-owned correction reason; not a new Expense persistence property. */
  correctionReason: string;
}

/** Authorized Commerce choice projection. Labels remain caller-owned. */
export interface ExpenseReferenceOption {
  /** Opaque Vendor/Contract reference. */
  id: string;
  /** Caller-localized label. */
  label: string;
}

/** Request identity/context forwarded as native hidden fields. */
export interface ExpenseRequestField {
  /** Native field name; repetitions are preserved. */
  name: string;
  /** Exact caller value; never generated or rotated here. */
  value: string;
}

/** Native purchase/expense entry. Caller endpoints enforce financial policy. */
export interface ExpenseFormProps {
  /** Authorized native POST destination. */
  action: string;
  /** Retained draft strings from load or the failed action response. */
  values: ExpenseDraftValues;
  /** Optional stable form identity for enhancement. */
  id?: string;
  /** Caller-localized heading, including Purchase terminology. */
  title?: string;
  /** Capability controls presentation; server must authorize every mutation. */
  canEdit?: boolean;
  /** Whether caller correction workflow requires the reason field. */
  correcting?: boolean;
  /** Authorized Commerce Vendor options. */
  vendors?: readonly ExpenseReferenceOption[];
  /** Authorized Commerce Contract options. */
  commitments?: readonly ExpenseReferenceOption[];
  /** Optional native field-name adapter; defaults to draft property names. */
  fields?: Partial<Record<keyof ExpenseDraftValues, string>>;
  /** Server errors keyed by logical draft property. */
  errors?: Partial<Record<keyof ExpenseDraftValues, string>>;
  /** Caller error/denial/uncertain-outcome message. */
  message?: string;
  /** Caller-owned request identity, cost object, predecessor and context. */
  hiddenFields?: readonly ExpenseRequestField[];
  /** Native submitter name, default intent. */
  intentField?: string;
  /** Native submitter value, default save. */
  intent?: string;
  /** Caller-localized submit label. */
  submitLabel?: string;
  /** Request in flight. Values stay editable, another submit is disabled. */
  pending?: boolean;
  /** Optional status from caller-owned smrt-ui/form-retry. */
  retryStatus?: FormRetryStatus;
  /** Domain-specific fields (allocation, quantity, reimbursement, etc.). */
  children?: Snippet;
  /** Optional enhancement; native POST remains the default. */
  onsubmit?: HTMLFormAttributes['onsubmit'];
}

/** Display projection of the public Expense; amount remains integer minor units. */
export interface ExpenseReviewSummary
  extends Pick<Expense, 'description' | 'amount' | 'currency' | 'incurredOn'> {
  /** Caller-localized review status, including unknown future states. */
  statusLabel: string;
  /** Caller policy/review explanation. */
  note?: string;
}

/** Possible duplicate supplied by an authorized server query. */
export interface ExpenseDuplicateCandidate {
  /** Opaque expense reference; no linking or merging happens automatically. */
  id: string;
  /** Caller-localized duplicate description. */
  label: string;
  /** Caller-localized reason, such as a matching receipt. */
  reason?: string;
}

/** An authorized correction or review history entry supplied in display order. */
export interface ExpenseHistoryEntry {
  /** Unique history identity. */
  id: string;
  /** Caller-localized decision/correction label. */
  label: string;
  /** Caller-localized time/actor metadata. */
  detail?: string;
}

/** Caller-defined review action; visibility never replaces server authorization. */
export interface ExpenseReviewAction {
  /** Native clicked submitter value. */
  intent: string;
  /** Caller-localized action label. */
  label: string;
  /** Presentation disable flag for this action. */
  disabled?: boolean;
}

/** Reviewed-state and duplicate/correction presentation with Assets composition. */
export interface ExpenseReviewPanelProps {
  /** Authorized model projection; UI does not infer status or mutate it. */
  expense: ExpenseReviewSummary;
  /** Supplied duplicate candidates; no deduplication policy runs here. */
  duplicates?: readonly ExpenseDuplicateCandidate[];
  /** Supplied correction/review history. */
  history?: readonly ExpenseHistoryEntry[];
  /** Assets public attachment presentation/upload contract. */
  receipts?: AttachmentPanelProps;
  /** Explicitly enable caller-supplied review actions. */
  canReview?: boolean;
  /** Authorized review endpoint, required to render action form. */
  action?: string;
  /** Caller-defined review actions; no status-derived actions. */
  actions?: readonly ExpenseReviewAction[];
  /** Native submitter name, default intent. */
  intentField?: string;
  /** Caller request/tenant/fingerprint context. */
  hiddenFields?: readonly ExpenseRequestField[];
  /** Caller error or denied/uncertain outcome. */
  message?: string;
  /** Caller request pending state. */
  pending?: boolean;
  /** Retained review reason/duplicate selector and other caller-specific fields. */
  children?: Snippet;
  /** Optional review-form enhancement. */
  onsubmit?: HTMLFormAttributes['onsubmit'];
}
