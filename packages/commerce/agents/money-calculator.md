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

The existing invoice functions in `src/svelte/invoices/calculations.ts` remain
compatibility adapters for the legacy single-component exclusive model until the
tenant migration gate enables persisted money-v2 fields. In particular,
`calculateInvoiceMinorLine(input)` defaults to the legacy negative-tie rule for
existing model saves. Migration-aware callers explicitly pass
`{ moneyModel: 'v2' }`; there is no process-global mode. V2 callers pass the
stored signed discount through unchanged; editor magnitude normalization happens
before constructing that stored input.
