# #3673 proposal behavior contract

Risk: high. Named trigger: permission-filtered catalog/candidate disclosure and
untrusted generative output at the proposal boundary. Execution authority stays
with the existing execution service; generation never approves or applies.

Initial temporary stack: `87a8e2c5ab130dc8a8232cf44977cdd00825e9c3`; advanced
without conflicts to execution `97c976f6766017e079bc813d59430f1ab8c0f356` before
first validation.
Reviewed source `443c3758950ab0b4fa8131053791d49c8f9391d8` (on merged SDK
alignment `b221a72`) and JSON extraction `1dbf52239aeed451cafecb067cc5b71c5d8d0336`
are integrated in temporary baseline `83afaab5e037acab50c95ac27b249cdbc1bc0e3e`.
Their owned feature paths were compared and are identical at that baseline.
Final publication requires rebasing onto the actual merged dependencies.

The composed reference passes on SQLite and ordinary PostgreSQL: real multipart
upload, actual packaged unpdf child, durable interpretation, two-step Content draft
and attachment plan, explicit authenticated approvals, repeated delivery/execution,
tenant denial and retained original bytes. Generative responses are deterministic
fixtures; the separate actual AI SDK HTTP lane proves transport contracts only.
The email composition uses a declared messages-owner snapshot fixture.

| Behavior / invariant | Reachable trigger | Positive | Negative / failure | Actor / context | Executor / transaction | Runtime / dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| One application catalog | Discover enabled semantic handlers | Same evidence routes differently for two apps | Undeclared operation, stale handler version, duplicate identity | Current actor × tenant × confidential scope | Owning execution authorization boundary | Node; SQLite/PostgreSQL | Public registry and OperationHandler/PlanHandler | Integration | `pnpm --filter @happyvertical/smrt-ingestion test`; `pnpm --filter @happyvertical/smrt-ingestion test:postgres` |
| Filter before disclosure | Catalog/candidate/model request | Authorized bounded candidates only | Hidden/foreign/revoked records; no hidden counts; oversized/truncated candidate results | Same plus captured authority ceiling | Trusted candidate callback uses authorized executor; no provider I/O in transaction | Node; SQLite/PostgreSQL | Public domain collections | Integration | Same package/PG commands |
| Immutable source revision | Generate from completed extraction | Exact attempt/output/input hashes and evidence granularity | Stale/reprocessed/cancelled/expired/forged output | Processing grant rechecked before every downstream boundary; final completed read shares current-attempt lock/executor with owner visibility | Service-owned reader validates persisted snapshot; retention intent wrapper encloses outer rollback | Node; SQLite/PostgreSQL | Foundation/extraction APIs | Integration | Same package/PG commands |
| Optional typed decisions | Predicate/choice/score batch routing configured | Existing core `executeDecision`; separate probability/provenance | Unconfigured remains explicit; configured capability/provider/malformed errors do not silently fall back | Trusted host provider configuration | N/A: provider call outside transaction | Node | Existing AI SDK typed decisions | Contract + local adapter | `pnpm --filter @happyvertical/smrt-ingestion test:providers`; package suite |
| Hostile generative output | Model returns structured suggestions | Offered handler/schema/candidate/evidence validated | Invented handler/target/enum, extra authority/tool fields, document instructions, oversized output; missing/invalid custom completion denied; SDK-normalized completion explicitly unknown | Input is evidence only | No domain mutation before or during validation | Node; both DB service tests | Existing generative AI SDK | Contract/integration | Package/provider/PG commands |
| Abstention and uncertainty | No eligible handler, tie, missing fields, low-quality evidence | Unresolved/review-required with explicit alternatives/missing fields | No forced destination; unknown confidence stays unknown; provider failure creates no domain effect | Same current caller | Safe categorized result/provenance; no approval | Node; SQLite/PostgreSQL | Extraction capabilities and decision result | Integration | Package/PG commands |
| Completion capability | SDK normalizes stop or trusted adapter reports completion | Explicit unknown warning still permits authorized human preview | Missing/invalid custom completion, known truncation/tool calls rejected; never automation | Trusted adapter identity; untrusted model output | Result stored through live lease | Node; SQLite/PostgreSQL | Actual AI SDK local HTTP stop/missing/unknown responses; SDK issue #1381 | Adapter + service integration | Package/provider/PG commands |
| Compound evidence | Email attachments or multi-document scan | Multiple independently reviewable suggestions; observed-source logical splits | Cross-source/made-up pages/timestamps; overlapping or unsupported split | Current evidence visibility | Original evidence stays immutable | Node; SQLite/PostgreSQL | Public split and preview APIs | Integration | Package/PG commands |
| Preview and replay | Host publishes validated suggestions | Existing operation/plan previews; exact versions and stable intentions | Stale source/catalog/candidate revision; persisted labels denied after owner grants revoked; replay/conflict; duplicate indexes with distinct intentions reject the entire batch before any action/plan/proposal/domain write; no duplicate effect | Host-selected intentions, human reviewer and current executor remain distinct | Existing preview transaction and business execution transaction | Node; SQLite/PostgreSQL | #3674 catalog/preview/apply | Integration | Package/PG commands |
| Real reference composition | Uploaded valid PDF → extraction → generation → human approval | Actual ContentDocument draft plus retained-evidence attachment | Crash/retry, tenant denial and revoked target; original remains readable | Two tenants and confidential scopes; explicit human approval | Public Contents APIs share execution transaction | Node; SQLite/PostgreSQL | #3671 source + real PDF SDK + #3674 reference handlers | End-to-end service integration | Package/provider/PG commands |
| Public package boundary | Build and packed consumer | Server-only proposal APIs and browser-safe DTO types | No principal/provider stack from browser entry; no eager execution import from server | N/A: package consumer | N/A: no database mutation | Node / browser compile | Package exports | Build + isolated consumer | `pnpm build`; package `typecheck`; packed consumer proof |

Feature baseline comparison is N/A: no proposal-generation implementation exists
at the stack base. Deterministic injected provider responses establish validation
contracts, not routing accuracy. No held-out evaluation or automatic action
eligibility is claimed. UI, learning, and moderation are outside this change.

Round 2 decision regressions cover full serialized UTF-8 request size exactly at
and one byte above the current policy ceiling, policy shrink after generation and
after capability probing, and non-tied selected-handler confidence below or
exactly at the configured threshold. Both SQLite and PostgreSQL exercise actual
service authorization/persistence; denied outbound boundaries and denied preview
are asserted separately. The new overflow and low-route cases fail against the
reviewed implementation before the fixes; complete affected proposal suites and
the provider lane supply the corrected evidence.
