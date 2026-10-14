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

## Not part of this API

The calculator and editor adapter do not define persistent `TaxComponent`,
`TaxCode`, `DocumentTax`, or Invoice schema; seed packs; migrations; credit-note
posting; reports; or currency conversion. Those application and persistence
contracts are released separately. The external documentation follow-up is
tracked in [s-m-r-t.dev #309](https://github.com/happyvertical/s-m-r-t.dev/issues/309).
