# Tax codes

`TaxComponent` owns an immutable percent and optional liability account. To
change a rate, archive the old component, create a replacement and update the
editable `TaxCode.components` list. Never edit a used component's percent.

Every tenant seeds `exempt`, `zero-rated`, `out-of-scope`, and
`legacy-unreconciled`. Those kinds have no components because they report
differently. A legacy zero rate means out-of-scope unless the linked customer
was explicitly exempt; malformed or out-of-range legacy rates stay visible
through `legacy-unreconciled` and the mapping report.

`TaxSettings` owns tenant defaults, tax registrations, default line amount type
and rounding scope. Cookbook policies adapt the portable settings document;
they do not replace persisted tax settings. The per-tenant migration marker is
owned by the money-snapshot migration.

`applyCookbookTaxSettings(db, tenantId, input)` is the commerce-owned adapter
for core's portable `taxRate`, inclusion, and rounding settings. It creates or
reuses a component and default tax code, then updates tenant `TaxSettings`.

Example import data is intentionally jurisdiction-neutral: create components
such as `GST 5`, `PST BC 7`, `HST ON 13`, `VAT 20`, `AU GST 10`, or `NZ GST 15`,
then build one-component or combined codes from their IDs. Assign liability
accounts before posting a document that uses a component.
