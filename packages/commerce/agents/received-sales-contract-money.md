# Received sales agreement money

`recordReceivedSalesContractMoney({ db, tenantId, contractId, requestId,
evidenceRef, facts })` records explicitly supplied complete original monetary
facts on an empty draft `Order` or `Agreement` with a same-tenant customer.
It reuses the public complete received-money validator: safe nonnegative minor
units, exact net plus tax equals gross, known zero distinct from unknown tax
classification, and either header-only evidence or real complete source lines.
No quantity, price, tax rate, line allocation or current tax policy is invented.
Sales tax components must retain `recoverableMinor: null`; purchase recovery does
not apply. Supplier quote lineage is not accepted on this command.

`getReceivedSalesContractMoney(contract)` returns the immutable evidence or null.
Sales-named facts, snapshot and input types are public. The snapshot shares the
existing version-1 received-money representation and keeps `sourceQuote: null`.
The legacy `receivedPurchaseMoneyJson` storage name remains for schema compatibility;
applications must use commands rather than writing that field.

The host authorizes the review and binds its immutable original source separately
to this newly completed authority. Merely importing a source label such as signed
or approved does not grant current acceptance. Normal acceptance freezes the
complete money snapshot and permits the existing approved billing-schedule
commands. Issued invoices remain separate actual financial instruments.

Recording or accepting an agreement does not recognize revenue, create an AR or
tax journal, or add incurred tax-report facts. Only the applicable invoice or
purchase accounting authority contributes those facts. Incomplete original
agreement totals remain host evidence until reviewed complete totals are supplied.

The command uses the caller executor and active tenant, locks the parent, rejects
calculated lines and frozen drafts, and preserves exact retry identity. Ordinary
money mutations and deletion are guarded. Replays with changed evidence or facts
require a separate contract revision. Competing requests cannot overwrite the
first recorded authority; outer transaction rollback includes the entire record.

The customer is frozen as soon as original money is recorded, including while
the agreement or order is still a draft. Reassignment requires a new contract;
acceptance and retry preserve the original customer and monetary evidence.
