# Commercial UI composition

The commercial UI release is tracked in [#3423](https://github.com/happyvertical/smrt/issues/3423).
Components compose the provider-free controls in `@happyvertical/smrt-ui/forms`
and visual controls in `@happyvertical/smrt-ui`. They do not require SvelteKit,
a database, or the top-level `smrt-svelte` integration package.

## Native forms and recovery

The application owns action URLs, HTTP methods, submitter names/values, field
names, request identity, tenant context and returned validation errors. Native
forms use the base `Form` with `preventDefault={false}`. Enhancement is optional;
a handler that takes over submission is responsible for preventing navigation.

A failed action returns the submitted strings, including invalid amounts and
repeated fields, alongside errors. Components must not reconstruct these values
from saved models or generate a replacement request token. Unknown commit outcomes
retain the same identity and payload until the application resolves the result.
File inputs cannot be repopulated after navigation: explain that the file must be
selected again and retain the caller's recovery identity.

The existing [form retry contract](../../../docs/content/form-retry.md) provides
optional browser enhancement. It does not replace server-side tenant/actor checks
or idempotency. Permission props control presentation only; applications must
supply already-authorized data and reauthorize every submitted action.

## Amounts and public compatibility

New commercial editors use explicitly documented integer minor-unit amounts.
Editable values remain strings until the owning server validates them; blank,
invalid and zero are distinct. Currency and its display precision are explicit.
Do not mix currencies in totals or infer an unknown allocation as zero.

The original invoice display DTOs in `src/svelte/types.ts` and their components
accept decimal major-unit amounts. Preserve that published behavior. Applications
adapting model amounts into those legacy components must explicitly convert units;
do not pass a model's integer amount directly or silently change a legacy prop's
meaning. New editor DTOs are separate contracts.

Approved or otherwise retained invoice facts use the explicit `retained` display
branches and DTOs from `src/svelte/invoice-display.ts`. Their amounts are safe
integers in currency minor units, formatted through the package ISO exponent
table without floating-point division. Retained line subtotals, discounts, tax
rows, holdbacks, totals, paid amounts and payable amounts are caller-authoritative;
the components never derive one from another, and an omitted fact stays omitted.
Application-specific evidence belongs in the typed detail snippets.

## Domain boundaries

Customer and Vendor reference Profiles identity data. A consumer's Client record
is not automatically a Commerce Customer; UI adoption performs no identity merge
or persistence migration. Domain-specific contact fields, trades, project/package
allocations and approval policies enter through typed adapters and extension slots.

Quote/estimate preparation, customer acceptance, vendor award, expense review and
invoice approval are separate decisions. A UI status or selection must never
implicitly perform another transition. The server supplies current decision and
source availability, including restricted-reader presentation.

## Backend capability assessment

Assessment baseline: SMRT `98c872be4` and reviewed DomaCraft epic-138
`b03b322f75fbfdcb9193b18e73d3ec818ef18811`.

| Responsibility | Existing capability | Release decision |
| --- | --- | --- |
| Commitment versus actual | `ExpenseCollection.commitmentPosition()` sums reviewed, non-duplicate expenses in the commitment currency, optionally per line. | Reuse Expenses; keep DomaCraft award lineage and package-cap constraints in its adapter. |
| Receipt identity and duplicate review | `ExpenseReceiptCollection` owns receipt joins and duplicate detection; `Expense` owns guarded review transitions. | Reuse these contracts. Private upload authorization, draft capacity and storage compensation stay in application composition. |
| Idempotent submission and uncertain outcomes | Core `runOnce()` and UI `createFormRetry()` provide shared server/browser primitives. | Preserve the caller's request identity. Do not replace DomaCraft's transaction-bound financial submission logic without proving equivalent transaction and recovery semantics. |
| Invoice source reservations | DomaCraft `finance.ts` reserves its own cost allocations under project transaction locks; Commerce Invoice has no equivalent source-allocation contract. | Keep the reservation service local: extracting it changes a published financial contract and requires an agreed cross-domain source model. UI accepts supplied source availability. |
| Source-change approval invalidation | DomaCraft `withdrawInvoiceApprovalForSource()` and invoice fingerprint checks bind project policy, actor decisions and retained sources. | Keep this policy local. Shared presentation renders server-supplied approval state and cannot authorize execution. |

No generic backend redesign is required by these UI slices. A future extraction
needs evidence that a contract works beyond the application-specific project and
policy model; UI reuse alone does not establish that requirement.

## Validation and consumer adoption

Each slice covers its public exports, SSR/native payload, retained errors,
read-only and empty states, keyboard operation and a 390px viewport. The release
also validates the complete touched packages and integrated workbench. A browser
viewport test does not establish physical-device camera behavior.

DomaCraft adopts a published release through normal dependency admission. Its
native financial, authorization, tenant and uncertain-outcome tests remain required;
shared component tests do not establish those server-side properties.
