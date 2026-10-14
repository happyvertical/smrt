# Tax codes

`TaxComponent` owns an immutable percent and optional liability account. To
change a rate, archive the old component, create a replacement and update the
editable `TaxCode.components` list. Never edit a used component's percent.

Every tenant seeds `exempt`, `zero-rated`, and `out-of-scope`. Those kinds have
no components because they report differently. A legacy zero rate means
out-of-scope unless the linked customer was explicitly exempt.

`TaxSettings` owns tenant defaults, tax registrations, default line amount type
and rounding scope. Cookbook policies adapt the portable settings document;
they do not replace persisted tax settings. The per-tenant migration marker is
owned by the money-snapshot migration.

Example import data is intentionally jurisdiction-neutral: create components
such as `GST 5`, `PST BC 7`, `HST ON 13`, `VAT 20`, `AU GST 10`, or `NZ GST 15`,
then build one-component or combined codes from their IDs. Assign liability
accounts before posting a document that uses a component.
