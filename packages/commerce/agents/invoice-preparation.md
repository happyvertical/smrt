# General invoice editor and allocation extensions

Import `InvoiceEditor`, `InvoiceLineEditor`, `InvoiceAllocationFields`, `InvoiceReview`
and their Props types from `@happyvertical/smrt-commerce/svelte`. `InvoiceEditor`
is the general invoice form; `InvoiceLineEditor` and `InvoiceAllocationFields`
render fields only and never nest a form. The interactive Commerce invoice preview
shows general line items with an optional allocation extension.

`InvoiceDraftValues` contains customerId, issuedOn, dueOn, currency, paymentTerms,
taxRate and ordered lines. Each `InvoiceLineDraft` contains caller key, description,
sku, fractional quantity, unitPrice, discountType, discountValue, taxMode and
taxRate. Editable values are lossless strings, including invalid submitted input.
Unit price and flat discount are currency-unit text; percentage values use `5`
for five percent. `discountType` is `flat` or `percent`; `taxMode` is `inherit` or
`override`. Explicit override `0` means zero tax; it never means inherit. Unknown
modes remain representable for rejected submissions. Dates remain text so invalid
values survive action failures. Customer options are caller-authorized projections;
unknown retained IDs remain visible. Currency uses the shared CurrencySelect.

See [server calculation and persistence semantics](invoice-calculations.md).

The UI invokes the exact, Svelte-free `calculateInvoiceDraft` and
`calculateInvoiceLine` helpers for previews. The shared public calculation entry
is `@happyvertical/smrt-commerce/invoices`. Valid totals use safe integer minor
units, with exact decimal arithmetic and explicit currency precision. Invalid
drafts show an unavailable-total message rather than plausible numbers. The
calculator uses Commerce's explicit exponent table and its existing two-digit
fallback for other uppercase three-letter codes; the server must authorize its
supported currencies. Calculated values are never submitted as authority.
The server revalidates customer/SKU, prices, quantity, discounts, tax policy,
permissions and calculated totals. Header taxRate is a draft preview default,
not a new persisted Invoice tax field; replace it with authorized tax context
on the server. Client edits never establish approval or allocate inventory.

```svelte
<InvoiceEditor action="?/save" values={form?.values ?? data.values}
  customers={data.authorizedCustomers} errors={form?.errors}
  message={form?.message} canEdit={data.mayEdit}
  hiddenFields={[{ name: 'requestId', value: form?.requestId ?? data.requestId }]}>
  {#snippet children(current)}
  <InvoiceAllocationFields currency={current.currency}
    allocations={form?.allocations ?? data.allocations}
    sources={data.authorizedSources} mayReadSources={data.mayReadSources}
    canEdit={data.mayEdit} />
  {/snippet}
</InvoiceEditor>
```

Native header names default to customerId, issuedOn, dueOn, currency,
paymentTerms, invoiceTaxRate. Repeated line names are lineKey, lineDescription,
lineSku, lineQuantity, lineUnitPrice, lineDiscountType, lineDiscountValue,
lineTaxMode and lineTaxRate, in displayed order. `fields` and `lineFields` adapt
names. Caller `errors` use header names or `lineKey.fieldName` keys. Repeated
hidden fields retain exact values. Avoid collisions with the component's names.

Default submitter `intent` values are `save`, `addLine` and `removeLine:<key>`;
`saveIntent`, `addIntent`, `removePrefix` and `fields.intent` adapt the contract.
Save is first so implicit Enter cannot remove/add a row. Structural actions
use formnovalidate, preserving every submitted draft string and request token.
The caller returns updated rows for add/remove; it must not persist or rotate
request identity simply because the user added a line. The default transport
is native POST, including without JavaScript. With JavaScript, input changes
update exact previews without mutating the supplied values object. `onsubmit`
may enhance transport; caller-owned retryStatus/pending controls submission.

Allocation fields remain optional application-specific composition. Each row
has key, sourceId, currency-unit amount, optional remove and field errors.
`mayReadSources=false` hides supplied labels/balances and renders references.
Retained unavailable sources remain postable for server reconciliation. Native
names remain sourceId/allocationAmount and checked zero-based removeRow;
`fields` maps these, and addIntent defaults to addAllocation. Availability,
reservations, budget policy and approval are caller/server concerns. The
extension must receive the same canEdit/pending capability as its owner.

`review` is a caller-supplied snapshot; edits do not infer status changes.
Read-only disables fields and hides mutation buttons. On rejected, denied or
uncertain actions, return every original string, stable row key, errors and
caller request/tenant/fingerprint identity. No component generates request keys.

Focused validation: Commerce `vitest.invoices.config.ts`,
`e2e/invoices/playwright.config.ts`, `typecheck`, and `build`; consolidated
release gates and calculator/model checks remain separate owning validations.
