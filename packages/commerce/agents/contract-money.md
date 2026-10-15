# Contract money persistence

Contract money runs through `contract-money.ts`. A tenant operation enters
`withTenantMoneyRuntime` before it locks and reloads its Contract and sibling
lines on the scoped executor. The legacy barrier variants retain the old line
calculation; only active v2 tenants resolve tax codes and replace the Contract
aggregate plus `DocumentTax` rows in the same transaction.

Draft Contract line writes recompute every sibling. `subtotal` is tax-exclusive
net after discount, `taxAmount` is the component total, and `totalAmount` is
their exact sum. Purchase component tax is recoverable only when the frozen
component says so. A Contract leaving draft snapshots registrations, party tax
identity, per-line component amounts, and `moneySnapshotId`; later money edits
are refused with `FROZEN_DOCUMENT`.

`materializeContractMoneySnapshot` is migration-only. Its caller supplies the
already transaction-bound migration owner executor; it verifies that owner,
locks/reloads the Contract, and never starts a runtime transaction.

`SupplierQuote` uses purchase defaults and recoverability, including during
legacy-to-v2 migration. Non-draft quotes freeze just like other Contracts, but
quote snapshots (including custom descendants) are excluded by their hydrated
STI subtype, not the mutable `contractType` scalar, from report candidates and
purchase tax facts. Awarding requires a separate PurchaseOrder.
