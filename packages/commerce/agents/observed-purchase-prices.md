# Incomplete observed purchase prices

`recordPurchasePriceObservation` records a supplier quote or purchase-order source
instrument when the source does not establish every monetary total. Each of
`netMinor`, `taxMinor`, and `grossMinor` is an explicit safe nonnegative integer
or `null`. Zero is a known value; null is unknown. At least one amount is known.
The host explicitly interprets whether a source amount is net or gross. The
command neither derives absent tax nor uses current tax rates.

The public `PurchasePriceObservation` is separate from `Contract`. Its readback
has `monetaryAggregate: null`, the complete original snapshot, and an optional
completion link. It cannot appear in ordinary purchase tax reports or be
accepted as a calculated Contract. Source `selected`, `approved`, or other
status text remains original evidence and grants no current approval.

Source identity is `(tenant, namespace, kind, sourceKey)`. Exact replay returns
the original object. Changed evidence or request identity requires a new source
revision; it cannot rewrite the original. Concrete source lines retain their
keys and exact quantity/rate text, even when those texts do not explain the
supplier's observed amount. They are evidence, not calculator inputs.

`completePurchasePriceObservation` requires separate reviewed evidence and the
existing complete `ReceivedPurchaseMoneyFacts` contract. It preserves every
known original header amount and every fully known source-line total. When
complete line detail is supplied, identities, descriptions, quantity/rate text,
and known amounts must also match. Header-only completion does not allocate tax
or invent source line amounts: the original lines remain in the observation.
The command atomically creates a **draft** received SupplierQuote or
PurchaseOrder and appends its link. The host separately authorizes any later
acceptance. This is completion of unknown facts, not a negotiated price change.

All commands require the matching active tenant. The host authorizes the human
operation and supplies the owning executor. The tenant money barrier serializes
recording/completion and participates in caller rollback. Ordinary model saves,
collection creates, and deletes are rejected. No original journal or provider
write is created. The existing received-purchase tax-classification requirements
apply if a completed purchase order is subsequently accepted and reported.
