# Money calculator

`src/money.ts` is the Svelte-free authority for commercial document arithmetic.
Import it from `@happyvertical/smrt-commerce/money` (or the package root).

- Inputs are signed safe-integer minor units. Quantity and percent values have at
  most six decimal places; calculations use exact `BigInt` rationals and round
  half away from zero. Currency must be a supported ISO 4217 code with a defined
  minor unit; the exponent validates the document currency but does not rescale
  already-minor-unit inputs.
- `lineAmountType` is `exclusive`, `inclusive`, or `none`. Inclusive `amountMinor`
  is the customer-visible gross; `netMinor = amountMinor - taxMinor`.
- `roundingScope: 'line'` rounds each line/component. `document` rounds the exact
  sum for each shared component, then allocates from truncation toward zero by
  signed largest remainder. Ties use code-unit line ID order, so input order does
  not affect allocation. The residual's sign, including mixed signed lines, is
  authoritative.
- `taxes` is split by tax code and component for persistence. Shared components
  are rounded across codes at document scope. Non-taxable codes use a null
  component row with zero tax and taxable minor units equal to summed line net.
  A genuinely unassigned exclusive/inclusive line uses `taxCode: null` and emits
  `{ taxCodeId: null, taxComponentId: null }`; no synthetic ID is persisted.
- Resolve already-loaded codes with `resolveLineTaxCode()`. `none` mode always
  chooses the supplied out-of-scope code before an override. Active/scope checks
  happen during resolution; issued snapshots are not passed back through it.
  Missing exempt/out-of-scope seeds fail closed and never fall through to a
  taxable default.
- Discounts are either percent or signed minor units. An amount discount carries
  the gross sign. Editors may accept a positive magnitude, then apply the sign.

All business rejections use `MoneyValidationError`. The stable tax-code shape
codes include `TAX_CODE_DUPLICATE_COMPONENT`,
`TAX_CODE_NON_TAXABLE_COMPONENTS`, and `TAX_CODE_TAXABLE_EMPTY`, in addition to
`TAX_CODE_NOT_FOUND`, `TAX_CODE_KIND`, `TAX_COMPONENT_RATE_CONFLICT`, and the
shared input, discount, percent, compound, state, scope, safety, freeze, and
currency codes exported as `MoneyValidationCode`.

`calculateInvoiceMinorLine(input)` in `src/svelte/invoices/calculations.ts`
(also exported from `@happyvertical/smrt-commerce/invoices`) runs one line
through this calculator with a single-component code built from its resolved
fraction. It takes no options. Its discount is signed minor units and passes
through unchanged, and its ties round half away from zero for negative
lines too. Editor magnitude normalization happens before constructing that
input. See [invoice line calculation](invoice-calculations.md).
