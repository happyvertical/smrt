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

/** Invoice draft types shared with the Svelte-free exact calculator. */
export type { InvoiceDraftValues, InvoiceLineDraft } from './calculations.js';

import type { InvoiceDraftValues, InvoiceLineDraft } from './calculations.js';

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

/** Editable line field names repeat in displayed order. */
export interface InvoiceLineFieldNames {
  /** Stable line identity. */
  key: string;
  /** Description text. */
  description: string;
  /** Product/SKU reference text. */
  sku: string;
  /** Fractional quantity text. */
  quantity: string;
  /** Currency-unit price text. */
  unitPrice: string;
  /** Flat or percentage discount selection. */
  discountType: string;
  /** Currency-unit or percent discount text. */
  discountValue: string;
  /** Inherited or explicit tax selection. */
  taxMode: string;
  /** Explicit percentage tax text, including zero. */
  taxRate: string;
}

/** Invoice header and submitter name adapters. */
export interface InvoiceFieldNames {
  /** Customer reference. */
  customerId: string;
  /** Invoice date text. */
  issuedOn: string;
  /** Due date text. */
  dueOn: string;
  /** Currency code. */
  currency: string;
  /** Payment terms text. */
  paymentTerms: string;
  /** Default tax percentage text. */
  taxRate: string;
  /** Clicked submitter name. */
  intent: string;
}

/** General invoice line fields; never renders a nested form. */
export interface InvoiceLineEditorProps {
  /** Lossless caller-owned line values. */
  line: InvoiceLineDraft;
  /** Current currency code for shared calculation. */
  currency: string;
  /** External default tax percentage; explicit line override remains distinct. */
  inheritedTaxRate: string;
  /** One-based display position. */
  number?: number;
  /** Stable control-label prefix. */
  id?: string;
  /** Native field-name adapters. */
  fields?: Partial<InvoiceLineFieldNames>;
  /** Caller errors keyed by canonical line field name. */
  errors?: Partial<Record<keyof InvoiceLineFieldNames, string>>;
  /** Presentation capability. */
  canEdit?: boolean;
  /** Disable structural actions while pending. */
  pending?: boolean;
  /** Native submitter name. */
  intentField?: string;
  /** Remove intent prefix, followed by caller line key. */
  removePrefix?: string;
}

/** General native invoice editor with optional domain extensions. */
export interface InvoiceEditorProps {
  /** Caller native endpoint. */
  action: string;
  /** Native method, default POST. */
  method?: 'post' | 'get';
  /** Stable form identity. */
  id?: string;
  /** Caller-localized title. */
  title?: string;
  /** Retained editable strings; never reconstructed from model numbers. */
  values: InvoiceDraftValues;
  /** Authorized customer projections; retained unknown references stay visible. */
  customers?: readonly { id: string; label: string }[];
  /** Caller field errors: header name or lineKey.fieldName. */
  errors?: Record<string, string>;
  /** Header and submitter field adapters. */
  fields?: Partial<InvoiceFieldNames>;
  /** Repeated line field adapters. */
  lineFields?: Partial<InvoiceLineFieldNames>;
  /** Presentation capability only; server reauthorizes all mutations. */
  canEdit?: boolean;
  /** Disable submission while a request is pending. */
  pending?: boolean;
  /** Caller-owned retry-controller status. */
  retryStatus?: FormRetryStatus;
  /** Caller error or uncertain-outcome message. */
  message?: string;
  /** Server-authoritative review snapshot. */
  review?: InvoicePreparationReview;
  /** Exact caller tokens/context; repeated names preserved. */
  hiddenFields?: readonly InvoicePreparationHiddenField[];
  /** Save intent, default save. */
  saveIntent?: string;
  /** Add-line intent, default addLine. */
  addIntent?: string;
  /** Remove-line intent prefix, default removeLine:. */
  removePrefix?: string;
  /** Caller-localized save label. */
  saveLabel?: string;
  /** Optional cancel navigation URL. */
  cancelHref?: string;
  /** Domain fields inside the single form; receives current draft for currency-aware extensions. */
  children?: Snippet<[InvoiceDraftValues]>;
  /** Optional enhancement; native submission remains the default. */
  onsubmit?: HTMLFormAttributes['onsubmit'];
}
