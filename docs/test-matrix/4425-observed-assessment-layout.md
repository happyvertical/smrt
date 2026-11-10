# #4425 observed layout and exact cover context

Claim/cycle6442109784, session train codex/hearth-upgrade-runtime, base97696e51.
Local publication hold; no push/PR/deploy. Root owns integration, PG provisioning,
provider calls, browser acceptance, review and original data. Workers use synthetic data.

## Contract

Assessment optional layout version1/provenance observed. Ordered sections have id,
optional label, columns, optional readingOrder rows|columns and retained source
assetId plus observed physical source page or null unknown. Placements reference
questionId/sectionId with zero-based row/column and optional answer-part order.
Multiple questions may share a cell; part ties use original question array order.
Missing readingOrder preserves original question order on a flattened surface.
No boxes/coordinates or source identity inferred from lesson/question IDs.

Bounded strict owning normalization discards only invalid optional layout, records
safe layoutOmission invalid and retains every valid answer. Old/no-layout records
remain unchanged. Wire sections cite original evidenceId; bridge maps to owned
retained assetId. Every placed question must anchor to the section source; observed
page bounds respect retained source capacity without becoming verified geometry.
Layout stays inside existing assessment/revision/source/privacy boundaries.

| Invariant/trigger | Positive | Failure/negative | Actor/executor/runtime | Contract/test command |
| --- | --- | --- | --- | --- |
| Vision retains visible structure | injected SDK request asks observed headings/sections/columns/rows/parts; no solves | unknown structure explicitly unknown, no verified boxes | disposable provider boundary; synthetic in-process | ingestion vision-images.test.ts |
| Optional layout normalization | two sections, multi-column, multipart samecell, source pages/unknown, reading orders | wrongtype/version, oversize, duplicate section/question, bad refs/out-of-bounds/foreign source drops metadata only | pure browser-safe owner normalizer; SQLite/PG owning writes | education layout tests |
| Generation to persistence | actual offered metadata carrier, evidence IDs map to exact retained source, current assessment history holds metadata | malformed metadata accepted as advisory then omitted; valid answers/strict marking survive | same actor/tenant/current executor; SQLite/PG | education layout workflow tests |
| Revisions/corrections | guardian copy keeps observed provenance; new capture accepts current layout with same IDs | old-capture asset metadata cannot leak into new capture; omission fallback | owned transaction with unchanged authority | education layout workflow tests |
| Privacy | guardian full history; exact source/revision release publishes layout | own learner cannot read hidden section labels/layout via timeline/raw write/ancestry | existing own/guardian/foreign/revoked context; SQLite/PG | existing privacy + layout workflow tests |
| Exact cover context | cover-only book ID from latest owned context decision; manual/automatic resolved cover | unresolved null, child hidden guardian cover, sibling/foreign deny; no attempts/Grade | same request/transaction/tenant; SQLite/PG | photo intake tests |
| Compatibility/idempotency | old records no layout; repeated preserve same revision; source hashes/history unchanged | invalid layout never replaces answers or rewrites old rows | additive JSON metadata, no DDL | focused source/test typecheck + package builds |

Named risk: additive model output/persistence metadata and source/private revision
ancestry. No new authority grants or auto release. Resource/transport budgets remain;
within a valid response envelope invalid optional layout cannot block marking.
Root actual provider/browser quality acceptance is separate from synthetic contracts.
