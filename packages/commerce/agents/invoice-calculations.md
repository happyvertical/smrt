# General invoice calculations

`@happyvertical/smrt-commerce/invoices` is a Svelte-free entry usable by server handlers and browsers. `calculateInvoiceLine`, `calculateInvoiceDraft`, and `resolveInvoiceLineDraft` share exact decimal arithmetic. The UI consumes these helpers for previews; preview results confer no authority.

This guide describes the standalone, legacy-compatible invoice editor helpers.
For tenant `moneyModel: 'v2'` document arithmetic, persisted tax components, and
issued snapshots, use the [commercial money model](money-model.md) and [money
calculator](money-calculator.md) instead.

Drafts retain unparsed text. Quantity accepts nonnegative decimals with at most six fractional digits and must round-trip through the model numeric representation. Prices and flat discounts accept only whole currency minor units expressed in major-unit text. Currency uses the shared explicit ISO minor-unit table; unknown codes and codes without a minor unit are rejected. Servers must authorize their supported currency set. No exchange conversion occurs. Rates are percentages from 0 through 100 with at most six fractional digits. `discountType` is `flat` or `percent`; `taxMode` is `inherit` or `override`. An override of `0` is zero tax; an empty override is invalid. Inherited lines ignore their dormant override string.

Calculation order is quantity × price rounded half up to minor units, discount rounded half up and subtracted, then tax on the discounted subtotal rounded half up. Flat discounts cannot exceed gross. Numeric model quantities and rates use their canonical decimal representation (including supported exponent notation), never a `toFixed` expansion of binary approximation. No floating-point multiplication or epsilon comparison determines money. Unsafe individual or aggregate results are rejected; invalid lines produce errors without monetary totals. Header validation requires customer, real issue/due dates with due date not before issue date, valid currency shape/default rate, at least one line, and unique nonblank row keys.

`resolveInvoiceLineDraft` returns the existing model's resolved integer-minor price, flat discount, fractional quantity, effective fractional tax rate, and calculated amount. It verifies exact agreement with model arithmetic. `InvoiceLineItem.applyEditorDraft()` retains the editing modes alongside resolved fields; `getEditorDraft(authorizedContext)` restores them only while current authority and fields agree. See [invoice quantity storage](invoice-quantity.md) for the required existing-database migration. `calculateInvoiceMinorLine` is the currency-independent model helper: it permits existing negative-price credit lines, retains their historical ties toward positive infinity, and rejects invalid quantities/rates or unsafe/fractional money.

Trailing zeroes do not make an exact amount invalid: `100.00` JPY is 100 minor units, while `100.01` JPY is rejected. Parsing never rewrites the draft text.

## Server responsibilities

Parse native form values into the typed draft (never pass unvalidated arbitrary JSON as the typed object), enforce request/row limits, authorize customer and source references in the active tenant, and validate edits against invoice lifecycle state. Replace inherited rate/currency policy with server-authorized context, call the shared validator/resolver, and save resolved rows and invoice within the application's transaction/retry contract. Ignore any client-supplied calculated amount. For these legacy-compatible helpers, default tax remains externally determined; this module is not a tax determination service. V2 tax-code resolution and stored tax facts are defined by the [commercial money model](money-model.md). Caller-owned extension allocations, budget availability and approval evidence require their own server validation and are not part of line pricing.

Changing currency changes the precision and denomination of the entered values, not their numeric text. The UI must not silently convert entered amounts or rewrite invalid drafts. Reopening or changing authorized tax context requires fresh server validation.


## Explicit tax rounding scope

The `roundingScope: 'invoice'` option below is the standalone editor's
legacy-compatible aggregate calculation. It is distinct from v2's
`roundingScope: 'document'`, which allocates rounded tax into persisted
document tax facts; see the [money calculator](money-calculator.md).

`calculateInvoiceDraft(values, { roundingScope: 'invoice' })` and the shared
`InvoiceEditor` / `InvoiceLineEditor` `roundingScope` prop accept `line` or
`invoice`. Omission preserves per-line rounding. The server chooses this option
from its authorized policy, and supplies it again when rendering rejected forms
or reopening retained drafts; it is not a client authority field.

Invoice scope groups numerically equal effective percentages, including textual
variants such as `5` and `5.000000`, and rounds each rate group once through
`calculateCostBillingTax`. Different rates remain independent components; explicit
zero overrides remain exempt. Quantity and discount rounding are unchanged. Two
10-minor lines at 5% therefore have tax 1 in invoice scope and 2 in line scope.
This is an additive single-rate-per-line editor, not a tax determination or
compound-tax solver. Invalid scope is a validation error. Drafts still reject
negative quantities/prices; the signed model calculator is unchanged.

`lineResults` and `resolveInvoiceLineDraft` remain standalone per-line
calculations, useful for validation and existing line-mode model storage. They
are **not allocations** of invoice-rounded tax: their tax/total fields may not
sum to the aggregate. In invoice mode the UI displays each line's subtotal and
an explanation, with tax and total shown only at invoice level. Persist the
aggregate with the authorized scope and retained draft when using invoice
rounding; do not reconstruct it by summing standalone resolved line totals.
No persistence schema or `InvoiceLineItem` tax behavior is changed by this
legacy-compatible adapter API. V2 persistence and issued tax snapshots are
defined by the [commercial money model](money-model.md).
