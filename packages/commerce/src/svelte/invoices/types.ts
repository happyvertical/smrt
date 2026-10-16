import type { HTMLFormAttributes } from 'svelte/elements';
import type { MoneyEditorProps } from './money-editor.js';

export type {
  MoneyEditorDraft,
  MoneyEditorFieldNames,
  MoneyEditorLineDraft,
  MoneyEditorProps,
  MoneyEditorTaxCode,
  MoneyStoredDocument,
  MoneyStoredTax,
} from './money-editor.js';

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

/** Optional allocation fields, rendered without an enclosing form. */
export interface InvoiceAllocationFieldsProps {
  /** Currency for allocation presentation. */
  currency: string;
  /** Retained source-allocation rows. */
  allocations: readonly InvoiceAllocationDraft[];
  /** Authorized source projections only. */
  sources?: readonly InvoicePreparationSource[];
  /** Hide sensitive source labels and balances when false. */
  mayReadSources?: boolean;
  /** Presentation capability; server authorizes every action. */
  canEdit?: boolean;
  /** Disable the structural add action while pending. */
  pending?: boolean;
  /** Native allocation field adapters. */
  fields?: Partial<InvoicePreparationFields>;
  /** Native add-allocation intent, default addAllocation. */
  addIntent?: string;
  /** Stable label identity. */
  id?: string;
}

/** The invoice editor: the v2 money surface is its only model. */
export interface InvoiceEditorProps {
  /** Native form action owned by the caller's invoice route. */
  action: string;
  /** Native HTTP method retained for progressive enhancement. */
  method?: 'post' | 'get';
  /** Typed v2 money draft, tax-code choices, and stored issued snapshot. */
  money: MoneyEditorProps;
  /** Presentation capability; the server remains the authority for writes. */
  canEdit?: boolean;
  /** Caller transport state that disables edits and the save submitter. */
  pending?: boolean;
  /** Caller-owned request identity and route fields submitted unchanged. */
  hiddenFields?: readonly InvoicePreparationHiddenField[];
  /** Native submitter field name expected by the caller, default intent. */
  intentField?: string;
  /** Submitter value that requests a draft save, default save. */
  saveIntent?: string;
  /** Caller-visible label for the save submitter. */
  saveLabel?: string;
  /** Optional native form enhancement; omitted submissions stay native. */
  onsubmit?: HTMLFormAttributes['onsubmit'];
}
