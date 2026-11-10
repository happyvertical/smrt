# smrt-sales/referrals

Per-module semantics for `@happyvertical/smrt-sales/referrals`. Package orientation, the
cross-module invariants (currency, tenancy, cross-package refs, roles vs.
money), and the Gotchas that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

- **Referrer**: role model (`profileId`, `earnerId`, `status`).
- **ReferrerIdentifier**: append-only alias per tenant, kind, and normalized value. Optional program limits where it matches. Disable an obsolete alias to preserve its audit history and reservation. Register through `ReferrerIdentifierCollection.register()`, which derives the normalized value, checks same-lane ownership, and returns the existing active alias when the owner and program match.
- **ReferralProgram**: program defaults — default commission plan key, default attribution policy key, eligibility defaults.
- **AttributionPolicy**: versioned `(tenant_id, policy_key, version)` policy (per-tenant keys) — attribution `windowDays`, credit mode (`first_touch|last_touch|assigned|split`), split shares, self-referral/existing-client eligibility, eligible services/campaigns/regions, conflict behavior. Immutable once active; amendments bump `version`.
- **ReferralLink**: shareable link/code per Referrer+Program. Codes are crypto-random and uniqueness-checked. `ReferralLinkCollection.recordClick()` transactionally creates one immutable touch plus one counter increment behind a caller replay key. Exact retries return the original touch; changed link/subject/time/evidence intent raises `ReferralClickReplayConflictError`. Replay comparison uses the immutable operation/touch snapshot, so later mutable link edits do not invalidate the retry; the result carries the current link and original touch evidence. The exact canonical persisted evidence JSON, after Sales overwrites `code`, `linkId`, and `targetUrl`, is bounded to 4096 UTF-8 bytes by default (`maxEvidenceBytes` customizes it). By default the click self-transacts and rehydrates results after commit; inside a caller's open transaction it must participate instead — pass the transaction database as `RecordClickInput.transaction`, or call it on a collection bound to that transaction, and the click joins the caller's atomicity with results bound to that transaction (#2083).
- **ReferralTouch**: immutable attribution evidence (`click|code_entry|manual_assignment|partner_entry|nomination`) with subject hints and evidence JSON.
- **Referral**: the introduction — generic qualifying target (`targetKind`/`targetId`: lead, opportunity, client, project, subscription, …), resolved policy version, credit fraction (splits create sibling Referrals sharing `splitGroupId`), lifecycle `pending → attributed → qualified | disqualified | expired | under_review`.
- **AttributionException**: conflict review queue. Conclusive policy resolves automatically; ambiguity creates an exception; overrides require a `resolutionReason` and are audited.
- **ReferralAgreement**: versioned per-Referrer terms binding — pins `commissionPlanKey`/`planVersion`, effective dating, and an immutable `ExecutedAgreement` before activation. Amendments are fresh unsigned drafts and never inherit execution evidence.
- **Plan compatibility**: qualification and requalification accept only v1 component plans. A pinned or latest-active v2 waterfall plan returns `unsupported_plan_engine` before snapshot/referral writes; existing snapshots remain valid and unchanged. Bind compatible component terms and retry to recover. Engine changes under a plan key never implicitly migrate referrals.
- **ReferralTermSnapshot**: immutable at qualification — freezes agreement/plan/policy version refs plus the calculation inputs needed to reproduce every later earning.
- **Services**: `ReferralAgreementExecutionService` binds generated Referral Agreement versions to the generic execution service and activates/supersedes them transactionally with future-effective amendment support; `AttributionService`, `ReferralQualificationService`, and `ReferralCommissionService` retain their existing attribution/qualification/earning responsibilities.


## Prospect nominations

Hosts can call `ReferralNominationResolver.recordNomination()` during intake and
`resolve()` when an attribution target exists. Supply the same subject and
nomination inputs, using the original intake time when known. Exact registered
email, code, name, or handle and active program link codes take precedence over
display-name scoring. The fallback compares name-sized word spans and requires
a score of at least 0.85 and a lead of at least 0.12 over the runner-up.
Candidates must be active in the program's tenant lane.

A match records an immutable, deterministic touch with the original nomination
and match provenance. In `assigned` mode both manual assignments and matched
nominations can earn credit. Competing assignment-grade touches for distinct
referrers go to review. The program's current policy governs credit, and
qualification still requires the usual versioned agreement and plan.

Without a unique confident match, resolution creates one open
`nomination_unresolved` exception for the target and program with the original
inputs and policy pin. Candidate entries in this exception have an empty
`touchId`. Operators award credit using `AttributionService.resolveException()`.
They can then call `registerResolvedIdentifier()` to remember a verified alias
for a referrer who received credit. Run both operations in the caller's
transaction when registration and resolution must commit together. The host
authorizes both operations and serializes attribution per target and program.
