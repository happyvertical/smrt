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

## Worked examples

These examples use CAD (two decimal places), BC GST at 5%, and PST at 7%.
GST has GST only; GST+PST has both non-compound components; Exempt has none.
The shared four-line document is:

| # | Line | Quantity | Unit price | Discount | Code |
| --- | --- | ---: | ---: | ---: | --- |
| 1 | Design (service) | 10 | $85.00 | 10% | GST |
| 2 | Laptop stand | 2 | $49.99 | $5.00 | GST+PST |
| 3 | Software licence | 12 | $20.00 | — | GST+PST |
| 4 | Book | 1 | $45.00 | — | GST |

### A. Exclusive

For either rounding scope, the post-discount net amounts are $765.00,
$94.98, $240.00, and $45.00. GST is $38.25, $4.75, $12.00, and $2.25;
PST is $6.65 and $16.80 on lines 2 and 3.

| Subtotal | GST | PST | Tax | Total | Discounts |
| ---: | ---: | ---: | ---: | ---: | ---: |
| $1,144.98 | $57.25 on $1,144.98 | $23.45 on $334.98 | $80.70 | $1,225.68 | $90.00 |

The exact GST total is $57.249 and PST total is $23.4486, so both scopes
round to the same stored figures.

### B. Inclusive

The same visible post-discount amounts are tax-inclusive: $765.00, $94.98,
$240.00, and $45.00.

| # | GST, line | PST, line | Net, line | GST, document | PST, document | Net, document |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | $36.43 | — | $728.57 | $36.43 | — | $728.57 |
| 2 | $4.24 | $5.94 | $84.80 | $4.24 | $5.94 | $84.80 |
| 3 | $10.71 | $15.00 | $214.29 | $10.72 | $15.00 | $214.28 |
| 4 | $2.14 | — | $42.86 | $2.14 | — | $42.86 |

| Scope | Subtotal excluding tax | GST | PST | Tax | Total |
| --- | ---: | ---: | ---: | ---: | ---: |
| Line | $1,070.52 | $53.52 | $20.94 | $74.46 | $1,144.98 |
| Document | $1,070.51 | $53.53 | $20.94 | $74.47 | $1,144.98 |

At document scope, GST's exact line values total $53.5259. Truncation yields
$53.51, then the two residual cents go to the largest remainders: line 1 and
line 3. The cent that differs from line scope is therefore on line 3
($10.72 GST and $214.28 net). PST remains $20.94 in both scopes. Component
taxable amounts are always net in inclusive mode: at line scope GST is on
$1,070.52 and PST is on $299.09; at document scope they are $1,070.51 and
$299.08.

### C. Exempt customer with product defaults

Use A's exclusive prices, but mark the customer exempt. Exemption resolves at
step 2 before any product default: every line uses Exempt, including the
Laptop stand and Software licence that would otherwise select GST+PST.
The result is subtotal $1,144.98, tax $0.00, and total $1,144.98. The single
stored non-taxable row is Exempt on $1,144.98 with zero tax.

### D. Exempt customer with inclusive prices

Use B's inclusive prices with the same exemption. Each amount remains unchanged
and is all net: $765.00, $94.98, $240.00, and $45.00. Both rounding scopes give
subtotal $1,144.98, tax $0.00, and total $1,144.98. An inclusive exempt
document has no “includes tax” amount: display the equal subtotal and total,
plus the $90.00 informational discount.

### E. Three $0.10 GST+PST lines

For three lines of one × $0.10 with no discount:

| Mode | Scope | GST allocation | PST allocation | Tax | Subtotal | Total |
| --- | --- | --- | --- | ---: | ---: | ---: |
| Exclusive | Line | $0.01, $0.01, $0.01 | $0.01, $0.01, $0.01 | $0.06 | $0.30 | $0.36 |
| Exclusive | Document | $0.01, $0.01, $0.00 | $0.01, $0.01, $0.00 | $0.04 | $0.30 | $0.34 |
| Inclusive | Line | $0.00, $0.00, $0.00 | $0.01, $0.01, $0.01 | $0.03 | $0.27 | $0.30 |
| Inclusive | Document | $0.01, $0.00, $0.00 | $0.01, $0.01, $0.00 | $0.03 | $0.27 | $0.30 |

Document scope never leaves a residual: its component total is authoritative
and allocation preserves that exact sum. The scopes can differ by up to
ceil(n / 2) minor units per component across n small lines, so the rounding
scope is stored with the document and is never silently changed after issue.

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

For a newly created tenant, prefer the one bootstrap call, which wraps the
cookbook activation:

```ts
import { ensureCommerceTenant } from '@happyvertical/smrt-commerce';

const { moneyModel } = await ensureCommerceTenant(db, session.tenantId, {
  cookbook,
});
```

It seeds the standard codes, applies the cookbook (omit it to seed codes only),
and starts a tenant with no documents on money v2. It returns `legacy` for a
tenant that already holds documents. Every step is idempotent; re-running it
with a cookbook re-applies the cookbook defaults. The SvelteKit template calls
it from its owner setup claim when the app installs commerce.

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
from the server-owned `TaxSettings.moneyModel` marker. A tenant's first settings
row chooses the model: `v2` when the tenant has no stored Invoice or Contract
rows, `legacy` when documents already exist. The row is created by the
bootstrap above, a settings save, or the first money document, and concurrent
first writers agree on one model. `legacy` retains the existing line-save
behavior until `smrt db:migrate-commerce-money --tenant-id` converts the tenant;
that command is for existing legacy tenants only. In a v2 tenant, a draft
imported through the model is recalculated as a v2 document (a legacy `taxRate`
or tax-inclusive `amount` is not an input), while an issued legacy document is
refused with `FROZEN_DOCUMENT`; import issued history before the tenant's first
settings row and migrate it. Billing period close still writes legacy invoices:
a billing seller tenant without settings stays `legacy`, a `v2` seller is
refused, and `ensureCommerceTenant(db, sellerId, { moneyModel: 'legacy' })`
provisions a seller (or returns an empty `v2` one) on `legacy`. `migrating` is a maintenance
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

Credit notes are `Invoice` rows with `kind: 'credit_note'` and a frozen
`creditedInvoiceId`. They store positive document totals; reports, sync, and
posting apply the credit direction once from `kind`. Targeted lines use the
issued source line's price, discount, tax-code, component, and account
snapshots, so later rate changes cannot alter the reversal. Partial quantity
credits prorate flat discounts, while the final credit across every remaining
source line consumes the exact stored document-tax residual. Free-form credit
lines require an explicit tax code.

Use `previewInvoiceMoney()` to calculate a proposed draft overlay without
writing. It requires the active tenant and rejects frozen documents. Use
`getInvoiceMoneyFacts()` when a tool or integration needs the authoritative
stored header, line snapshots, stable `moneySnapshotId`, and `DocumentTax`
rows without recomputation.

## Not part of this guide

This guide does not define the tenant migration or marker-transition procedure,
reports, or currency conversion. Contract v2 persistence uses the same
tenant-money runtime gate, writes Contract headers, line snapshots, and
DocumentTax rows atomically, and freezes each persisted non-draft snapshot.
See [Contract money persistence](../../packages/commerce/agents/contract-money.md)
for the Contract-specific lifecycle, purchase recoverability, and
migration-only materialization boundary.
