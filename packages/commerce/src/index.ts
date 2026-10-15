/**
 * @happyvertical/smrt-commerce
 *
 * Commerce models for the SMRT framework - contracts, fulfillments, payments.
 *
 * Key concepts:
 * - Customer/Vendor link to Profile (from smrt-profiles)
 * - Contract uses STI for different types (Estimate, Order, Lease, etc.)
 * - Payment integrates with smrt-ledgers for journal entries
 *
 * @example
 * ```typescript
 * import {
 *   Customer,
 *   CustomerCollection,
 *   Order,
 *   ContractCollection,
 *   Payment,
 *   PaymentCollection,
 * } from '@happyvertical/smrt-commerce';
 *
 * // Create collections
 * const customers = await CustomerCollection.create({
 *   persistence: { type: 'sql', url: 'commerce.db' }
 * });
 *
 * // Create a customer linked to a profile
 * // Every money value is integer minor units — $100.00 is 10000 (#2401).
 * const customer = await customers.create({
 *   profileId: 'profile-uuid',
 *   creditLimit: 1000000, // $10,000.00
 *   paymentTerms: 'Net 30'
 * });
 * await customer.save();
 *
 * // Create an order
 * const contracts = await ContractCollection.create(customer.options);
 * const order = await contracts.create({
 *   _meta_type: 'Order',
 *   customerId: customer.id,
 *   totalAmount: 150000 // $1,500.00
 * });
 * await order.save();
 *
 * // Record payment with ledger integration
 * const payments = await PaymentCollection.create(order.options);
 * const payment = await payments.create({
 *   contractId: order.id,
 *   customerId: customer.id,
 *   amount: 150000
 * });
 * await payment.save();
 *
 * await payment.recordPayment({
 *   ledgerId: ledger.id,
 *   receivablesAccountId: arAccount.id,
 *   cashAccountId: bankAccount.id
 * });
 * ```
 *
 * @packageDocumentation
 */

// Self-register this package's manifest before any @smrt() decorator fires
// downstream. Must come first so the side effect runs ahead of the class
// module loads below. See __smrt-register__.ts for issue #1132 context.
import './__smrt-register__.js';

// Billing-period close, provider events, prepaid credit (#3060)
export * from './billing/index.js';
export {
  ContractCollection,
  ContractLineItemCollection,
  type CreatePayoutFromPaymentArgs,
  CustomerCollection,
  DocumentTaxCollection,
  type DocumentTaxReportFact,
  type DocumentTaxReportFactsOptions,
  FulfillmentCollection,
  FulfillmentLineItemCollection,
  InvoiceCollection,
  InvoiceLineItemCollection,
  type InvoiceNumberOptions,
  type InvoiceTaxReportFact,
  type InvoiceTaxReportFactsOptions,
  PaymentAllocationCollection,
  PaymentCollection,
  PaymentInstrumentCollection,
  PaymentIntentCollection,
  type PaymentIntentIdempotencyArgs,
  type PaymentIntentSeed,
  PayoutCollection,
  PurchaseContractCollection,
  type RefreshTaxSummaryReportOptions,
  SalesContractCollection,
  TaxCodeCollection,
  TaxComponentCollection,
  TaxSettingsCollection,
  type TaxSummaryContributorDrilldown,
  type TaxSummaryContributorDrilldownOptions,
  type TaxSummaryDrilldownContributor,
  type TaxSummaryDrilldownPending,
  type TaxSummaryExpenseSource,
  type TaxSummaryInvoiceDrilldownOptions,
  type TaxSummaryLedgerDrilldownFact,
  type TaxSummaryLedgerDrilldownSource,
  type TaxSummaryLedgerSource,
  TaxSummaryReportCollection,
  type TaxSummaryReportMeasure,
  type TaxSummaryReportRefreshResult,
  UNPAID_STATUSES,
  VendorCollection,
} from './collections/index.js';
export {
  COMMERCE_INVOICE_LINE_ADD_TOOL_SLUG,
  COMMERCE_INVOICE_LINE_UPDATE_TOOL_SLUG,
  COMMERCE_INVOICE_PREVIEW_TOOL_SLUG,
  COMMERCE_TAX_CODES_LIST_TOOL_SLUG,
  createCommerceMoneyTools,
} from './commerce-money-tools.js';
export {
  type AvailableRefundInput,
  allocateFrozenCredit,
  calculateAvailableRefund,
  type FrozenCreditAllocation,
  type FrozenCreditAllocationResult,
  type FrozenCreditRequest,
  type FrozenCreditSourceLine,
  type IssuedCreditConsumption,
} from './credit-allocation.js';
export {
  type GetInvoiceMoneyFactsInput,
  getInvoiceMoneyFacts,
  type InvoiceMoneyFacts,
  type PreviewInvoiceMoneyInput,
  type PreviewInvoiceMoneyResult,
  previewInvoiceMoney,
} from './document-money.js';
export {
  type FrozenAccountingReconciliationReady,
  type FrozenAccountingSyncResult,
  type FrozenInvoiceAccountingInput,
  type FrozenInvoiceAccountingOptions,
  type FrozenInvoiceAccountingSnapshot,
  loadFrozenInvoiceAccountingSnapshot,
  type QuickBooksFrozenInvoiceMapping,
  type ReconcileFrozenInvoiceAccountingInput,
  readFrozenAccountingSyncState,
  reconcileFrozenInvoiceAccountingSync,
  type SyncFrozenInvoiceToAccountingInput,
  syncFrozenInvoiceToAccounting,
  toFrozenInvoiceAccountingInput,
} from './invoice-accounting-sync.js';
export {
  type InvoiceMcpGetResult,
  serializeInvoiceMcpGet,
} from './invoice-mcp.js';
// Collections
export {
  type InvoiceRecordCreditNote,
  type InvoiceRecordScreenData,
  type InvoiceRecordStoredTotals,
  type InvoiceRecordTaxComponent,
  invoiceRecordStoredTotals,
  type LoadInvoiceRecordScreenDataInput,
  loadInvoiceRecordScreenData,
} from './invoice-record-screen.js';
export {
  type InvoiceEditorStorageEngine,
  type InvoiceEditorStorageMigrationResult,
  type InvoiceEditorStoragePreflight,
  migrateInvoiceEditorStorage,
  preflightInvoiceEditorStorage,
} from './migrations/invoiceEditorStorage.js';
// Money conventions and the major-units → minor-units migration (#2401)
export {
  COMMERCE_MONEY_COLUMNS,
  COMMERCE_MONEY_MINOR_UNITS_BACKFILL,
  COMMERCE_NATIVE_UNIT_COLUMNS,
  migrateCommerceMoneyToMinorUnits,
  preflightCommerceMoneyMinorUnits,
} from './migrations/moneyMinorUnits.js';
export {
  type CommerceContractTypeGroup,
  type CommercePartyLinkRow,
  type CommercePartyLinksPreflight,
  preflightCommercePartyLinks,
} from './migrations/partyLinks.js';
// Models
export {
  Agreement,
  BillingAccount,
  type BillingCloseKind,
  BillingLineSource,
  type BillingLineSourceType,
  BillingPaymentAttempt,
  type BillingPaymentAttemptFlag,
  type BillingPaymentAttemptPurpose,
  type BillingPaymentAttemptTransition,
  BillingPeriodClose,
  type BillingPeriodCloseStatus,
  type BillingStanding,
  Cart,
  type CommerceDocumentType,
  Contract,
  ContractLineItem,
  Customer,
  DocumentTax,
  type DocumentTaxOptions,
  Estimate,
  Fulfillment,
  FulfillmentLineItem,
  Invoice,
  InvoiceLineItem,
  Lease,
  type LicenseRightsSnapshot,
  LicenseSale,
  Order,
  Payment,
  PaymentAllocation,
  PaymentInstrument,
  PaymentIntent,
  Payout,
  ProductionOrder,
  PurchaseContract,
  PurchaseOrder,
  SalesContract,
  TaxCode,
  TaxComponent,
  TaxSettings,
  TaxSummaryReport,
  type TaxSummaryReportRowKind,
  Vendor,
  WholesaleOrder,
} from './models/index.js';
export {
  assertIntegerMinorUnits,
  calculateMoneyDocument,
  type LineAmountType,
  type MoneyDiscountInput,
  type MoneyDocumentResult,
  type MoneyDocumentTaxResult,
  type MoneyLineInput,
  type MoneyLineResult,
  type MoneyTaxCodeInput,
  type MoneyValidationCode,
  MoneyValidationError,
  type ResolvableTaxCodeInput,
  type ResolvedLineTaxCode,
  type ResolveLineTaxCodeContext,
  type ResolveLineTaxCodeInput,
  resolveLineTaxCode,
  type TaxCodeAppliesTo,
  type TaxCodeKind,
  type TaxCodeResolutionSource,
  type TaxComponentInput,
  type TaxRoundingScope,
} from './money.js';
// Customer and vendor contact rows posted by the party forms (#3501)
export {
  applyPartyContactIntent,
  DEFAULT_PARTY_CONTACT_FIELD_NAMES,
  normalizePartyContacts,
  PARTY_CONTACT_MAX_LENGTHS,
  type PartyContactErrorCode,
  type PartyContactField,
  type PartyContactFieldNames,
  type PartyContactFormSource,
  type PartyContactInput,
  type PartyContactIntents,
  PartyContactPartyNotFoundError,
  PartyContactPayloadError,
  type PartyContactRowErrors,
  PartyContactValidationError,
  readPartyContactRows,
  type SavePartyContactsOptions,
  savePartyContacts,
  validatePartyContactRows,
} from './party-contacts.js';
export {
  AgreementsRecipe,
  CustomersRecipe,
  EstimatesRecipe,
  FulfillmentRecipe,
  InvoicingRecipe,
  LeasesRecipe,
  LicensesRecipe,
  PurchasesRecipe,
  SalesRecipe,
  VendorsRecipe,
  WholesaleRecipe,
} from './recipes.js';
export {
  buildRevenueJournalEntries,
  type RevenueJournalDocumentInput,
  type RevenueJournalEntry,
  type RevenueJournalLineInput,
  type RevenueJournalOptions,
  type RevenueJournalResult,
  type RevenueJournalTaxInput,
} from './revenue-journal.js';
export {
  applyCommerceCookbookSettings,
  applyCookbookTaxSettings,
  applyTaxCodeExamplePack,
  COMMON_TAX_CODE_EXAMPLE_PACK,
  type CommerceTenantBootstrap,
  type CookbookTaxSettingsInput,
  cookbookTaxSettings,
  type EnsureCommerceTenantOptions,
  ensureCommerceTenant,
  ensureTenantTaxCodes,
  STANDARD_TAX_CODES,
  type TaxCodeExamplePack,
} from './tax/index.js';
export {
  aggregateTaxSummary,
  type TaxSummaryComponentMapping,
  type TaxSummaryComponentRow,
  type TaxSummaryDirection,
  type TaxSummaryExpenseFact,
  type TaxSummaryInput,
  type TaxSummaryKindRow,
  type TaxSummaryLedgerMovement,
  type TaxSummaryReconciliationRow,
  type TaxSummaryResult,
  type TaxSummarySourceScope,
  type TaxSummaryStoredFact,
  type TaxSummaryWarning,
} from './tax-summary.js';
export {
  buildTaxSummaryReportAdapterDescriptor,
  createTaxSummaryMaterializedReportHost,
  drilldownTaxSummaryContributors,
  drilldownTaxSummaryInvoiceFacts,
  TAX_SUMMARY_REPORT_ADAPTER,
  type TaxSummaryMaterializedReportDrilldownSources,
  type TaxSummaryMaterializedReportHostOptions,
} from './tax-summary-report-adapter.js';
// Types
export {
  type Address,
  type CancelRevenueOptions,
  ContractStatus,
  ContractType,
  CustomerStatus,
  CustomerType,
  FulfillmentStatus,
  FulfillmentType,
  type InvoiceCollectionMethod,
  type InvoiceCreditCalculationBasis,
  type InvoiceKind,
  InvoiceStatus,
  type PartyContact,
  PaymentInstrumentStatus,
  PaymentIntentStatus,
  type PaymentKind,
  PaymentMethod,
  type PaymentOption,
  PaymentStatus,
  PayoutStatus,
  type PurchaseContractOptions,
  type PurchaseOrderOptions,
  type RecognizeRevenueOptions,
  type RecordPaymentOptions,
  type SalesContractOptions,
  VendorStatus,
} from './types/index.js';
// UI metadata (no Svelte dependency - import ./svelte for components)
export { COMMERCE_MODULE_META, COMMERCE_UI_SLOTS } from './ui.js';
export {
  assertCommerceMoneySchemaCurrent,
  assertTenantMoneyCurrent,
  COMMERCE_DATA_NEEDS_UPGRADE,
  CommerceDataNeedsUpgradeError,
  type CommerceMoneyUpgradeStatus,
  commerceMoneyUpgradeCommand,
  findCommerceMoneyUpgradeNeeds,
  type TenantMoneyUpgradeNeed,
} from './upgrade/detect.js';
export {
  type CommerceMoneyUpgradeFailure,
  type CommerceMoneyUpgradeResult,
  type UpgradeCommerceMoneyOptions,
  upgradeCommerceMoney,
} from './upgrade/money-v2.js';
