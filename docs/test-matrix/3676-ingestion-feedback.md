# #3676 feedback test design

High risk: confidential example disclosure and learned authority expansion. Existing
ledger only; schema migration N/A unless an explicit implementation need is found.
No paid providers. The table defines required coverage. Checkpoint execution is
recorded below; complete final release validation remains pending.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level/command |
|---|---|---|---|---|---|---|---|---|
| Explicit correctness | Revision-bound feedback callback | Exact current review records judgment | Forged reviewer/revision/hash, absent reviewer grant, invalid/oversize data | Authenticated human/current tenant+confidential scope | Scoped locked ingestion transaction | Node SQLite/PostgreSQL | Public service/UI callback | service `pnpm test`, `pnpm test:postgres`; components/e2e |
| Distinct signals | Authoritative decision/execution record consumption | Idempotent event identity and server provenance | Approval/run success is never correctness; outcome_unknown stays unknown | Current authorized owner | Existing immutable source record + feedback insert in one transaction | SQLite/PostgreSQL | Review/outcome owner records | service U/P |
| Supersession/replay | Repeated request or correction | Append and compare expected predecessor | Payload mismatch, double successor, stale source, rollback | Same scoped reviewer | Item lock and unique request ledger | SQLite/PostgreSQL | No private memory APIs | service U/P |
| Bounded retrieval | Later generation | Compatible positive/negative examples, deterministic ranking | Unrelated, revoked/deleted/expired/superseded, tenant or confidential denial | Receiving actor and each example's live owner | Bounded candidate query; current owner checks before disclosure | SQLite/PostgreSQL | Generator and decision input | service U/P + actual input assertions |
| Provider race/budget | Generation/probe/decision/publication/read | Examples fit fresh minimum policy/full serialized payload | Revocation, policy shrink or supersession during async boundary denies onward I/O/read | Worker live scope | Existing generation fences + feedback revalidation | Node U/P | Deterministic provider callbacks only | provider/service lanes |
| Rule suggestion/adoption | Repeated explicit judgments + human promotion | Bounded evidence/preview; authorized expected policy version | Suggestion cannot execute or alter permission/automation; stale version/denied grant fails | Separately authorized policy owner | Host same-executor versioned adoption + ingestion audit transaction | SQLite/PostgreSQL | Narrow routing-only host callback | U/P + browser |
| Retention | Delete/expire/revoke and delayed work | Ledger redaction, idempotent derived cleanup | No stale writer/cache resurrection; pending cleanup fails closed | Current item/privacy owner | Existing deletion/purgeDerived protocol | SQLite/PostgreSQL | Host-owned derived stores | U/P |
| UI | Explicit judgment, context change | Exact displayed binding; separate controls | Missing callback/denial clears content; approval/apply never labels | Browser authenticated host | Server authority, no client permission inference | Chromium/mobile | Maintained reference host | components, typecheck, test:e2e |
| Held-out influence | Frozen paired protocol | Comparable unseen case improves with authorized training correction | Duplicate/ID/answer leakage, unrelated or inaccessible influence; negative/abstention controls | Fixed fixture scopes | Actual retrieval+proposal service | SQLite/PostgreSQL deterministic | No real-model quality claim | evaluation fixture/report |

## Protocol frozen before matcher/fixture implementation

Freeze three disjoint originating template families in training and four different
families in held-out; never put near-duplicate text/identifiers/targets across the
partitions. Declare a lexical token-overlap relevance matcher (lowercase Unicode
words, set Jaccard similarity, minimum 0.2; no item IDs/fixture labels). Rank by
similarity then immutable feedback ID; explicit corrections supersede earlier
judgments. Model fixture may use only supplied examples plus current offered
candidates and observed query words. It may not look up expected answers.

Training includes an explicitly corrected destination and explicit negative route.
Held-out comparable cases use different wording/document IDs; unrelated cases,
revoked/cross-scope controls and ambiguous no-match cases must not gain a route.
Evaluate paired baseline/no-examples versus treatment/training-only examples with
identical inputs/permissions. Report target/action accuracy, abstention, unchanged
controls, denominators, exact duplicates separately, uncertainty and permission/
automation snapshots. Freeze fixture/matcher code, declared expected labels and corpus hashes before
executing the paired experiment; do not tune against its results. These are authored
contract fixtures, not a blinded provider-quality experiment. No automatic outcomes exist in v1; report that unavailable stratum
rather than invent samples. Real-provider quality and threshold evidence belongs
#3677, not this deterministic contract experiment.

## Review-pending implementation checkpoint

The 21 feedback cases ran on both real SQLite and non-superuser PostgreSQL.
SQLite initially passed 20 with one exact-byte fixture failure: changing the
feedback budget legitimately invalidated inherited selection compatibility. The
fixture now uses an authorized source generated before feedback opt-in; the
exact UTF-8 boundary and pre-provider refusal pass without weakening the guard.
PostgreSQL initially passed 20 with one expired tombstone failure: querying an
undefined action ID aborted the transaction before eligibility could fail closed.
The owner now rejects redacted/malformed identity before querying UUID columns;
the focused current-generation-after-purge regression passes. These focused
results do not constitute a fresh complete suite pass.

Additional focused SQLite checks pass for independent-source rule support and
retention (2 cases). Previous failed logs are retained externally. Initial
retention nested-transaction failures and unknown-outcome replay failures were
repaired at their owning boundaries with unchanged timeout settings. Final full
SQLite/PostgreSQL, browser, packed-consumer and root gates remain required.

Checkpoint owning build/browser-boundary packaging, TypeScript/test TypeScript,
Svelte diagnostics and all 26 component tests pass. The independent-source rule
case also passes on PostgreSQL. The first Chromium run failed all five scenarios
at the unchanged initial upload visibility wait: traces show pending upload I/O
and a busy inbox, without a server error. Concurrent filesystem-bound UI database
validation was active. This is preserved diagnostic evidence, not a browser pass;
the identical browser command must rerun after that workload completes.
