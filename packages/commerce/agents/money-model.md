# Commercial money model

This guide names the public commerce money contract. The exact input and result
shapes, validation codes, and worked calculator examples live in the
[calculator guide](money-calculator.md) and
[package documentation](../../../docs/content/commerce-money.md). Money values
are signed safe-integer minor units; calculator tax percentages are exact text,
so `'5'` means 5%. The retained `InvoiceLineItem.taxRate` and
`ContractLineItem.taxRate` fields are different legacy persisted fractions:
`0.05` means 5%.

## Calculation contract

`calculateMoneyDocument()` accepts `exclusive`, `inclusive`, and `none` line
amount modes. It first computes quantity times unit price, applies the one
chosen discount, and returns the post-discount amount, tax components, net, and
line total. `exclusive` line amounts are tax-exclusive net; `inclusive` line
amounts are the visible gross and derive net by removing tax; `none` has zero
tax and requires an out-of-scope code. `subtotalMinor`, `taxMinor`, and
`totalMinor` are document totals. `discountTotalMinor` is informational because
the line discounts were already applied; consumers must not subtract it again.

The `line` rounding scope rounds each line/component. The `document` scope
rounds each shared component's exact total, truncates each allocation toward
zero, and gives signed residual minor units to the largest remainders, with
line-ID code-unit order breaking ties. It leaves no document residual. Across
`n` small lines, the two scopes can differ by up to `ceil(n / 2)` minor units
per component. Store the chosen scope; do not silently substitute a later
setting. `MoneyValidationError.code` is the public branch point for invalid
money, discounts, tax-code state and scope, unsupported compound tax, frozen
records, and unsafe values.

Tax-code resolution is pure once the caller has loaded authorized codes. It
uses a line override, customer exemption, product code, customer code, and app
default in that order. An unresolved exclusive or inclusive line is a genuine
zero-tax, null-code case; it is not an out-of-scope inference. The tax-code
catalogue, seeds, registrations, and cookbook boundary are documented in
[tax codes](tax-codes.md).

## Stored Invoice facts

`TaxSettings.moneyModel` selects the Invoice write behavior. New tenants with
no documents start on `v2` ([initial model](document-money.md#initial-model-4009));
`legacy` keeps the compatibility path; `migrating` rejects money writes; `v2` resolves a draft's
current settings once and atomically writes the header, line snapshots, and
`DocumentTax` rows. The detailed persistence, freeze, preview, credit-note, and
refund contracts are in [document money](document-money.md).

Once an Invoice leaves `DRAFT`, or receives an AR journal, its money snapshot
is frozen. Reads use those stored values and must not recompute issued tax from
new defaults. `DocumentTax` is a derived, read-only per-document/code/component
snapshot with currency, code and component identities and labels, kind, exact
percent, liability account, taxable, tax, and recoverable minor-unit values.
It also represents non-taxable and unassigned zero-tax rows so reporting does
not invent a taxable component.

A credit note is an `Invoice` with `kind: 'credit_note'`. It stores positive
amounts; posting, reporting, and accounting adapters apply that direction once.
Issued-credit capacity and refunds are stable Invoice-v2 behavior. A refund is
a positive `Payment` of kind `refund`, allocated only to a credit note. See
[document money](document-money.md) before presenting either balance as an
ordinary incoming payment.

## Invoice MCP `get` projection

The standard Invoice MCP `get` tool uses `serializeInvoiceMcpGet`. For a
legacy tenant, or when tenant settings are absent, it returns the ordinary
public Invoice projection and omits the `money` alias. For a v2 tenant, the
optional `money` value is the stored `InvoiceMoneyFacts` projection: its
header, line snapshots, and `DocumentTax` facts are read from the issued
snapshot and are never recalculated.

A tenant in the `migrating` gate refuses this read with the stable
`FROZEN_DOCUMENT` code and the public message `Tenant money migration is in
progress`. If the caller's `PublicJsonOptions` hide any Invoice,
`InvoiceLineItem`, or `DocumentTax` field needed by the money projection, the
serializer returns the base Invoice and omits the entire `money` alias. It does
not expose restricted values through a partial plain-object alias.

This applies only to standard MCP `get`. Invoice list and MCP write behavior
remain their existing public contracts. The general serializer configuration,
authorization order, and projection rule are in [core MCP get
serializers](../../core/agents/generators.md#mcp-get-serializers).

## Reporting and integrations

The materialized `TaxSummaryReport` and its public descriptor/drilldown bridge
read stored Invoice `DocumentTax` facts under the tenant v2 gate. See
[tax summary aggregation](tax-summary.md). Commerce exports
`createTaxSummaryMaterializedReportHost()` for an application-owned,
server-only host; register that host in the app's fixed report-host registry to
opt into the generic `MaterializedReportTable` and its tenant-scoped drilldown
route. The host binds the authenticated tenant, principal, and
`taxsummaryreports.read` permission; browser input supplies only a row id
and visible column id.

The accounting snapshot mapper consumes frozen facts and never re-calculates a
rate or allocation. It maps an inclusive line to the accounting SDK's
`TaxInclusiveAmt`; tenant mappings provide provider tax-code and component-rate
identities. The QuickBooks sync boundary persists SDK 0.103.7 invoice or credit
memo request descriptors before provider I/O, refuses competing writes, and
requires explicit reconciliation after an unknown outcome. Its supported
inputs and recovery contract are documented in [accounting snapshot
mapper](accounting-snapshot-mapper.md).

## Deliberate boundaries

The tenant migration and rollback contract is documented in
[tenant line-amount migration](line-amount-migration.md).
The marker is a maintenance gate, not a customer-controlled setting. Contract
money persistence remains a separate aggregate contract; production report
hosting is an application opt-in over the public host described above. The
model also does not provide currency conversion, cash-basis/deposit accounting,
partial recoverability, period locking, or compound tax.
