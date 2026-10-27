# #4412 identity-independent marking

Architecture: external session `4412-design.md`; claim6432649533, base63e7948.
Local only, no push/PR/deploy. Root owns integrated gates/review and real-photo quality.

| Risk/behavior | Required proof |
| --- | --- |
| Visible completed work without title/lesson | Confident work captures one unfiled activity/attempt/submission on original receipt, assessment and feedback persist with no Workbook or canonical lesson identity |
| Material safety | Cover/reference/answer key/blank/uncertain classification creates no assessment; uncertain visible answers remain unassessed; printed solved examples are not learner responses |
| Source quality | Actual sent vision prompt distinguishes printed/handwritten marks and visible line endpoints, refuses inferred answers and retains untrusted-content boundary; root verifies real quality privately |
| Idempotency | Stable receipt capture retries, concurrent capture, changed request rejection; repeated preservation adds no attempt/revision; correction requires explicit current predecessor |
| Filing | Guardian appends real workbook/optional lesson association, exact expected head; unchanged request replays; conflicts/stale head deny; original activity/submission/attempt/revision/release/source IDs and review policy unchanged |
| Security | Cross tenant/learner, revoked actor, hidden guardian-origin receipt and guessed IDs deny; no captured principal widening; current executor authorization for every operation |
| Visibility | Guardian upload originals/AI/Grade withheld from child until exact release, child-owned source existing policy unchanged; filing cannot release or borrow another attempt's release |
| History/overview | Authorized unfiled work appears in normal bounded activity list; exact receipt timeline works beyond display cap; partial marks, guardian review/release and correction remain visible under existing policy |
| Schema/compatibility | New nullable workbook FK valid only on receipt-bound explicit unfiled kind; old identified ownership and immutable identity preserved; manifest pins persisted columns; SQLite/Postgres migration and workflow proof, no runtime DDL |
| Failure/rollback | Failed file/capture/assessment leaves originals and old immutable rows unchanged, no partial association, no orphan private asset writes |

Workers run focused SQLite/provider contract tests with red-before/green-after proof,
source/test TypeScript and relevant package build. Root owns PostgreSQL/full gates,
independent high-risk review and retrying both retained real uploads.

## Worker evidence

- Initial focused new work case on old source: red (invalid photo identification).
- Affected education SQLite workflows: 48 passed across photo intake/manifest,
  unfiled core, existing workbook, ingestion bridge/integration/isolation suites.
- Generic vision actual-request contract: 8 passed; no remote quality claim.
- Source TypeScript plus focused test TypeScript: pass. The package has no canonical
  test tsconfig; external focused config includes the changed photo/unfiled tests
  and imported helpers. Exploratory all-test inclusion found unrelated existing
  catalog/provider fixture errors; these are retained in evidence, not fixed here.
- Core/CLI/ingestion/education builds and graph refresh: pass; core #4413 owns
  migration unit/CLI proof separately. Root owns full installed upgrade/re-diff,
  supported PostgreSQL lanes and integrated validation/review.
- Durable evidence and exact command/exit metadata: external session evidence/4412.
