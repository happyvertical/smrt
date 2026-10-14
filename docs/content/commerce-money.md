---
title: Commerce money calculator
sidebar_label: Commerce money
sidebar_position: 8
---

# Commerce money calculator

`@happyvertical/smrt-commerce/money` is the transport-neutral calculator for a
commercial document's line amounts, discounts, component tax, rounding, and
totals. It accepts and returns integer minor-unit money values. For CAD, for
example, `114498` means $1,144.98. It does not load records, choose a default,
write an invoice, or post a journal.

```ts
import { calculateMoneyDocument } from '@happyvertical/smrt-commerce/money';

const result = calculateMoneyDocument({
  currency: 'CAD',
  lineAmountType: 'exclusive',
  roundingScope: 'document',
  lines: [
    {
      id: 'design',
      quantity: 10,
      unitPrice: 8500,
      discount: { kind: 'percent', rate: '10' },
      taxCode: {
        id: 'gst',
        kind: 'taxable',
        components: [
          { taxComponentId: 'gst', percent: '5', compound: false },
        ],
      },
    },
  ],
});
```

## Units and line amounts

`unitPrice`, every `*Minor` result, and an amount discount's `minor` value are
signed safe integer minor units. `quantity` is a non-negative JavaScript number
with at most six fractional digits. `TaxComponentInput.percent` and a percent
discount's `rate` are exact decimal **percent text**: `'5'` means 5%, not
`0.05`.

The calculator first rounds `quantity × unitPrice` to `grossMinor`, then
applies exactly one discount to produce `amountMinor`. A discount is either
`none`, a percentage, or a minor-unit amount. Its sign follows the line: a
credit line has a negative discount amount and a discount can never exceed the
gross magnitude. The returned `discountTotalMinor` is informational; it has
already been applied to each line and must not be subtracted from a document
total again.

| `lineAmountType` | `amountMinor` | `netMinor` | `totalMinor` |
| --- | --- | --- | --- |
| `exclusive` | post-discount price before tax | `amountMinor` | subtotal + tax |
| `inclusive` | post-discount price including tax | `amountMinor − taxMinor` | subtotal + tax; equals the visible inclusive line amount sum |
| `none` | post-discount price | `amountMinor` | subtotal; tax is zero |

`none` requires an `out-of-scope` code. Exclusive and inclusive lines may use
`taxCode: null` when no code has been resolved; that is distinct from the
explicit no-tax mode and produces a zero-tax reporting row without inventing a
code ID.

## Tax inputs and results

A calculator tax code has an ID, one of four kinds, and components:

- `taxable` requires one or more non-compound components.
- `zero-rated`, `exempt`, and `out-of-scope` have no components and produce no
  component tax.
- A component uses a stable `taxComponentId`, exact percent text, and
  `compound: false`. Compound tax is rejected with `COMPOUND_UNSUPPORTED`.

`result.taxes` contains `MoneyDocumentTaxResult` rows grouped by tax-code ID and
component ID. It keeps a `null` component ID for a no-component or unassigned
line so reporting adapters can account for every line without pretending it
used a taxable component. UI code should display component labels from its
server-supplied code/snapshot data; the calculator deliberately has no labels.

Use `resolveLineTaxCode()` when the caller has already loaded a set of active,
direction-compatible `ResolvableTaxCodeInput` values. It is also pure and
performs no lookup. Its resolution order is: explicit line override; customer
exemption (unless overridden); product code; party code; app default; then no
code. In `none` mode it requires the supplied out-of-scope code. The returned
`source` lets a UI explain why an inherited code was chosen.

## Rounding

`roundingScope: 'line'` rounds each component on each line. `roundingScope:
'document'` rounds one total per component and allocates that total back to
lines by signed largest remainder, breaking ties by line ID. There is no
unallocated document residual. The scopes can differ by more than one minor
unit across a document: with `n` small lines, the bound is up to `ceil(n / 2)`
minor units per component. Store the selected scope with the document; do not
silently apply a later default to an existing document.

The calculator throws `MoneyValidationError`. Applications should branch on its
stable `code` (for example `DISCOUNT_EXCEEDS_GROSS`, `TAX_CODE_SCOPE`, or
`PERCENT_OUT_OF_RANGE`) rather than parse the error message.

## Tenant tax catalogue

The package root exports the tenant-scoped `TaxComponent`, `TaxCode`, and
`TaxSettings` models together with their collections. They provide the
configuration from which an application can create calculator inputs; the
calculator stays pure and accepts only the small input shape shown above.

A `TaxComponent` has a display name, an exact decimal `percent`, an optional
same-tenant liability account, a `recoverable` flag for fully recoverable
purchase tax, and `active`. A component rate is immutable after the component
is in use. Archive the component, create a replacement, and repoint editable
codes when a rate changes.

A `TaxCode` has a tenant-unique `code`, display name, `kind`, direction
(`sales`, `purchases`, or `both`), ordered component IDs, and `active`. A
`taxable` code requires one or more distinct non-compound components. The
`zero-rated`, `exempt`, and `out-of-scope` kinds must have none. Components and
defaults must belong to the same tenant as the code or settings that reference
them; inactive codes remain useful for historical display but should not be
selected for new drafts.

`TaxSettingsCollection.getOrCreateForTenant(tenantId)` returns the one settings
row for a tenant. Its public fields are `defaultSalesTaxCodeId`,
`defaultPurchaseTaxCodeId`, `defaultLineAmountType` (`exclusive`, `inclusive`,
or `none`), `taxRoundingScope` (`line` or `document`), and `taxRegistrations`.
Each registration supplies a component ID, number, and label. Settings validate
that their code and registration references belong to the tenant.

## Seeding and defaults

Run `ensureTenantTaxCodes(db, tenantId)` during tenant setup to idempotently
provide `exempt`, `zero-rated`, and `out-of-scope`. It also creates the inactive
`legacy-unreconciled` code and its zero-percent component so historical
migration data remains visible without being selectable for new work.

`COMMON_TAX_CODE_EXAMPLE_PACK` contains illustrative Canada GST, BC GST + PST,
Ontario HST, UK VAT, Australian GST, and New Zealand GST components and codes.
`applyTaxCodeExamplePack(db, tenantId)` saves the pack idempotently and returns
its component and code IDs. It is a starting point: review local applicability
and set each liability account before a code is used in production.

For a host that owns the database and authenticated tenant context, use the
explicit server-side cookbook activation boundary after schema setup:

```ts
import { applyCommerceCookbookSettings } from '@happyvertical/smrt-commerce';

await applyCommerceCookbookSettings(db, session.tenantId, cookbook);
```

`applyCommerceCookbookSettings()` reads core's portable cookbook policy and
creates or reuses the component, code, and tenant settings in a transaction.
Cookbook `taxRate` is a fraction (`0.05` means 5%); the commerce API
`applyCookbookTaxSettings()` accepts a percentage (`5` means 5%). A zero rate
uses the `out-of-scope` default. The cookbook CLI alone does not write tenant
tax records because it has neither a database nor authoritative tenant context.

## Svelte invoice editor

`@happyvertical/smrt-commerce/svelte` exports `InvoiceEditor`,
`MoneyInvoiceEditor`, `MoneyEditorProps`, `calculateMoneyEditorDraft`, and
`moneyEditorSubmission`. Passing `money: { mode: 'v2', ... }` to
`InvoiceEditor` opts into the money editor; omitting it preserves the existing
legacy invoice editor contract.

The v2 editor uses native controls and posts a calculation-free shape from
`moneyEditorSubmission()`. An application owns validation, authorization,
persistence, and the form action. For a draft, the editor recalculates only
from the supplied `MoneyEditorDraft` and tax-code inputs. For a frozen document,
pass `frozen: true` with a `MoneyStoredDocument`: it renders that snapshot and
does not recalculate its totals or tax rows. This lets issued-document display
stay faithful to its recorded allocation even when tax configuration later
changes.

## Persisted Invoice money

The public `Invoice` and `InvoiceLineItem` save paths select their behavior
from the server-owned `TaxSettings.moneyModel` marker. Missing settings and
`legacy` retain the existing line-save behavior. `migrating` is a maintenance
guard: Invoice money writes fail until its owner restores `legacy` or activates
`v2`. Generated surfaces and ordinary `TaxSettings.save()` calls cannot change
the marker or its owner token on an existing settings row.

With `moneyModel: 'v2'`, saving a draft Invoice or Invoice line locks and
reloads the parent and siblings, resolves the current tax inputs, runs the pure
calculator once, and atomically persists the resolved line values and Invoice
headers. Invoice tax selection uses the line override when present; otherwise a
customer exemption selects the exempt code, followed by product, customer, and
tenant default. `none` mode selects the tenant's out-of-scope code. The
persisted `InvoiceLineItem.amount` is post-discount amount in the document's
mode: it is tax-exclusive net for `exclusive`, and includes tax for `inclusive`.
`taxAmount` stays separate in both cases.

The first transition away from `DRAFT`, or setting `arJournalId`, freezes the
money document. The Invoice and each line receive the same stable
`moneySnapshotId`; later lifecycle and payment updates retain it. Header or
line money changes, moving a line, adding a line, and deleting a line then fail
with `FROZEN_DOCUMENT`. The snapshots retain document settings, tax codes and
components, seller registrations, party tax identity, and the line's product,
pricing, discount, and source details, so later tax configuration changes do
not rewrite an issued Invoice.

The aggregate also replaces derived, read-only per-code/component tax rows.
They retain code and component labels, exact percent, liability account, taxable
minor units, and tax minor units. A genuinely unassigned zero-tax line may have
no tax-code or component identity. Provider-calculated tax remains the separate
Invoice `providerTaxAmount`; it contributes to header `taxAmount` and
`totalAmount`, but never creates an application tax code or component.

`InvoiceLineItemCollection.getTotalForInvoice()` remains a public compatibility
helper that sums stored line `amount` values. It is not the Invoice amount due
in v2: use the persisted `Invoice.totalAmount`, which includes resolved tax and
`providerTaxAmount`, for the document total.

## Not part of this guide

This guide does not define the tenant migration or marker-transition procedure,
Contract money persistence, issued-document credit-note posting, reports, or
currency conversion. Those application contracts are released separately. The
external documentation follow-up is tracked in
[s-m-r-t.dev #309](https://github.com/happyvertical/s-m-r-t.dev/issues/309).
