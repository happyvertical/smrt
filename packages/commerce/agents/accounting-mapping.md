# Accounting mappings (#5137)

Source: `src/accounting-mapping.ts`, `src/models/AccountingMapping.ts`. Replaces
the flat `Invoice.customerExternalId` and the hand-built
`FrozenQuickBooksTaxMapping`.

## Model

`AccountingMapping { tenantId, provider, realmId, environment, kind, localId,
externalId, externalName, detailsJson, status, confirmedBy, confirmedAt,
invalidatedAt }`, unique on `(tenantId, provider, realmId, environment, kind,
localId)`. Read-only generated surface; written only by the commands.

| `kind` | `localId` | `externalId` |
|---|---|---|
| `customer` | commerce `Customer` id | provider customer id |
| `tax_code` | commerce `TaxCode` id, or `none` for untaxed lines | provider TaxCode id; `details.taxComponents` holds the ordered provider rates for compound tax |
| `tax_component` | commerce `TaxComponent` id | provider tax rate id |
| `item` | `default` or `sku:<sku>` (sku wins) | provider product/service item |
| `deposit_account` | `default` | provider clearing/deposit account (used by payment sync, #5139) |

`realmId` and `environment` are in the key, so another company or the other
environment never sees these rows. `completeQuickBooksConnection` also marks the
tenant's mappings of the previous company/environment `invalidated` (kept for
history, never used); `setAccountingMapping` reactivates a row.

## Commands

- `setAccountingMapping` / `removeAccountingMapping` / `getAccountingMapping` /
  `listAccountingMappings` (scope = `getAccountingMappingScope(db, tenantId)`,
  the connected company).
- `buildFrozenInvoiceMapping({ db, tenantId, invoiceId })` returns a
  `QuickBooksFrozenInvoiceMapping` (realm, environment, `lines`, `components`,
  `customerRef`) from the records, so sync callers pass only the tenant and the
  document. Missing mappings throw `AccountingMappingError('MAPPING_INCOMPLETE')`
  with every missing `{ kind, localId }`, never a guess. `customerRef` replaces
  the flat invoice field in the sync (`mapping.customerRef`).
- Customer resolution: `resolveAccountingCustomer` then, if needed,
  `confirmAccountingCustomer`.

## Customer resolution

1. An active mapping wins; the provider is not called.
2. Otherwise `directory.find({ name, email })`. Exactly one match that agrees on
   email (or, without an email, on name) is linked and recorded.
3. Several matches, or one that agrees on neither, return
   `needs_confirmation` with the candidates and change nothing. The operator
   calls `confirmAccountingCustomer` with a candidate (re-checked against the
   provider) or `'create'` on purpose.
4. No match: `directory.create` with a stable `requestId` per
   (customer, realm, environment), then record the mapping. A crash between
   create and record is healed by step 2 (the next lookup finds it).

## SDK seam (sdk#1539)

`AccountingCustomerDirectory` (`find`, `create`) is the port; the host adapts
the SDK's customer find / find-or-create to it. smrt tests use fakes.

Optional Svelte pickers are not included; the provider lists they need come from
the host (`directory`-style ports), and Work owns that presentation.
