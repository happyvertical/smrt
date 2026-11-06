# Estimate to Order conversion (#4730)

Use the public Commerce `convertEstimateToOrder` and `findOrderForEstimate`
exports to turn an accepted quote into the `Order` that milestone billing starts
from (see [contract billing schedules](contract-billing-schedules.md)). The host
owns who may accept, the acceptance evidence and any invoicing.

```ts
const { orderId } = await convertEstimateToOrder({
  db, tenantId, estimateId, requestId: 'accept:q-1:v1',
  acceptanceEvidenceRef: 'portal-accept:123',
});
```

The Estimate must be in the active tenant, `ACCEPTED`, frozen
(`moneySnapshotId`), `moneyAuthority: 'calculated'` and have a customer. The
command creates one `Order`, copies every line through the ordinary line save
(description, quantity, price, discount, tax mode and code, product, sku, dates,
billing period, sort order), copies customer, currency, terms, reference, notes
and channel, then accepts the Order so it freezes with its own snapshot. The
Order's `subtotal`, `taxAmount` and `totalAmount` must equal the Estimate's; if
tax settings changed since the quote froze, the command throws
`MoneyValidationError` and nothing is written. The Estimate is never modified
and no invoice is raised.

Lineage is stored on the Order as STI meta fields (no new column):
`sourceEstimateId`, `conversionRequestId` and `acceptanceEvidenceRef`.
`findOrderForEstimate(db, tenantId, estimateId)` returns the converted Order or
`null`; meta fields are not queryable, so it scans the tenant's Orders.

Idempotency uses the schedule commands' vocabulary. The same `requestId` and
evidence replays the existing Order; a changed payload under a reused
`requestId`, a second conversion of the same Estimate under another `requestId`,
or a `requestId` already used for a different Estimate is refused. The command
runs under `withTenantMoneyRuntime` on the caller's executor, requires the
active tenant context, and rolls back with a failing parent transaction.

Lineage is written only by this command; an ordinary save that changes any of the
three fields is refused (`FROZEN_DOCUMENT`), as is creating an Order with them
set; a converted Order's contract type is also frozen and it cannot be deleted
(that would erase the only conversion identity). The write phase runs in its own savepoint, so a failed conversion leaves no
Order even if you call it inside your own money runtime and catch its error
