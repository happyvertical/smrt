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

## Received supplier monetary evidence

`recordReceivedPurchaseMoney({ db, tenantId, contractId, requestId, evidenceRef,
facts, sourceQuote? })` records declared money on an existing empty draft
`SupplierQuote` or `PurchaseOrder`. Authorize the human in the host first and
call inside its active tenant context. The command locks tenant settings and
the document on its transaction executor; an outer transaction can include
creation of the quote/order. It returns a `ReceivedPurchaseMoneySnapshot`;
`getReceivedPurchaseMoney(contract)` returns that validated snapshot or `null`
for calculated documents. The public command is not an unguarded MCP action.

```ts
await recordReceivedPurchaseMoney({
  db, tenantId, contractId: quote.id, requestId: 'received-revision-1',
  evidenceRef: 'supplier-document:revision-1',
  facts: {
    currency: 'CAD', netMinor: 10000, taxMinor: 537, grossMinor: 10537,
    taxComponents: null,
    detail: { kind: 'header-only' },
  },
});
// Reload after the command; stale instances cannot overwrite its authority.
const received = await contracts.get({ id: quote.id }, { cache: false });
received.status = ContractStatus.ACCEPTED;
await received.save();
```

This sets `moneyAuthority='received'`; aggregate headers retain exactly
10000/537/10537 without guessing a tax rate. The default `calculated` mode and
its line/tax-code calculator are unchanged. Received facts become immutable
when recorded. Exact retries return the original snapshot even after acceptance;
changed requests need a new document revision. Direct authority/evidence writes,
header edits, calculated lines, party/type changes and deleting received history
are rejected. Acceptance sets the normal `moneySnapshotId` without recalculating
source amounts. A stable application quote identity may reference a distinct
canonical `SupplierQuote` for each immutable revision.

`detail` must explicitly be `header-only` or `lines`. The latter supplies complete
source `netMinor`, `taxMinor`, `grossMinor` per uniquely keyed line with exact
aggregate reconciliation. Optional `quantityText`/`unitRateText` retain original
decimal text, never drive recomputation. When source lines are incomplete, retain
them in the referenced source evidence and use header-only monetary facts; do
not invent `ContractLineItem` quantities, tax lines, or allocations.

`taxComponents:null` means unknown decomposition. `[]` means known zero tax,
which requires `taxMinor:0`, but does not classify that zero as exempt/zero-rated.
Each supplied component retains its source key, label, amount, explicit
`classification` (`taxable`, `zero-rated`, `exempt`, `out-of-scope`, or `null`)
and `recoverableMinor` (including explicit zero or unknown `null`). Optional
`taxCodeId`, `taxComponentId` and `taxableMinor` remain unknown when omitted. Values are exact
safe nonnegative minor units; sums use integer arithmetic. No recoverability,
rate, taxable basis or classification is inferred from a label or amount.

An order can include
`sourceQuote:{contractId,relationship:'copy'|'negotiated'}`. The quote must be
accepted, frozen, received, and match tenant/vendor/currency. `copy` requires
identical facts. `negotiated` requires separately supplied approved monetary
facts and a separate evidence reference; it never prorates a quote. The command
records lineage but does not manufacture acceptance or financial approvals.

Received SupplierQuotes remain excluded from incurred purchase-tax reporting.
PurchaseOrders retain their existing report eligibility. For a received order,
public document report facts project explicit source amounts without creating
calculated `DocumentTax` rows or fictitious rates. Each report component must
have an explicit classification, tenant-owned tax code, taxable basis, recoverable amount and, for
`taxable`, a tenant-owned `taxComponentId`. Missing facts raise
`ReceivedPurchaseTaxClassificationRequired` with code
`RECEIVED_PURCHASE_TAX_CLASSIFICATION_REQUIRED` and the affected order ID. This
blocks only a report whose tenant/date/currency window includes that order;
recording, accepting and awarding unknown-classification evidence remains valid.
Existing calculated PO reporting is unchanged. Correct classification through an
explicit reviewed replacement revision and cancellation of the superseded
report-eligible order, preserving its history; never rewrite frozen evidence or
silently omit the unknown order from a report.

The two added Contract fields use the normal generated schema/migration flow;
apply the generated migration before using the new public command on an existing
database. Native SQLite/PostgreSQL acceptance is in
`received-purchase-money.test.ts` / `received-purchase-money.optional.test.ts`.
DuckDB retains the existing unsupported native Contract foreign-key boundary.
