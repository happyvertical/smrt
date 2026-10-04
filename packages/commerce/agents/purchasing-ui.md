# Purchasing and award presentation

Public `@happyvertical/smrt-commerce/svelte` exports `PurchaseSourceSelector`,
`PurchaseOrderEditor`, their Props and `Purchase*` DTOs. Registry slots are
`purchase-source-selector` and `purchase-order-editor`. Interactive playground
entries cover ordinary amendment and explicit retained-allocation reduction.

These components use public Commerce PurchaseOrder/Contract as their owning
financial domain without adding a backend command, ledger or fixed approval
policy. The caller decides instrument options, source availability, allocation
labels, prior commitments, reviewed actuals, floors/ceilings and exact source
identity. Construction work packages, accepted budgets, contractor entitlement
and vendor award policy stay in the consumer. Capability/disabled props only
control presentation. Every POST needs authoritative server authorization.

`PurchaseSourceSelector` uses a native GET to the supplied action with `name`
(default `source`) and optional hidden search/context fields. It never writes an
award. Disabled sources remain visible with caller notices; unknown saved IDs
remain visible as unavailable. Keep source selection outside a reduction form;
the server must reject a downward amendment under an ordinary amendment mode
and enforce the retained source/instrument during reductions.

`PurchaseOrderEditor` receives `operation` (`create`, `amend`, `reduce`), a
retained `source`, `currency`, explicit `minorUnitDigits`, raw `values`,
`instruments`, native POST `action`, and caller-owned `hiddenFields`. Supply
source ID, currency, predecessor, tenant and retry IDs in those hidden fields
under the exact names your endpoint expects. `names` adapts all built-in fields.
`labels` adapts approval language; `extensions` and `attachments` compose domain
fields and authorized Assets evidence without fetching bytes in this component.
`formAttributes` supports native encoding/ID and caller-owned form-retry Svelte
attachments; `onsubmit` supports caller transport enhancement. Tokens are never
minted or rotated here. See the shared [form/action contract](commercial-ui.md)
and repository `docs/content/form-retry.md`.

All editable money is **raw major-unit text**, including malformed values and
empty unknown amounts. The caller parses against the exact currency contract;
there is no UI floating-point calculation or implicit blank-to-zero conversion.
Saved/source/review numbers are safe integer minor units formatted by the
shared quotation helper. `sourceMinor: null` renders Unknown. Displayed bounds
are guidance; the server validates floors, ceilings and source eligibility.

Every allocation posts its stable `id` and amount, even when zero. Mark every
predecessor allocation `retained: true`. A `reduce` form requires those amounts
explicitly and never offers their removal. Supplying fewer predecessor rows is
not safe: the server must compare the complete ID set and reject omissions.
Optional `rowActions` uses native formnovalidate add/remove POSTs carrying all
current fields; the caller re-renders unchanged rejected strings and IDs.
New-row IDs belong to the caller. Row editing never records a commitment.

Pressing Enter in an input activates review or record, preserving draft rows.
Explicit add/remove actions remain available without JavaScript.
Default submitter `intent` values are `review`, `record`, `edit`, all configurable.
Only a caller-produced `review` snapshot or a retained `retryFingerprint` exposes
explicit confirmation. `review.fingerprint` posts under `reviewFingerprint` by
default. After an uncertain outcome, re-render the exact submitted values,
request identity and fingerprint; never fabricate a new intent/token. Confirmation
is an unchecked required checkbox on native renders and when a new review
fingerprint arrives in a hydrated form. Its value defaults to
`yes`. The server must bind fingerprint to all submitted values and authority,
reject changed/stale review data, and replay identical committed retries.
Rendering a review snapshot or selecting a source never accepts/records anything.

Validation: `pnpm --filter @happyvertical/smrt-commerce exec vitest run --config
vitest.purchasing.config.ts`, owning build/typecheck/pack checks, and the shared
quote native/hydrated browser harness with `QUOTE_BROWSER_EXTENSION` pointing at
`packages/commerce/test-support/purchasing-browser-extension.mjs`. Full repository
CI/E2E is consolidated at the #3423 release boundary by owner instruction.

Invalid or unsafe display amounts/scales render localized unavailable text.
Strict money helpers continue to reject malformed data; presentation recovery
does not validate or authorize submitted money.
