# Contract money persistence

Contract money runs through `contract-money.ts`. A tenant operation enters
`withTenantMoneyRuntime` before it locks and reloads its Contract and sibling
lines on the scoped executor, resolves tax codes, and replaces the Contract
aggregate plus `DocumentTax` rows in the same transaction. Every Contract money
write needs a tenant, and a tenant whose data needs the upgrade is refused (see
[money data upgrade](money-upgrade.md)).

Draft Contract line writes recompute every sibling. `subtotal` is tax-exclusive
net after discount, `taxAmount` is the component total, and `totalAmount` is
their exact sum. Purchase component tax is recoverable only when the frozen
component says so. A Contract leaving draft snapshots registrations, party tax
identity, per-line component amounts, and `moneySnapshotId`; later money edits
are refused with `FROZEN_DOCUMENT`.

`SupplierQuote` uses purchase defaults and recoverability. Non-draft quotes
freeze just like other Contracts, but quote snapshots (including custom
descendants) are excluded by their hydrated STI subtype, not the mutable
`contractType` scalar, from report candidates and purchase tax facts. Awarding
requires a separate PurchaseOrder.
