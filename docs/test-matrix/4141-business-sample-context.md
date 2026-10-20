# Business sample context — #4141

Standard risk: browser demo vocabulary and host wire extension, with no database or cookbook contract change.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime | Contract edge | Level / command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Vocabulary suits any domain | Initial additive host build | Skateboard and laboratory product vocabulary | No keyword/domain fallback | Browser preview | Synchronous context install, no record mutation | Node26/browser | Bounded typed host sampleContext | Unit: planner vitest sample-context/core |
| Reject malformed context atomically | Host JSON parsing | Valid fictional names/minor-unit prices roundtrip | Unknown fields, noninteger prices, oversized arrays/text, nonfictional provenance | Untrusted host response | Parser returns no context; zero storage writes | Node26/browser | Optional field absent remains compatible | Unit: sample-context |
| Preserve manual records/retries | Repeated/followup host response | Initial vocabulary persists; existing edited row unchanged | Replacement context refused | Same origin planner demo | Source rows never rewritten; install once | Node26/browser | Retry no-op | Unit: sample-context/data |
| Reload/reset semantics | Record reload / explicit full data reset | Context restored before generator read | Explicit full reset clears context | Same origin demo, matching source scope | localStorage same origin as existing data v6; no database | Node26/browser | Unavailable/malformed storage tolerated | Unit: sample-context |
| Known library samples remain authoritative | Library cookbook activation | Bakery pack still bakery | Context never replaces known pack | Browser preview | Existing canonical reset semantics | Node26/browser | Cookbook remains unchanged | Unit: sample-context/sample-packs |

Run: `pnpm --filter @happyvertical/smrt-planner exec vitest run tests/sample-context.test.ts tests/sample-packs.test.ts tests/core.test.ts tests/data.test.ts`.

Context is fictional sample provenance, not verified business facts. It remains outside cookbook export. Existing generated/manual rows are deliberately preserved, so this capability tailors new table generation, not retroactive data conversion. Scope is the existing per-origin planner data scope; explicit source reset clears context. Transport installs only after all synchronous host commands succeed and before returning to reactive render. No promise/await exists between command execution and context installation.

## Canonical host prompt correction

The diagnostic model reply nested `sampleContext` under `add_recipes.input`, omitted product descriptions, and emitted object customer/vendor entries. The canonical host prompt previously exposed no sample-context descriptor while the site used JSON-object response mode. The host prompt now includes the exact top-level sibling shape, mandatory fictional provenance, product fields/price units, string-array party fields and schema-derived bounds. It recommends modest initial samples and omission on followups. Focused core tests reject the captured bad shape, accept its corrected sibling form, and verify the same domain-neutral descriptor for skateboard and laboratory businesses. Diagnostic source: `/Users/will/.codex/planner-recovery-2026-10-19/skateboard-qa/model-reply-diagnostic.json`.

## Initial assortment diversity and descriptor count

Initial custom vocabulary now requests 5–6 representative fictional products across core goods, replacement parts/accessories and related merchandise/apparel where appropriate, without a business keyword branch. Contextual packs set the existing Product row-count override to the supplied descriptor count; each supplied descriptor appears once instead of cycling to the generic default eight rows. Default and known-library packs retain their counts. Regression covers five unique contextual names/categories, reload of persisted visitor edits, ignored followup vocabulary, and explicit reset restoring the ordinary eight-row default. No existing table is regenerated or rewritten.

## Initial product-backed context requirement

A real post-reset laboratory request composed the correct recipes but omitted optional sampleContext, producing generic products. This is an inference-quality omission, not storage/reset leakage. Canonical host wording now conditionally requires the top-level context for an initial custom product-backed app on an empty project, while omitting it for questions, no-ops, followups and library cookbooks with canonical packs. Non-product apps must not fabricate product assortments. Wire optionality and preservation semantics remain unchanged. No admission, API, validation-retry or budget changes were introduced. Targeted core prompt assertions cover the condition/exceptions; existing sample-context tests cover preservation.
