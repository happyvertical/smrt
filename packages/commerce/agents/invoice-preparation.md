# Invoice editor and allocation fields

Import `InvoiceEditor`, `InvoiceAllocationFields`, `InvoiceReview` and their
Props types from `@happyvertical/smrt-commerce/svelte`. `InvoiceEditor` is the
invoice form. It renders `MoneyInvoiceEditor` (also exported) and uses the
commercial money model, v2, which is the only invoice money model. Line tax
comes from tax codes, never from a typed rate. See the
[commercial money model](money-model.md) and the
[money calculator](money-calculator.md).

`InvoiceEditorProps` requires `action` and `money: MoneyEditorProps`. Optional
props are `method` (default `post`), `canEdit`, `pending`, `hiddenFields`,
`intentField` (default `intent`), `saveIntent` (default `save`), `saveLabel`
and `onsubmit`. `money` carries:

- `mode: 'v2'`;
- `draft`: currency, `lineAmountType` (`exclusive`, `inclusive` or `none`),
  `roundingScope` (`line` or `document`) and ordered `lines`;
- `taxCodes`: the authorized tax-code choices, each with its components;
- optionally `frozen`, `status`, `kind` (`invoice` or `credit_note`), `stored`,
  `onCreateCreditNote`, `customerTaxExempt`, `sellerTaxRegistrations`,
  `partyTaxId`, `showNetSubtotal` and `names`.

Each `MoneyEditorLineDraft` holds id, description, quantity, unitPrice,
`discountType` (`none`, `percent` or `amount`), discountValue (a nonnegative
magnitude; the calculator applies the line sign), `taxMode` (`inherit` or
`override`), `taxCodeId`, and the resolver's `inheritedTaxCodeId` and
`inheritedTaxCodeSource` (`product`, `customer`, `app`, `exempt-customer` or
`none`). Values are lossless strings, so input the server rejected comes back
unchanged. Choosing a tax code sets `taxMode` to `override`. Clearing it goes
back to the inherited code, and the editor shows that code's source.

```svelte
<InvoiceEditor action="?/save" money={form?.money ?? data.money}
  canEdit={data.mayEdit}
  hiddenFields={[{ name: 'requestId', value: form?.requestId ?? data.requestId }]} />
```

Native field names default to `lineAmountType`, `roundingScope`, then repeated
`lineId`, `lineDescription`, `lineQuantity`, `lineUnitPrice`,
`lineDiscountType`, `lineDiscountValue`, `lineTaxMode` and `lineTaxCodeId`, in
displayed order. Use `money.names` to rename them. `moneyEditorFieldNames`
exports the defaults, and `moneyEditorSubmission(draft)` returns the typed
shape those controls represent. Hidden fields are submitted exactly as given,
including repeated names. The default transport is a native POST, which also
works without JavaScript. `onsubmit` can enhance it.

`calculateMoneyEditorDraft(draft, taxCodes)` is the editor's only calculation:
the pure money calculator, run on the retained text. The preview gives no
authority. The server resolves tax codes (line override, else product, else
customer, else the tenant default), recomputes `taxAmount` and the totals, and
ignores any client total. Invalid input shows the calculator's message instead
of a total.

A frozen document (`frozen: true`) renders only `stored`, the server's issued
snapshot. It never recalculates and disables every field. If `stored` is
missing, the editor reports that. A frozen invoice shows a credit-note action,
enabled only when the host supplies `onCreateCreditNote`. A credit note never
offers one.

`InvoiceAllocationFields` renders source-allocation rows without a form of its
own; put it in a caller-owned native form. Each row has key, sourceId, a
currency-unit amount, optional remove, and field errors.
`mayReadSources=false` hides supplied labels and balances and renders
references instead. Unavailable sources that were retained stay postable, so
the server can reconcile them. Native names stay sourceId, allocationAmount
and the checked zero-based removeRow. `fields` renames them, and `addIntent`
defaults to `addAllocation`. Availability, reservations, budget policy and
approval belong to the caller and server.

`InvoiceReview` presents a review snapshot that the caller supplies. Edits
never infer a status change. No component generates request keys.

Focused validation: Commerce `vitest.invoices.config.ts`,
`e2e/invoices/playwright.config.ts`, `typecheck` and `build`.
