# Frozen commerce snapshot → accounting SDK mapper

`src/accounting-snapshot.ts` is a pure adapter for an approved commerce money
snapshot. It is intentionally not wired into `Invoice`, a collection, or a
provider call. The currently released `@happyvertical/accounting` package does
not export the #1408 snapshot and credit-memo inputs, so the module has local
structural types compatible with that public API. Wire it only after the SDK
release is available; do not add an unreleased dependency override.

The caller supplies persisted document and line facts: document mode and
rounding scope, integer-minor header totals, line pre-discount unit price and
discount, post-discount net amount, and each component's ID, exact percent text,
and allocated minor tax amount. The mapper converts only ISO 4217 minor units
to major units. It never calculates a discount, tax, rate, or allocation. For
an inclusive line, `taxInclusiveAmount` is the exact sum of the persisted net
and persisted tax facts, so the SDK can serialize QBO `TaxInclusiveAmt`.

`FrozenQuickBooksTaxMapping` is tenant/realm configuration and must supply an
Item.Id and TaxCode.Id for every line plus a TaxRate.Id for every stored
component. The mapper refuses missing mappings and never derives a provider ID
from a tax-code name, percent, or component identifier. It also refuses a
nonzero `providerTaxMinor`: header-only provider tax has no frozen component or
rate reference and cannot safely become a QBO tax line.

The mapper checks only snapshot identities before any provider I/O: each line's
component sum equals its stored tax, lines sum to header net/tax, and header net
plus tax equals total. `taxRoundingScope` is retained as frozen provenance; no
rounding is repeated. Currency exponents come from the shared ISO map, so JPY
and KWD retain their exact stored values.

Credit memos use positive input values and require `creditedInvoiceExternalId`.
Their provider direction is the SDK's `CreditMemo` operation. A future host
must call `requireCreditMemoCapability()` (or the SDK's equivalent) before a
write and must persist the SDK create descriptor and returned external ID. The
adapter never auto-applies a credit memo to its invoice.

The mapper's A/B fixtures are the commerce calculator's actual CAD goldens:
example A is tax-exclusive and example B is tax-inclusive. Both cover line and
document allocation; example B's document scope preserves line 3's allocated
GST cent. The external evidence probe runs the mapped example B request through
the reviewed SDK mapper without making the unreleased SDK a production
dependency.
