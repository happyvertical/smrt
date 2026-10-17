# Contract milestone billing (#4074)

Use the public Commerce `approveContractBillingSchedule`,
`issueContractMilestoneInvoice`, `getContractBillingSchedule` and
`allocateContractMilestones` exports for fixed-value milestone billing. These
commands own monetary capacity. The host owns construction scope, estimated cost,
approval permissions, signed evidence, regional policy and UI.

Start with an accepted, frozen customer `Order` or `Agreement`. The first schedule
requires `amendmentMinor: 0`, `expectedRevision: 0`, currency, explicit `basis:
'net' | 'gross'`, `approvalEvidenceRef`, `taxPolicyEvidenceRef` and exact milestone
`{ key, label, amountMinor }` entries. Their sum must equal the original Contract
subtotal for net basis or totalAmount for gross basis. There is no editable
schedule override of the accepted Contract value.

Each amendment supplies the current expected revision, a new request identity,
an explicit signed `amendmentMinor`, approval evidence and the complete next
schedule. Its ceiling is derived from the original frozen value plus all approved
amendments. Currency/basis cannot change. Already issued milestone keys, labels
and amounts must remain unchanged. Prior revisions and original Contract money
remain immutable. Unissued milestones can be rescheduled through an explicitly
approved revision. Net capacity is not a gross ceiling: each invoice's tax must
also be explicitly approved under the versioned policy.

`allocateContractMilestones(totalMinor, weights)` accepts positive integer
relative weights. All nonfinal shares truncate exact rational arithmetic; the
final entry receives the exact remainder. For example 100 with weights [1,1,1]
returns [33,33,34]. Zero amounts are allowed; negative/unsafe money and nonpositive
weights reject. The helper chooses no tax policy or commercial percentages.

Prepare a normal canonical draft Invoice and real line items through the public
Commerce collections. Draft preparation consumes no capacity; an unissued draft may be cancelled
without a claim. Then call:

```ts
const claim = await issueContractMilestoneInvoice({
  db, tenantId, contractId, requestId: 'issue:start:v1',
  revision: 1, milestoneKey: 'start', invoiceId,
  approvedMoney: { netMinor: 4000, taxMinor: 200, grossMinor: 4200 },
  invoiceApprovalEvidenceRef: 'approved-invoice:123',
});
```

The command checks same tenant/customer/currency/Contract, derives current line
money, verifies the exact approved net/tax/gross and schedule amount, freezes the
invoice and records the claim atomically. Tax-policy evidence is a host-owned
reviewed version reference, not an instruction to infer tax rates. Preserve the
approval's policy and original evidence in the host. Ordinary issue against a
scheduled Contract is refused, including direct creation in a non-draft state.
Existing issued contract invoices prevent adopting a schedule retroactively.

The explicit capacity policy is `issued-consumed`: cancellation, credits,
write-offs, payments, retention and refunds never reopen a claimed milestone.
Credits correct the canonical receivable and settlement continues through existing
Payment/PaymentAllocation facilities. Unapplied payments remain the deposit cash
authority. A replacement billing entitlement requires an explicit approved
amendment; this API does not infer that a credit authorizes re-billing. Applications
must explain that policy rather than present a hidden re-bill action. Issued
claims remain readable after later amendments and cancellations.

Every mutation requires the active tenant context and uses the tenant money
serialization barrier on the exact parent transaction executor. Identical request
replay returns the original evidence; a changed payload, stale revision or second
claim rejects. A parent rollback reverses both invoice issue and schedule claim.
A detached read DTO cannot modify persisted state. Ordinary Contract writes and
deletes cannot erase schedule history. Host authorization precedes these commands;
none is exposed as an unauthenticated generated mutation.
