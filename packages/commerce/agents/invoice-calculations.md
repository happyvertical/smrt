# Invoice line calculation helper

`@happyvertical/smrt-commerce/invoices` is a Svelte-free entry for server
handlers and browsers. It exports `calculateInvoiceMinorLine`,
`MoneyValidationError` and the `MoneyValidationCode` type.

Document arithmetic, tax-code resolution, persisted tax components and issued
snapshots belong to the [commercial money model](money-model.md) and the
[money calculator](money-calculator.md). The invoice editor previews with
`calculateMoneyEditorDraft`; see [the invoice editor](invoice-preparation.md).

`calculateInvoiceMinorLine({ quantity, unitPrice, discount, taxRate })`
calculates one stored line in integer minor units, independent of currency. It
returns `grossMinor`, `discountMinor`, `subtotalMinor`, `taxMinor` and
`totalMinor`, and it runs the same money calculator the documents use:

- `quantity` is nonnegative, with at most six fractional digits;
- `unitPrice` is a signed safe integer, so credit lines may be negative;
- `discount` is a flat signed safe integer that carries the gross sign;
- `taxRate` is an already-resolved fraction in [0, 1], with at most eight
  fractional digits. It is an input to this helper only; it never determines
  tax on a stored invoice line, whose tax comes from its tax codes.

Rounding follows the money calculator, so a negative credit line rounds
symmetrically with its positive counterpart. Numeric quantities and rates use
their canonical decimal form, including exponent notation, and never a
`toFixed` expansion. Invalid quantities or rates, fractional or unsafe money,
and a discount with the wrong sign throw `RangeError` before persistence.

The [invoice quantity migration](invoice-quantity.md) uses this helper to
check that every stored quantity round-trips exactly.
