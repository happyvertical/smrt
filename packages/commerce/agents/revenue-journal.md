# Revenue journal entry builder

`buildRevenueJournalEntries()` is a pure boundary between frozen commerce money
snapshots and `smrt-ledgers` journal creation. It consumes stored document totals,
stored line amounts/tax, and stored `DocumentTax` component/account snapshots. It
does not resolve current tax codes or rates.

Callers supply the ledger book currency explicitly. A different document currency
is rejected because this release does not convert currencies. Positive documents
debit receivables and credit revenue/tax; signed credits naturally swap sides, and
`direction: -1` creates the symmetric entry set used by later reversal flows.

For inclusive documents, stored line net is `amountMinor - taxMinor`; for exclusive
and no-tax pricing it is `amountMinor`. Revenue is grouped by each line's stored
account, falling back to the caller's revenue account. Component tax uses the
stored liability account and falls back to `taxAccountId`. A `legacy-*` code that
needs this fallback returns a structured warning. Provider tax is posted once as
its own entry to `taxAccountId`. Zero-tax and null-component reporting rows do not
produce entries.

The helper validates every stored reconciliation before returning entries and uses
exact integer arithmetic for grouping and balance checks. Debit and credit values
are always positive safe integers; the sign determines the side.
