# Pricing version presentation

Import `PricingVersionSummary`, `PricingVersionDecision` and
`QuoteRevisionComparison` from `@happyvertical/smrt-commerce/svelte`.
`PricingVersionData` extends `QuoteRevision`: use the same explicit document kind,
counterparty, currency, minor-unit scale and integer total. Optional `sources`
retain authorized source labels, amounts and explanations in that currency.
Compare versions with `QuoteRevisionComparison`; no second comparison algorithm
or pricing ledger is introduced.

`PricingVersionDecision` accepts an immutable `version`, native POST `action`,
explicit `actions` (label/name/value and optional formAction/disabled), ordered
`hiddenFields`, and retained `reason`/`error`. Pass every server-required version,
fingerprint, request and tenant field through `hiddenFields`; displaying a version
never creates or replaces those identities. Repeated hidden names remain repeated
form entries. `reasonName` adapts to existing endpoints and `children` composes
additional native fields. Native submission is the default; `onsubmit` can opt
into enhancement. `readOnly` removes mutation controls; `busy` disables actions.
Neither prop replaces authorization or server-side fingerprint checks.

Applications must return current version/action availability with failed-action
values and preserve the same request identity after an uncertain outcome. A
source-change conflict requires fresh server review; this component never
approves, awards work, accepts a budget, or changes a saved status on its own.

The Commerce workbench pricing example composes comparison and decision controls
and demonstrates value retention on a rejected preview action. Its actions are
explicitly demonstrations and perform no financial writes.
