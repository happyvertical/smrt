# Quotation and estimate presentation

Import `QuoteEditor`, `QuoteRevisionHistory`, `QuoteRevisionComparison` and their
Props/DTOs from `@happyvertical/smrt-commerce/svelte`. Registry slots are
`quote-editor`, `quote-revision-history`, and `quote-revision-comparison`.
Commerce playground has interactive vendor quotation and customer estimate demos.

`kind: 'vendor-quotation'` means received supplier evidence;
`kind: 'customer-estimate'` means pricing proposed to a customer. Neither widget
selects pricing, accepts budgets, awards work, sends messages or mutates a model.
Adapt public Commerce Estimate/Contract fields (`currency`, `totalAmount`,
`status`, `customerId`/`vendorId`) to these presentation DTOs;
construction package allocation and approval policy remain caller extensions.
Client records need not become Commerce Customers.

`QuoteRevision.total.amountMinor` is a safe integer or null (unknown), with an
explicit `minorUnitDigits` from the owning currency/asset contract. No locale
inference, monetary rounding or unknown-as-zero comparison occurs. Different
kinds/currencies/scales cannot produce a delta. Existing invoice `LineItem`
major-unit props retain their established contract. Form money values are raw
**major-unit strings**: the caller validates and converts before saving; invalid
strings remain visible after failed actions. Dates likewise remain text to avoid
native date inputs silently clearing rejected server values.

Supply `values`, authorized `counterparties`, `action`, optional `method`,
`hiddenFields` (name/value pairs), `errors` and `message`. `names` maps payload
names to an existing endpoint. `labels.counterparty = 'Client'` supports local
terminology. `extensions` composes pricing-source/allocation fields;
`attachments` composes private Assets controls without loading bytes here.
`QuoteRevisionHistory.evidence(revision)` composes authorized document links.
All fixed component text uses the shared i18n catalog; data/status/date labels
come from the caller.

Rows submit repeated `lineId`, `lineDescription`, `lineQuantity`, `lineUnitRate`.
Default submitter `intent` is `save`, `addLine`, or `removeLine:<stable-id>`;
override via `intents`. Add/remove are ordinary `formnovalidate` POSTs, including
all current strings and hidden tokens even without JavaScript. The action must
read all repeated fields, preserve row IDs, and re-render them; add/remove are
form-edit operations, not financial writes. Never treat an add-row POST as a save.

The editor does not generate or rotate submission tokens. Caller-owned
`@happyvertical/smrt-ui/form-retry` can be attached via `formAttributes` using
Svelte's `createAttachmentKey()` and `retry.attach`; caller transport enhancement
may use `onsubmit`. Use the same server-owned hidden identity when retrying an
uncertain commit. Never blindly reset after a response. The caller must preserve
hidden tenant/request/predecessor values, validate authorization on every action,
and enforce idempotency transactionally. See `docs/content/form-retry.md`.
`readonly`/`busy` only disable the presented fields; these props are not security.

Validation: `pnpm --filter @happyvertical/smrt-commerce exec vitest run --config vitest.quotes.config.ts`,
`node packages/commerce/test-support/quote-browser.mjs`, package typecheck/build.
The browser harness executes actual SSR POST recovery with JavaScript disabled
and hydrated demo interactions at 390px. Full release CI/E2E runs at #3423's
consolidated release boundary by explicit owner instruction.

On NixOS, the browser lane accepts the repository-standard
`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/run/current-system/sw/bin/chromium`.
Set `QUOTE_EVIDENCE_DIR` and `CI_TEST_TMPDIR` to an owned evidence directory outside
`/tmp`. Other commercial tests may reuse its host via
`QUOTE_BROWSER_EXTENSION=/absolute/fixture.mjs`: export `handleRequest(req, res,
{vite, render, css, requests})` returning true when handled, and
`run({browser, baseUrl, evidence, requests})` for additional assertions.

Invalid or unsafe display amounts/scales render localized unavailable text.
Strict money helpers continue to reject malformed data; presentation recovery
does not validate or authorize submitted money.
