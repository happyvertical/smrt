/**
 * Commerce Svelte Components
 *
 * This module auto-registers all commerce UI components with the ModuleUIRegistry
 * when imported. Import this module to enable registry-based component discovery.
 *
 * @example Direct imports
 * ```typescript
 * import { InvoiceCard, InvoiceHeader } from '@happyvertical/smrt-commerce/svelte';
 * ```
 *
 * @example Registry-based discovery
 * ```typescript
 * import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
 * import '@happyvertical/smrt-commerce/svelte'; // Auto-registers components
 *
 * const Component = ModuleUIRegistry.get('@happyvertical/smrt-commerce', 'invoice-card');
 * ```
 */

import { ModuleUIRegistry } from '@happyvertical/smrt-ui/registry';
import type { ComponentProps } from 'svelte';
import { COMMERCE_MODULE_META } from '../ui.js';

// Import components
import CustomerDetail from './components/CustomerDetail.svelte';
import CustomerDirectory from './components/CustomerDirectory.svelte';
import CustomerForm from './components/CustomerForm.svelte';
import CustomerSelect from './components/CustomerSelect.svelte';
import InvoiceActions from './components/InvoiceActions.svelte';
import InvoiceCard from './components/InvoiceCard.svelte';
import InvoiceHeader from './components/InvoiceHeader.svelte';
import InvoiceLineItems from './components/InvoiceLineItems.svelte';
import InvoiceTotals from './components/InvoiceTotals.svelte';
import PartyContactFields from './components/PartyContactFields.svelte';
import UnbilledItems from './components/UnbilledItems.svelte';
import VendorDetail from './components/VendorDetail.svelte';
import VendorDirectory from './components/VendorDirectory.svelte';
import VendorForm from './components/VendorForm.svelte';
import VendorSelect from './components/VendorSelect.svelte';

// Export component Props types
export type CustomerDetailProps = ComponentProps<typeof CustomerDetail>;
export { default as CustomerDetail } from './components/CustomerDetail.svelte';
export type CustomerDirectoryProps = ComponentProps<typeof CustomerDirectory>;
export { default as CustomerDirectory } from './components/CustomerDirectory.svelte';
export type CustomerFormProps = ComponentProps<typeof CustomerForm>;
export { default as CustomerForm } from './components/CustomerForm.svelte';
export type CustomerSelectProps = ComponentProps<typeof CustomerSelect>;
export { default as CustomerSelect } from './components/CustomerSelect.svelte';
export type VendorSelectProps = ComponentProps<typeof VendorSelect>;
export { default as VendorSelect } from './components/VendorSelect.svelte';
export type InvoiceActionsProps = ComponentProps<typeof InvoiceActions>;
// Export components
export { default as InvoiceActions } from './components/InvoiceActions.svelte';
export type InvoiceCardProps = ComponentProps<typeof InvoiceCard>;
export { default as InvoiceCard } from './components/InvoiceCard.svelte';
export type InvoiceHeaderProps = ComponentProps<typeof InvoiceHeader>;
export { default as InvoiceHeader } from './components/InvoiceHeader.svelte';
export type InvoiceLineItemsProps = ComponentProps<typeof InvoiceLineItems>;
export { default as InvoiceLineItems } from './components/InvoiceLineItems.svelte';
export type InvoiceTotalsProps = ComponentProps<typeof InvoiceTotals>;
export { default as InvoiceTotals } from './components/InvoiceTotals.svelte';
export type UnbilledItemsProps = ComponentProps<typeof UnbilledItems>;
export { default as UnbilledItems } from './components/UnbilledItems.svelte';
export type PartyContactFieldsProps = ComponentProps<typeof PartyContactFields>;
export { default as PartyContactFields } from './components/PartyContactFields.svelte';
export type VendorDetailProps = ComponentProps<typeof VendorDetail>;
export { default as VendorDetail } from './components/VendorDetail.svelte';
export type VendorDirectoryProps = ComponentProps<typeof VendorDirectory>;
export { default as VendorDirectory } from './components/VendorDirectory.svelte';
export type VendorFormProps = ComponentProps<typeof VendorForm>;
export { default as VendorForm } from './components/VendorForm.svelte';
export type {
  InvoiceMinorAmount,
  RetainedInvoiceCardView,
  RetainedInvoiceHeaderView,
  RetainedInvoiceLineItemsView,
  RetainedInvoiceLineView,
  RetainedInvoiceTaxView,
  RetainedInvoiceTotalsView,
} from './invoice-display.js';
export { formatInvoiceMinorUnits } from './invoice-display.js';
export type {
  CustomerDisplayData,
  CustomerFieldNames,
  CustomerFormValues,
  PartyAddressData,
  PartyContactData,
  PartyContactLabels,
  PartyDirectoryExtension,
  PartyDirectoryFilters,
  PartyDirectoryItem,
  PartyExtension,
  PartyFieldNames,
  PartyFormErrors,
  PartyFormTransport,
  PartyIdentityKind,
  PartyProfileData,
  PartySurfaceLabels,
  VendorDisplayData,
  VendorFieldNames,
  VendorFormValues,
} from './party-types.js';
export {
  DEFAULT_CUSTOMER_FIELD_NAMES,
  DEFAULT_PARTY_FIELD_NAMES,
  DEFAULT_VENDOR_FIELD_NAMES,
  formatPartyAddress,
  formatPartyMinorUnits,
} from './party-types.js';
// Export types
export type {
  InvoiceData,
  InvoiceStatus,
  LineItem,
  UnbilledItem,
} from './types.js';

// Auto-register module and components with ModuleUIRegistry
ModuleUIRegistry.registerModule(COMMERCE_MODULE_META);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'customer-directory',
  CustomerDirectory,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'customer-detail',
  CustomerDetail,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'customer-form',
  CustomerForm,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'vendor-directory',
  VendorDirectory,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'vendor-detail',
  VendorDetail,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'vendor-form',
  VendorForm,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'party-contact-fields',
  PartyContactFields,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'invoice-card',
  InvoiceCard,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'invoice-header',
  InvoiceHeader,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'invoice-line-items',
  InvoiceLineItems,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'invoice-totals',
  InvoiceTotals,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'invoice-actions',
  InvoiceActions,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'unbilled-items',
  UnbilledItems,
);

// Quotation and estimate presentation; no backend mutation or domain migration.
import QuoteEditor from './components/QuoteEditor.svelte';
import QuoteRevisionComparison from './components/QuoteRevisionComparison.svelte';
import QuoteRevisionHistory from './components/QuoteRevisionHistory.svelte';

export { QuoteEditor, QuoteRevisionComparison, QuoteRevisionHistory };
export type QuoteEditorProps = ComponentProps<typeof QuoteEditor>;
export type QuoteRevisionHistoryProps = ComponentProps<
  typeof QuoteRevisionHistory
>;
export type QuoteRevisionComparisonProps = ComponentProps<
  typeof QuoteRevisionComparison
>;
export type {
  QuoteDocumentKind,
  QuoteDraftLine,
  QuoteDraftValues,
  QuoteFieldNames,
  QuoteMoneyMinor,
  QuoteRevision,
} from './quote-types.js';
export {
  quoteFieldNames,
  quoteMinorText,
  quoteRevisionDelta,
} from './quote-types.js';

ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'quote-editor',
  QuoteEditor,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'quote-revision-history',
  QuoteRevisionHistory,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'quote-revision-comparison',
  QuoteRevisionComparison,
);

export type {
  PricingDecisionAction,
  PricingHiddenField,
  PricingVersionData,
  PricingVersionSource,
} from './pricing-types.js';

import PricingVersionDecision from './components/PricingVersionDecision.svelte';
import PricingVersionSummary from './components/PricingVersionSummary.svelte';

export { PricingVersionDecision, PricingVersionSummary };
export type PricingVersionSummaryProps = ComponentProps<
  typeof PricingVersionSummary
>;
export type PricingVersionDecisionProps = ComponentProps<
  typeof PricingVersionDecision
>;
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'pricing-version-summary',
  PricingVersionSummary,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'pricing-version-decision',
  PricingVersionDecision,
);

import InvoiceAllocationFields from './components/InvoiceAllocationFields.svelte';
import InvoiceEditor from './components/InvoiceEditor.svelte';
import InvoiceLineEditor from './components/InvoiceLineEditor.svelte';
import InvoiceReview from './components/InvoiceReview.svelte';

export {
  InvoiceAllocationFields,
  InvoiceEditor,
  InvoiceLineEditor,
  InvoiceReview,
};
export type InvoiceReviewProps = ComponentProps<typeof InvoiceReview>;
export type {
  InvoiceAllocationDraft,
  InvoiceAllocationFieldsProps,
  InvoiceDraftValues,
  InvoiceEditorProps,
  InvoiceFieldNames,
  InvoiceLineDraft,
  InvoiceLineEditorProps,
  InvoiceLineFieldNames,
  InvoicePreparationFields,
  InvoicePreparationHiddenField,
  InvoicePreparationReview,
  InvoicePreparationSource,
} from './invoices/types.js';

ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'invoice-editor',
  InvoiceEditor,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'invoice-review',
  InvoiceReview,
);

import PurchaseOrderEditor from './components/PurchaseOrderEditor.svelte';
import PurchaseSourceSelector from './components/PurchaseSourceSelector.svelte';

export { PurchaseOrderEditor, PurchaseSourceSelector };
export type PurchaseOrderEditorProps = ComponentProps<
  typeof PurchaseOrderEditor
>;
export type PurchaseSourceSelectorProps = ComponentProps<
  typeof PurchaseSourceSelector
>;
export type {
  PurchaseAllocationDraft,
  PurchaseDraftValues,
  PurchaseFieldNames,
  PurchaseReviewSnapshot,
  PurchaseSourceOption,
} from './purchasing-types.js';
export { purchaseFieldNames } from './purchasing-types.js';

ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'purchase-order-editor',
  PurchaseOrderEditor,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'purchase-source-selector',
  PurchaseSourceSelector,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'customer-select',
  CustomerSelect,
);
ModuleUIRegistry.register(
  '@happyvertical/smrt-commerce',
  'vendor-select',
  VendorSelect,
);
