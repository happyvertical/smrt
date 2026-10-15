/**
 * Recipe data gaps in the published smrt manifests (smrt 0.55.11, 0.56.0, 0.56.1) that the
 * planner's recipe checks catch. Each needs a smrt release, so the checks name
 * the exact exception here instead of weakening the rule. An entry whose gap is
 * gone fails `tests/upstream-gaps.test.ts`: delete it when smrt fixes it.
 * https://github.com/happyvertical/smrt/issues/3769, https://github.com/happyvertical/smrt/issues/4006
 * and https://github.com/happyvertical/smrt/issues/4023
 */
/**
 * smrt 0.56.1's money model (smrt#3988, smrt#4023) added document and line fields with no
 * description: the header's pricing mode, rounding, informational discount and
 * party tax id; a line's discount kind and rate, tax mode, code and its tax;
 * an invoice's credit-note links; a payment's kind.
 */
const DOCUMENT_FIELDS = [
  'discountTotal',
  'lineAmountType',
  'taxRoundingScope',
  'partyTaxId',
];
const LINE_FIELDS = [
  'discountType',
  'discountRate',
  'taxMode',
  'taxCodeId',
  'taxCodeCode',
  'taxCodeName',
  'taxAmount',
];
const CONTRACT_DOCUMENTS: Record<string, string[]> = {
  'commerce.purchases': ['PurchaseOrder'],
  'commerce.sales': ['Order'],
  'commerce.estimates': ['Estimate'],
  'commerce.wholesale': ['WholesaleOrder'],
  'commerce.agreements': ['Agreement', 'Contract'],
  'commerce.leases': ['Lease'],
  'commerce.licenses': ['LicenseSale'],
};
const MONEY_MODEL_UNDESCRIBED = [
  ...Object.entries(CONTRACT_DOCUMENTS).flatMap(([recipe, models]) => [
    ...models.flatMap((model) =>
      DOCUMENT_FIELDS.map((f) => `${recipe} ${model}.${f}`),
    ),
    ...LINE_FIELDS.map((f) => `${recipe} ContractLineItem.${f}`),
  ]),
  ...[
    'creditedInvoiceId',
    'creditedAmount',
    'arReversalJournalId',
    ...DOCUMENT_FIELDS,
  ].map((f) => `commerce.invoicing Invoice.${f}`),
  ...['creditedLineId', 'productId', ...LINE_FIELDS].map(
    (f) => `commerce.invoicing InvoiceLineItem.${f}`,
  ),
  'commerce.invoicing Payment.kind',
];
/** smrt 0.56.1's new recipes (smrt#3992, smrt#4023): most of their shown fields have no description. */
const NEW_RECIPES_UNDESCRIBED = [
  ...[
    'description',
    'amount',
    'currency',
    'vendorId',
    'paidBy',
    'paidByName',
    'recordedAt',
    'reimbursable',
    'reviewStatus',
    'reviewedAt',
    'reviewNote',
    'reimbursedAt',
    'reimbursementReference',
  ].map((f) => `expenses.tracking Expense.${f}`),
  ...['participantProfileId', 'startedAt', 'endedAt'].map(
    (f) => `timesheets.time-entries ServiceTimeEntry.${f}`,
  ),
];

export const UPSTREAM_GAPS = {
  /** A recipe that writes its menu label in title case (none since smrt 0.56). */
  titleCaseLabel: new Set<string>(),
  /** A nav id in two recipes' menus with two labels (none since smrt 0.56). */
  sharedNavId: new Set<string>(),
  /** `recipeId Model`: a model the recipe lists whose shown fields have no description (`@field({ description })`), so help has no glossary for them. */
  undescribedModel: new Set([
    // smrt 0.56 (smrt#4006)
    'reports.runtime RuntimeReport',
    // smrt 0.56.1 (smrt#3992): none of its shown fields has a description
    'expenses.tracking ExpenseReceipt',
  ]),
  /**
   * `recipeId Model.field`: a shown field with no description while the rest of
   * its model has one: smrt 0.56's `LicenseSale` `Meta` fields, and the last
   * gaps of #3769 (smrt#4006).
   */
  undescribedField: new Set(
    [
      'skuId',
      'paymentId',
      'licenseeEmail',
      'licenseeLegalEntity',
      'licenseeJurisdiction',
      'rightsMedium',
      'rightsDistributionScope',
      'rightsExclusivity',
      'rightsDuration',
      'rightsTerritory',
      'rightsSublicensing',
      'rightsDerivatives',
      'pdfUrl',
      'pdfHash',
      'onChainHashRegistryRef',
    ]
      .map((f) => `commerce.licenses LicenseSale.${f}`)
      .concat([
        'messages.mailbox EmailAccount.credentialSecretId',
        'messages.mailbox EmailAccount.settings',
        'users.sign-in Session.parentSessionId',
      ])
      .concat(MONEY_MODEL_UNDESCRIBED, NEW_RECIPES_UNDESCRIBED),
  ),
  /**
   * smrt 0.56's `reports.runtime` (smrt#4006): no `synonyms`, so fewer
   * than three match terms; the label `Reports`, which `reports.materialized`
   * also uses; no `section`, so its menu section has no icon or description;
   * a nav entry with no `description`; and help with no sections or tasks.
   */
  fewMatchTerms: new Set(['reports.runtime']),
  sharedRecipeLabel: new Set(['reports.runtime']),
  noSection: new Set(['reports.runtime']),
  undescribedNavEntry: new Set(['reports.runtime']),
  /** Help with fewer than two sections or tasks (`reports.runtime`: prose under one `#` title). */
  unstructuredHelp: new Set(['reports.runtime']),
  /** Help that names a field the recipe's models hide (none since smrt 0.56). */
  helpRefsHiddenField: new Set<string>(),
  /** Help prose that uses developer vocabulary (none since smrt 0.56). */
  developerVocabulary: new Set<string>(),
} as const;
