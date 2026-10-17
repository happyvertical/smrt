# Customer advances and unallocated cash

The public `recordCustomerFunds`, `allocateCustomerFunds`, `refundCustomerFunds`,
`reverseCustomerFundsAllocation` and `getCustomerFundsFacts` commands reuse
Payment, PaymentAllocation and smrt-ledgers journals. They do not create invoice
revenue, issue credit notes, transmit money to a bank or call a provider.
Applications authorize each command and supply human/source evidence.

A receipt requires an explicit immutable policy version:

- `mode`: `unapplied-ar` or `deposit-liability`.
- `taxTiming: 'invoice-tax-point'`: the caller has explicitly reviewed that tax
  belongs on the eventual invoice. This is the only supported timing. The API
  does not assume that every jurisdiction treats deposits as untaxed; other
  timing policies are rejected and need a separate supported accounting model.
- `releaseEligibility`: `any-issued-invoice` or `final-invoice-only`.
- Distinct cash and receivables asset accounts, plus a liability account only
  for liability mode. Every account must be active in the same tenant chart.

Ledgers currently has no separate Ledger entity or currency-restricted Account
field. The ledger boundary is its tenant-owned chart; currency is explicit on
this receipt and every journal entry. The legacy `RecordPaymentOptions.ledgerId`
is unused by existing Payment settlement. These commands neither pretend it
validates an independent ledger nor invent account metadata conventions.

| Operation | Unapplied AR | Deposit liability |
| --- | --- | --- |
| Receipt | DR cash / CR AR | DR cash / CR customer liability |
| Application | Existing settlement allocation | DR customer liability / CR AR |
| Unallocated refund | DR AR / CR cash | DR customer liability / CR cash |
| Application reversal | Reverse settlement allocation | DR AR / CR customer liability |

All amounts are positive safe integer minor units. Available capacity is exactly
`received - active applications - settled source-linked refunds`. A refund is a
positive outgoing Payment with immutable source-receipt lineage; it is not an
invoice credit refund. Reversal retains the original application and appends an
inverse operation and journal, removing only the active settlement row. An issued
invoice credit or credit refund blocks application reversal so previously spent
cash cannot become refundable a second time. Resolve that invoice correction
through its own authority first.

Each request carries `effectiveOn` (calendar date), `evidenceRef`, `actorId` and a
stable `requestId`. Effective dates are distinct from recording timestamps and
must be chronological within a receipt's movements. Receipt/refund `paidAt` and
journal dates use the explicitly supplied effective date. Exact replays return
current conserved facts; changing the request payload fails. Refund/application
races serialize on the tenant money boundary and receipt revision. Caller-owned
transactions include the payment, journals, allocation, status and audit evidence.

Application requires a matching issued invoice, customer, currency, optional
sales contract and actual `moneySnapshotId`. `release` also names the frozen
receipt policy version and the host's immutable invoice-approval evidence. Under
final-only policy, the host must verify and attest `kind: 'final-invoice'` from
that frozen approval. This is an application authorization responsibility, not a
user-supplied checkbox or inference from invoice numbering. The generic library
checks the attestation shape and exact canonical monetary snapshot; it does not
know construction milestone/finality rules.

`Payment.customerFundsJson` is command-owned. Ordinary saves, deletes,
PaymentAllocation create/update/delete, collection allocation helpers, payment
intent settlement and supplier payouts cannot repurpose managed advances or
bypass required journal entries. Managed refunds cannot be allocated to invoice
credits. `getUnallocatedFromPayment` subtracts managed refunds and requires the
persisted receipt amount. Direct SQL and administrative ledger mutations remain
outside this domain authority; facts refuse missing/voided journal evidence.

```ts
await withTenant({ tenantId }, async () => {
  const received = await recordCustomerFunds({
    db, tenantId, customerId, currency: 'CAD', amountMinor: 10000,
    method: PaymentMethod.BANK_TRANSFER, requestId: receiptRequestId,
    effectiveOn: '2026-10-01', evidenceRef: bankReceiptRef, actorId,
    policy: {
      version: reviewedPolicyVersion, mode: 'deposit-liability',
      taxTiming: 'invoice-tax-point', releaseEligibility: 'final-invoice-only',
      cashAccountId, receivablesAccountId, liabilityAccountId,
    },
  });
  await allocateCustomerFunds({
    db, tenantId, paymentId: received.paymentId, invoiceId, amountMinor: 8000,
    requestId: applicationRequestId, effectiveOn: '2026-10-10',
    evidenceRef: applicationEvidenceRef, actorId,
    release: {
      kind: 'final-invoice', invoiceSnapshotId,
      approvalEvidenceRef: frozenFinalInvoiceApprovalRef,
      policyVersion: reviewedPolicyVersion,
    },
  });
});
```

Native `customer-funds.test.ts` and `customer-funds.optional.test.ts` prove exact
journals, both modes, direct-path protections, dates, finality evidence,
conservation, invoice-credit interaction, retries, caller rollback and a real
PostgreSQL post-journal write fault plus refund/application race. Run PostgreSQL
through the standard managed database wrapper; never use an application's schema.
