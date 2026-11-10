# Issue 4517 design and test contract

Risk high: new schema (two append-only tables), a public extraction contract, and
idempotent question writes from model output. Named triggers: persistence with
retry/replay semantics, and tenancy on matched revisions. Design and the host
flow are in [question extraction](../../packages/education/agents/question-extraction.md).

The work is in `packages/education`, which already depends on ingestion. It adds
an education handler to the ingestion catalog and a service over
`QuestionAuthoringService`. Ingestion's generic extraction and proposal contracts
are unchanged.

| behavior | trigger | positive | failure | actor/context | executor | dialect | external edge | level | command |
|---|---|---|---|---|---|---|---|---|---|
| closed extraction contract | proposal args / direct preserve | valid shape normalizes; schema objects closed | extra fields, bad version/kind/worksheet id, NUL text, duplicate keys refused | N/A pure | none | N/A pure | unknown enum, malformed input, missing required | unit | `pnpm --filter @happyvertical/smrt-education test` (`validation`) |
| evidence grounding, no invented coordinates | anchors cite evidence/page/region | rect copied from observedRegions catalog; null without region | unknown evidence, unreported page, unknown region, region on PDF refused | N/A pure | none | N/A pure | provider omitted catalog | unit | same (`validation`) |
| partial results visible | unreadable page or task | every source page has a `pages` entry; unreadable items kept with null prompt; omissions kept | uncovered page refused; prompt/status mismatch refused | N/A pure | none | N/A pure | partial extraction | unit | same (`validation`) |
| printed vs learner work | scan with handwriting | studentWork separate; illegible stays null | transcription on illegible refused; work naming unknown question refused | N/A pure | none | N/A pure | N/A | unit | same (`validation`, `known worksheet`) |
| supplied vs inferred | key/type/points origin | `extracted` vs `inferred` field provenance on the created revision | empty key refused; points without origin refused | guardian | apply transaction | SQLite | N/A | integration | same (`apply`) |
| partial ingestion output visible | truncated result, omitted/failed pages, original with no result | sources kept; uncovered omitted pages and missing originals added as `unreadable` + `not_extracted`; warnings carried to view and preview | extracted page left out still refused; invalid warning code refused; over 1000 pages refused | guardian | preserve | SQLite | upstream truncation, missing result | unit + integration | same (`partial sources`, `ingestion`) |
| source identity | re-ingest same bytes | identity from kind + sorted hashes, independent of evidence ids/attempt | changed hash or kind changes identity | N/A pure | none | N/A pure | N/A | unit | same (`identity`) |
| evidence-only matching | scan of a known worksheet | id + printed position match whatever the OCR text | no id, unknown id, layout conflict, inferred type ignored, duplicate position (including against a conflicting claimant), id vs expected conflict, example: all unattached | N/A pure | none | N/A pure | N/A | unit | same (`matching`) |
| known worksheet via printable | generated printable scanned | `resolveWorksheet` finds it; matched links existing revisions; student work attached only to matched | ambiguous left `needs_review`; no new question rows | guardian | read then preserve transaction | SQLite | N/A | integration | same (`known worksheet`) |
| foreign matched revisions | host supplies worksheets | own tenant revisions accepted | foreign/unknown revision refused, nothing recorded | guardian | preserve transaction | SQLite | host input | integration | same (`known worksheet`) |
| preserve idempotency | retry preserve | same attempt replays one row | different payload, grounding or expected worksheet for the same attempt is `CourseRequestKeyConflictError` | guardian | preserve transaction, unique index replay | SQLite | N/A | integration | same (`preserve`) |
| apply idempotency, no multiplication | retry apply; re-run pipeline on same bytes | stored outcomes replay; `replayed` reuses question ids; repeated prompts under distinct keys stay distinct | changed content for the same source is `source_changed`, no overwrite, no new revision | guardian | one apply transaction; createQuestion nested (savepoint) | SQLite | N/A | integration | same (`apply`, `idempotency`) |
| new scan is a new source | rescan with new bytes | unknown sheet creates new records; known sheet links by match only | N/A | guardian | apply transaction | SQLite | N/A | integration | same (`idempotency`, `known worksheet`) |
| authorization and tenancy | reader / foreign / spoofed context | author preserves/applies; read-draft reads | read-only actor denied writes; foreign tenant gets not-found; actor not matching tenant context denied | guardian, read-only member, other family, context spoof | executor-bound authorizer | SQLite | N/A | integration | same (`authorization`) |
| ingestion handler | catalog validate/preview/apply | preview summarises the preserved extraction; apply on the ingestion transaction creates records | unpreserved payload refused; foreign scope refused | guardian scope | `context.db` transaction | SQLite | N/A | integration | same (`ingestion`) |
| preserve bridge | completed analysis | extractor identity and grounding (regions) recorded | not interpret stage / analysis unavailable → pending; no proposal; competing or ambiguous → ambiguous; missing fields → validation | guardian | read via ingestion | SQLite | upstream not ready, malformed generation | integration | same (`ingestion`) |

PostgreSQL: the service uses only collection inserts and `tx.get`/`tx.list`.
The nested `createQuestion` unit becomes a savepoint on the PostgreSQL adapter.
A PostgreSQL run needs the containerized `test:postgres` lane, which this
change's in-process validation does not start. That lane is not a required CI
gate; the row is recorded as SQLite-only evidence.

Not covered here: live provider recognition quality. Synthetic fixtures prove
the contract, not OCR or vision accuracy on real worksheets.
