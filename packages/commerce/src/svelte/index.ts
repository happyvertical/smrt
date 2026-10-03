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
import InvoiceActions from './components/InvoiceActions.svelte';
import InvoiceCard from './components/InvoiceCard.svelte';
import InvoiceHeader from './components/InvoiceHeader.svelte';
import InvoiceLineItems from './components/InvoiceLineItems.svelte';
import InvoiceTotals from './components/InvoiceTotals.svelte';
import UnbilledItems from './components/UnbilledItems.svelte';

// Export component Props types
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

import InvoiceEditor from './components/InvoiceEditor.svelte';
import InvoiceReview from './components/InvoiceReview.svelte';

export { InvoiceEditor, InvoiceReview };
export type InvoiceReviewProps = ComponentProps<typeof InvoiceReview>;
export type {
  InvoiceAllocationDraft,
  InvoiceEditorProps,
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
