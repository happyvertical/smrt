# Payment allocation integrity

`PaymentAllocation.save()` owns the financial boundary for every direct or
collection write. Both payment and invoice must exist, belong to the same
exact tenant (global is distinct), have the same customer and currency, and
have room for the positive safe-integer minor-unit amount. Zero-total invoices
have no room. Missing or zero-total invoice fixtures no longer bypass the cap.
Pending payments remain allocatable; this command does not establish settlement
proof. Generated REST/MCP/CLI allocation writes remain closed. Applications
must authorize the actor before invoking these backend commands.

Use `PaymentAllocationCollection.allocatePayment({ paymentId, allocations,
allocatedBy })` for a split. Each allocation is `{ id, invoiceId, amount }`, with
a caller-generated stable UUID retained across retries. Exact replay
reuses the existing rows without applying money again; an existing id with
different parents or amount fails. Replay preserves an already-paid invoice's
recorded payment date. Reversing
payment clears that date; reaching full payment again records the new date.
The complete batch and invoice payment-status refresh share one transaction. Invoices must
already be in a status that permits payment (normally SENT); WRITTEN_OFF retains
its terminal status. A failed leg rolls back every leg and parent revision.
Direct allocation saves continue to leave status refresh to the caller. Allocation
writes advance both parent revisions: reload a previously held parent with
`await parent.loadFromId()` before applying later edits or status refresh.
Stale parent saves continue to fail the core revision guard; no implicit
revision refresh bypasses another editor. In-package billing follows this rule.

Once inserted, allocation tenant/payment/invoice identity is immutable. Amount
corrections are capped against the other allocations. Parent saves reject
changes to tenant, customer, currency or amount that would invalidate committed
allocations. A payment may be increased or reduced to its allocated total;
invoice totals continue to derive from persisted invoice lines where present.
Standalone payments remain saveable when allocation storage has not been
provisioned. An existing allocation table always participates in validation;
storage probes and permission errors propagate instead of disabling the guard.

All participating writes bind collections to the owning transaction executor.
They claim parent revisions before reading balances. Concurrent writers can
receive a revision conflict or database serialization failure; reload and retry
the complete transaction with the same allocation ids. Never retry only the
last leg inside an already failed transaction. PostgreSQL Repeatable Read
snapshots fail closed through the same revision writes. SQLite serializes the
owning write transaction. DuckDB is not a supported commerce allocation store:
the existing declared foreign keys require ON UPDATE CASCADE, which its DDL
boundary explicitly refuses; no weaker schema is substituted.

### Undelivered invoice payment progress

Allocation may move an undelivered DRAFT invoice to PARTIAL or PAID without a
customer delivery event. Neither operation invents `sentAt` or `viewedAt`.
After allocations are removed, reload the parent and call
`updatePaymentStatus(remainingTotal)` and `save()` within the caller transaction.
Zero remaining allocations restore DRAFT only for an undelivered invoice;
a delivered invoice returns to SENT/VIEWED according to its delivery history.
DRAFT cannot conceal positive allocations. A DRAFT save checks both its supplied
delivery timestamps and the currently persisted timestamps, so clearing them
locally during reversal cannot bypass the undelivered requirement. This guard
does not introduce an immutable lifetime delivery-history record.
