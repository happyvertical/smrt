# Exact cost billing

`@happyvertical/smrt-commerce/cost-billing` is an independent, transport-neutral
entry point without model, server or Svelte dependencies. It does not persist,
post, authorize, select a currency/jurisdiction, or implement credit-note lifecycle.
Legacy Invoice calculations and editor defaults are unchanged by this entry
point. In particular,
`calculateInvoiceMinorLine` retains negative ties toward positive infinity; the
new opt-in helpers use symmetric half-away-from-zero ties. Positive-only invoice
editor validation remains distinct from these generic signed calculations. The
`roundingScope: 'invoice'` behavior in this guide is a standalone cost-billing
convention; v2 document arithmetic uses `roundingScope: 'document'` and stores
allocated tax facts. See the [commercial money model](money-model.md) and
[money calculator](money-calculator.md).

Call `resolveCostMarkup(overrides)` with caller-approved precedence, most specific
first. Each item has `source`, optional `policy` and `version`, and optional
`percent`. The first defined percent wins, including `"0"`. At least one is
required; even shadowed inputs are validated. The result contains the percent,
selected index, and detached ordered provenance. Persist accepted snapshots in
the owning application; these helpers never reprice them automatically.

Call `calculateCostBilling({ basisMinor, mode, markup })` with that result. Money
is signed safe-integer minor units in a single caller-selected currency. The
basis is explicitly chosen by the caller (for example excluding recoverable tax).
`reimbursement-plus-fee` returns principal once plus rounded fee; `fee-only`
returns only the fee; `nonbillable` and `fixed-contract` return zero charge.
The result includes `principalMinor`, `feeMinor`, `totalMinor`, and provenance.
Percent strings use plain nonnegative decimal notation, range 0–100000 percent,
at most six fractional places, without whitespace, exponent or leading zeroes.
The finite range and scale bound input parsing and arithmetic resource use; they
are API limits, not tax or industry policy. Arithmetic uses BigInt intermediates and half-away-from-zero rounding. Invalid
inputs, unknown modes, inconsistent provenance and unsafe outputs throw.

`calculateCostBillingTax({ lines, rules, roundingScope })` accepts line
`id`, signed `amountMinor`, and `category`; rules explicitly map every used
category to `{ id, percent }` components. An empty component array explicitly
means exempt. Components are additive, never compounded. Shared component IDs
must use equal rates across categories; distinct rate regimes need distinct IDs.
The caller owns taxable basis and jurisdiction mapping. Duplicate category,
component-within-category or line IDs fail closed. `line` scope rounds each
line/component pair; `invoice` scope aggregates exact amounts per component and
rounds once. Two 10-unit lines at 5 percent yield tax 2 versus 1 respectively.
Returns `taxMinor` and component totals, deliberately without allocating rounded
invoice tax back to lines. Signed reversals use symmetric rounding, but mixed
positive/negative lines may differ between rounding scopes.

## Ordered compound tax with explicit allocation

`calculateOrderedCostBillingTax` is a separate opt-in calculator on the same
entry point. The additive calculator above, existing model/editor rounding and
historical snapshots are unchanged. This helper neither infers regional rules
nor persists policy. Applications must explicitly select approved tenant/regional
settings, preserve their accepted policy and result snapshots, and decide when a
new calculation is appropriate.

Supply `lines` (`id`, signed safe-integer `amountMinor`, `category`), `categories`
(`category`, `componentIds`) and ordered `components` (`id`, exact `percent`,
`priorComponentIds`). Every component must explicitly supply `priorComponentIds`:
`[]` means net-only; otherwise each ID must name a distinct earlier component.
The component basis on each eligible line is its net plus that line's allocated
tax for exactly those prior components. A prior tax not applicable to that line
contributes zero. Category membership order does not control execution; the
global component array does. A category's empty `componentIds` means exempt.

Choose `roundingScope: 'line'` to round each eligible line/component pair
half-away-from-zero. Invoice allocation options are forbidden in this mode,
including an explicitly present `invoiceAllocation: undefined` property.
Choose `roundingScope: 'invoice'` with the mandatory explicit
`invoiceAllocation: 'signed-largest-remainder'` to round each component once
over its eligible lines and distribute that rounded amount as follows:

1. Calculate each eligible line's exact rational tax from its compound basis.
2. Truncate each exact tax toward zero, retaining its signed fractional remainder.
3. Round the exact component aggregate half-away-from-zero. Subtract the sum of
   truncated line taxes to obtain the signed residual.
4. For positive residual, assign one extra minor unit to each of the lines with
   the largest signed remainders; for negative residual, subtract one unit from
   each line with the smallest (most negative) remainders. Stop when conserved.
   Ties use ascending JavaScript UTF-16 code-unit line ID order, never locale
   collation or input order. A zero residual leaves every truncated tax unchanged.

This allocation is a caller-selected arithmetic convention, not a jurisdiction
default or independent per-line rounding. It supports mixed signs and exact full
reversal: keeping the same IDs/policy and negating all amounts negates every
returned basis and allocation. An individual line's allocation can change when
other lines change; independently recalculating a subset or a partial reversal
does not preserve the original invoice allocation. Consumers needing historical
partial adjustments must use their accepted snapshot and explicit adjustment
policy. Mixed exact taxes `+0.8` and `-0.8` have zero aggregate and allocate
`0, 0` under this convention.

For example, lines `a` and `b`, each net 10, both receive `first` at 5 percent.
The invoice tax is 1, allocated `a: 1, b: 0`. If only `a` receives `second` at
100 percent with `priorComponentIds: ['first']`, its basis is 11 and its tax 11;
the total tax is 12. If only `b` receives `second`, its basis and tax are 10.
Negating both original amounts allocates `first` as `a: -1, b: 0`; the second
tax on `a` has basis and tax -11, total tax -12. At line scope the positive
example instead yields first tax 2 and total tax 13.

The result is `{ taxMinor, components }`. Components follow the supplied global
order and each returns `{ id, taxMinor, lines }`, where eligible lines are
`{ id, basisMinor, taxMinor }` in ascending code-unit ID order. Each component's
line allocations sum exactly to its total. Components with no eligible lines
return zero and `lines: []`; well-formed unused categories and components remain
valid for reusable policy. Exempt lines appear in no component allocation.
Repeated calculations and input line/category/membership permutations produce
identical output. All arithmetic intermediates use BigInt; every returned basis,
allocation, component tax and final tax must fit a safe integer, even when a
larger value would later cancel or a component has a zero rate.

All configuration is validated, including unused entries. Missing category
mapping, unknown IDs, duplicate line/category/component/membership/prior IDs,
forward/self references, missing arrays, malformed rates and unknown modes fail
closed. Rates use the same bounded decimal-string contract as the additive API.
The input is never mutated and the result holds no aliases to input objects.
