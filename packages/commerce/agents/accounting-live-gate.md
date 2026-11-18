# Live-mode gate on accounting sync (#5138)

Source: `src/accounting-live-gate.ts`, `enableLiveAccounting` /
`disableLiveAccounting` in `src/accounting-connection.ts`.

`runQuickBooksPilot` refuses anything but a fixture sandbox, but the frozen
invoice, credit and refund sync accepted any provider with
`environment: 'production'`. They no longer do without a deliberate enablement.

## Rule

A write is **production** when any of the caller's mapping scope, the provider's
own `environment`, or the environment the document is already synced under says
so. They must agree (`ACCOUNTING_ENVIRONMENT_MISMATCH` otherwise, so a
sandbox-labelled mapping cannot reach a production provider). A production write
needs, on the tenant's `AccountingConnection`:

1. `status === 'connected'` and `environment === 'production'`;
2. `liveEnabledRealmId === realmId`, set by
   `enableLiveAccounting({ tenantId, realmId, enabledBy, evidenceRef })`, which
   itself refuses unless the connected production company is that realm.

Otherwise `AccountingLiveGateError` (`LIVE_ACCOUNTING_NOT_ENABLED`) is thrown
**before** any state is reserved or provider called, so state is unchanged.
Sandbox needs no enablement and no connection (it stays the default).

Enablement is per company: reconnecting to another realm or environment, or
disconnecting, clears it; `disableLiveAccounting` switches it off. The app owns
who may call `enableLiveAccounting` and when (Work reserves it for the owner);
commerce only refuses writes without it.

## Where it is checked

`assertAccountingWriteAllowed` runs first in `syncFrozenInvoiceToAccounting`
(invoice and credit memo), `syncOrdinaryInvoiceToAccounting`,
`syncOrdinaryCreditToAccounting`, `syncOrdinaryRefundToAccounting`,
`syncRetainedInvoiceToAccounting`, `releaseRetainedInvoiceToAccounting`,
`syncRetainedCreditToAccounting`, `syncRetainedRefundToAccounting`, and the
payment sync (#5139). Reconcile and read paths do not write remotely and are
not gated. The fixture pilot stays sandbox-only.
