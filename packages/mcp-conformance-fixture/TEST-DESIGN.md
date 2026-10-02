# Synthetic Iolaus conformance design (#3217)

Risk: high — cross-tenant workflow and approval integrity. The three PR #3327 boundary corrections require executable base-failure
comparisons against the original fixture at `8399fae9555c9197c7bd208aacab5d21ec89de43`.
Tests run unchanged in isolated fixture overlays with each affected source file
restored from that revision; current sources remain untouched. All test content is synthetic. Matrix rows run through `test:m8` unless
another owning gate is named. The same workflow function runs on file-backed
SQLite/local and real PostgreSQL/self-hosted, with a separate PostgreSQL worker
connection. No in-memory data provider substitutes for either dialect.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level / validation |
|---|---|---|---|---|---|---|---|---|
| Workflow parity | SDK tools/call over loopback HTTP | Browse, fit, decide, prepare, inspect immutable material | Unknown decision, hidden generated worker tool, decision after freeze | Two real users and owned tenants | Collections on reference runtime DB | Both | Exact SDK 2.0.0 / 2026-07-28 | Integration / test:m8 |
| Discovery and direct isolation | SDK catalog, direct tools/resources/task reads | Each owner lists only their rows; current resource readable | Foreign owner record/task guessing, unknown resource, anonymous HTTP, active tenant switch | Verified JWT subject plus live membership, row owner and tenant | Denied call preserves decision/materials | Both | Auth/JWKS adapter, public app-MCP policy | Integration / test:m8 |
| Durable continuation | task input_required, update and restarted worker | Matching owner resumes ordinary input | Other owner cannot answer; generic host confirmation leaves humanReviewOpened false | Persisted owner+tenant and fresh worker authorizer | McpTaskStore / TaskRunner | Both | Tasks extension, no domain approval from host input | Integration / test:m8 |
| Revocation and cancellation | Queued task, restart | Cancellation persisted; immutable materials unchanged | Revoked membership blocks HTTP and fails deferred execution | Same JWT, revoked live membership | Real membership write + worker public authorization callback | Both | Existing jobs APIs | Integration / test:m8 |
| Browser trust boundary | Sandboxed opaque iframe resource with immutable configured parent origin | Real Chromium bridge/tools/browse work with no referrer | Direct host DOM access and foreign/referrer-derived parent origin are denied | Opaque view; exact configured parent | Read-only bridge | Chromium / both DB profiles | Apps bridge, sandbox CSP | Integration / test:m8 |
| Dedicated review navigation | Actual iframe target=_blank anchor click | Owner human cookie opens configured review page with no opener/referrer | Anonymous 401, foreign human tenant 403; no materials disclosed; full raw domain row unchanged | Existing human sessions for Alice/Bob; absent session | Read-only authenticated review route; unchanged updated_at/reviewCount/humanReviewOpened, no submission | Chromium + SQLite and real PostgreSQL | allow-popups + allow-popups-to-escape-sandbox permit separate page; embedded origin remains opaque | Integration / test:m8; base3b8 blocked-popup RED |
| CAS review races and stale saves | Dedicated preview/apply against material row | Owner, tenant, digest and current revision atomically advance exactly once | SQL-triggered ownership, tenant or digest change at revision acquisition denies the final update; ordinary stale hydrated save rejects with RUNTIME_REVISION_CONFLICT | Explicit human owner/tenant | Transactional `UPDATE ... RETURNING` CAS | SQLite + real PostgreSQL | SQL executor, no mocked result | Integration / test:m8 |
| Human review integrity | Dedicated agents preview/apply API, absent from MCP catalog | Correct material digest and owner opens review | Fabricated host token, foreign actor, stale digest; concurrent and duplicate apply replay once | Explicit human domain context and active membership | SqlDataSurfaceActionStateStore atomic reservation, transaction-bound collection mutation | Both | Existing agents principal API, no employer operation | Integration / test:m8 |
| Review rollback and executor affinity | SQL trigger rejects final review write after revision claim | Fresh preview/retry opens once, preserves frozen revision/digest/materials | Entire raw row including updated_at restored after failed action | Authorized Alice and owned tenant; SQL trigger changes owner to Bob, tenant to Bob, or digest | Actual triggers run inside transaction; raw before/after proves claim rollback and transaction affinity | SQLite + real PostgreSQL | Public row failure details accepted=0/failed=1 (top-level ok is envelope acceptance) | Integration / test:m8 (`exerciseReviewAtomicity`) |
| Atomic rollback | DB trigger aborts reservation INSERT | Token remains unconsumed and reservation absent | Injected real DB failure after token update | Same review owner | Owning consumeTokenAndReserveIdempotency transaction | Both | N/A — local SQL failure | Integration / test:m8 |
| Unknown outcome | New state-store instance retries orphan reservation | Existing reservation retained | New worker cannot take ownership or blindly repeat | Existing reservation scope | Durable agents SQL state | Both | Synthetic unknown outcome, no external send | Integration / test:m8 |
| Declared UI + headless parity | Resource read then real Chromium iframe bridge | Exact prebuilt bundle browses and inspects via authenticated SDK; same structured materials | Public bridge's wrong-origin/capability/malformed/disposal cases remain its owning tests | Synthetic host peer, real browser and server authority | Read-only UI; N/A transaction | Chromium over both DB profiles | Apps 2026-01-26, static resource digest/CSP | Integration / test:m8; owning mcp-apps test + test:e2e |
| Optional native projection | Native entrypoint metadata, navigation helper | Authorized target returns identical headless materials | Foreign owner cannot resolve target | Same application principal | N/A — read-only adapter | Node / both | Owning OpenAI adapter; synthetic host only | Integration / test:m8; owning mcp-openai tests |
| Generated compatibility | Existing generated server fixture + copied #2547 runtime | SDK stdio negotiation, official suite, generated manifest migration | Existing task invalid envelope checks | Local generated fixture | Generated schema + task store | SQLite + native stdio | Pinned conformance CLI baseline | Integration / test |
| Self-hosted composition | Public deployed runtime with real PG | Real migration hook, SDK local assets write/read/delete, verified JWT/JWKS, protected synthetic file, runtime-owned worker | Unsafe secret mode and revoked membership fail readiness; closed runtime rejects workers | Two tenants, current membership | Separate PG worker connection, runtime shutdown | Self-hosted local execution | No public deployment or separate OS process claim | Integration / test:m8 |
| Operational cloud / real OpenAI host / real Iolaus | External operator acceptance | Requires actual credentials/platform/version/downstream run | Missing access stays an explicit gap | External operator | Actual managed provider adapters required | Managed cloud, real host | Cannot be substituted by config/mocks | External epic #3202, not claimed here |

The wrapper deliberately requires a PostgreSQL URL and fails before tests if
none exists. `test:m8` enables the browser branch; ordinary `test` remains a
portable SQLite/headless root gate. Full logs, toolchain versions and the exact
reviewed source revision accompany the review packet. No runtime tokens,
bootstrap invitations, employer records, screenshots or browser traces are
retained as artifacts.

`iolaus-resource.test.ts` rejects wildcard, opaque, path-bearing, credential-bearing
and non-loopback HTTP host configuration before building. Browser assertions run
with a real empty referrer, an ordinary foreign referrer, and an adversarial
referrer getters naming either the foreign or trusted host; none can replace configured authority.
The foreign host uses the same synthetic bridge responder, so accepted authority
would dispatch a real SDK tool. Positive review links remain on configured origin.
