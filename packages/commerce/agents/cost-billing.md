# Exact cost billing

`@happyvertical/smrt-commerce/cost-billing` is an independent, transport-neutral
entry point without model, server or Svelte dependencies. It does not persist,
post, authorize, select a currency/jurisdiction, or implement credit-note lifecycle.
Existing Invoice calculations and editor defaults are unchanged. In particular,
`calculateInvoiceMinorLine` retains negative ties toward positive infinity; the
new opt-in helpers use symmetric half-away-from-zero ties. Positive-only invoice
editor validation remains distinct from these generic signed calculations.

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
