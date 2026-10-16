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

## Ordered compound taxes

`TaxComponentInput.compound: true` uses every preceding component in the same
ordered tax code. Different applicable line/category subsets use different codes;
no missing predecessor is invented. Exclusive and explicit-net credit inputs use
prior rounded taxes at line scope or prior allocated taxes at document scope.
Shared components retain one rate. Contradictory dependency orders across codes
fail with `TAX_COMPONENT_DEPENDENCY_CYCLE`.

Inclusive extraction computes exact ordered rational factors, then rounds or
allocates the extracted component taxes. Net is the gross-minus-tax residual.
This is not a promise that an inclusive extraction reverses an exclusive rounded
calculation penny-for-penny. Signed reversals use the same symmetric rules.

Compound result components and frozen line snapshots carry `compound: true` and
`taxableMinor`. Component tax rows preserve this actual basis, with `netMinor`
separate so kind/revenue summaries do not include tax-on-tax as net revenue.
Historical additive snapshots omit these optional fields. Credits reconstruct the
frozen ordered components; a final credit consumes the remaining frozen bases and
taxes. The compatibility line `taxRate` is the observed effective tax/net ratio
for compound lines, not a flattened statutory rate; never use it to reconstruct
a document. Use component snapshots and canonical minor-unit totals.

`DocumentTax.netMinor` is a nullable generated-schema field. Additive records use
null and retain their previous reporting shape. Upgrade schemas before projecting
reports. Received purchase components may declare a taxable basis above net;
when that occurs their explicit `netMinor` is required for report classification.
Recording evidence remains allowed without that classification.

The current accounting SDK validates additive rates only. The frozen accounting
mapper rejects compound snapshots with `ACCOUNTING_SYNC_UNSUPPORTED` until the
provider contract supports their ordered metadata ([SDK #1412](https://github.com/happyvertical/sdk/issues/1412)). It never substitutes an
effective/flattened rate to bypass provider validation.
