# Historical issued sales and original customer funds (#4081)

Historical intake is a separate source authority, not a new sale, send, or cash
posting. Hosts must authorize the reviewer/importer, preserve original evidence,
and call these public commands with the explicit active tenant. All writes use
one caller-affine transaction and the existing tenant money serialization lock.

`recordHistoricalSalesMoney({ db, tenantId, invoiceId, requestId, evidenceRef,
review, source, facts, creditedSource? })` adopts an empty draft Invoice. Supply
original integer minor-unit net/tax/gross, explicit signed-versus-magnitude
polarity, original issue calendar date/time zone, and a nullable unknown due date.
Normal calculated Invoice construction still defaults its due date as before.
Historical invoices expose `moneyAuthority: 'historical'` and a frozen source
snapshot. They create no InvoiceLineItems, fake quantities/rates, delivery event,
AR/revenue journal, or provider invoice.

A `detail: { kind: 'lines', lines }` source creates immutable
`HistoricalSalesLine` children. The returned `{ snapshot, lines }` binds every
source key to a concrete `lineId`; use these IDs for consumer crosswalks.
Unknown line tax, gross, quantity and rate remain null. Signed real adjustment
lines retain their source values. The line net sum and every fully known other
sum must exactly equal its corresponding original header.

Historical credits specify the exact original invoice/money snapshot and
optional concrete original child IDs. Independent net, tax and gross capacity
checks never prorate a header. `getHistoricalSalesMoney` and
`readHistoricalSalesLines` validate immutable retained authority.
`getInvoiceMoneyFacts` includes the historical source projection. Exact header
reports remain available through `listHistoricalSalesHeaderFacts` even when tax
classification is unknown. Breakdown-dependent tax reports require explicit
reviewed component identities, taxable and net bases and classification; they
never infer a percentage from the source amount or borrow today's rate.

Optional original `source.retention` records exact retained cents, an explicit
retained-first credit policy, source actors/evidence and original calendar-dated
releases. This contract represents retention configured at original issue; its
original effective date must equal the issue calendar date. A later retention
configuration requires its own supported source event contract. Derived retention
events retain actual `recordedAt` and separate
`effectiveOn`; as-of original cash eligibility uses the original dates. Ordinary
current retention configuration/release commands keep their existing behavior.
Original credit/release sequencing rejects a release whose retained-first
capacity was already consumed; same-day ordering must be explicitly reviewed.
Release payment terms remain the original invoice due date, including an
explicitly unknown date. No jurisdiction terms are invented.

`recordHistoricalCustomerFunds` retains original receipt/refund evidence and
explicit original deposit/release policy without creating a Payment or journal.
Original accounting ownership and journal references are evidence, not authority
to create duplicate original cash. Refunds identify either conserved unapplied
funds or one exact issued credit. Their headers immediately reserve refund
capacity, even before their original allocation row is imported.

`recordHistoricalCustomerAllocation` records exact source allocation identities.
Receipt applications affect the shared invoice paid balance once. Same-original
credit allocation rows and refund allocation rows audit their already-recorded
economic effects and do not reduce balances again. Cross-invoice transferable
credits are not represented by this contract. Same-day cash/credit chronology
requires explicit reviewed ordering; earlier original cash remains preserved
when a later credit creates owed/refundable overpayment. Original cash dates
remain separate from current balances and import timestamps.

`getHistoricalCustomerFundsPosition` returns exact received/allocated/refunded/
available minor units. `applyHistoricalCustomerFunds` and
`refundHistoricalCustomerFunds` perform NEW movements against remaining original
funds using explicit current active same-tenant accounts and the pinned original
policy terms. Applications use the existing liability-to-AR reclassification;
refunds use the existing journal-backed Payment command and retain the historical
receipt ID. Original receipts are never forged into completed Payments. Shared
live/historical paid/refund capacity prevents a second allocation or refund.

Stable source namespace/key identities replay exact facts across import runs
without replacing the original importer or evidence. Changed facts/policy or
source-version reuse conflicts. Ordinary/generated model writes and deletion
cannot mutate these immutable records. Provider synchronization and new revenue
recognition reject historical authority until an explicit supported historical
accounting representation is supplied; exact original money is still readable.

Focused evidence covers source/header immutability, concrete children, original
cash/credit/refund chronology, conservation, CAD journals for new movements,
caller rollback and isolated PostgreSQL execution. Consumer historical adapters
must still map every source table and prove full-cohort reconciliation; adopting
these public facts alone is not full reference-import acceptance.

Current explicitly dated retention releases append after the immutable original
release prefix. Both remain readable without changing original dates or source
authority; replay binds the explicit date and caller rollback restores the
complete release history. Provider releases retain their effective date in the
canonical retention history as well as provider evidence. Shared SQLite and
PostgreSQL retention suites verify reload, exact retry, original-prefix tamper
refusal, and transactional rollback.

Historical cash allocations are validated as dated payment prefixes, independent
of source import order. Backdated insertion rechecks later application dates;
ordinary public allocations retain their canonical allocatedAt chronology.
Same-day credit ordering remains explicit. Later credits alone do not
retroactively invalidate cash received before their issue date.
