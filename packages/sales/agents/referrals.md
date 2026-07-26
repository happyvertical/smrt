# smrt-sales/referrals

Per-module semantics for `@happyvertical/smrt-sales/referrals`. Package orientation, the
cross-module invariants (currency, tenancy, cross-package refs, roles vs.
money), and the Gotchas that apply before editing anything live in
[../AGENTS.md](../AGENTS.md) — read that first.

- **Referrer**: role model (`profileId`, `earnerId`, `status`).
- **ReferralProgram**: program defaults — default commission plan key, default attribution policy key, eligibility defaults.
- **AttributionPolicy**: versioned `(tenant_id, policy_key, version)` policy (per-tenant keys) — attribution `windowDays`, credit mode (`first_touch|last_touch|assigned|split`), split shares, self-referral/existing-client eligibility, eligible services/campaigns/regions, conflict behavior. Immutable once active; amendments bump `version`.
- **ReferralLink**: shareable link/code per Referrer+Program. Codes are crypto-random and uniqueness-checked. `ReferralLinkCollection.recordClick()` transactionally creates one immutable touch plus one counter increment behind a caller replay key. Exact retries return the original touch; changed link/subject/time/evidence intent raises `ReferralClickReplayConflictError`. Replay comparison uses the immutable operation/touch snapshot, so later mutable link edits do not invalidate the retry; the result carries the current link and original touch evidence. The exact canonical persisted evidence JSON, after Sales overwrites `code`, `linkId`, and `targetUrl`, is bounded to 4096 UTF-8 bytes by default (`maxEvidenceBytes` customizes it). By default the click self-transacts and rehydrates results after commit; inside a caller's open transaction it must participate instead — pass the transaction database as `RecordClickInput.transaction`, or call it on a collection bound to that transaction, and the click joins the caller's atomicity with results bound to that transaction (#2083).
- **ReferralTouch**: immutable attribution evidence (`click|code_entry|manual_assignment|partner_entry`) with subject hints and evidence JSON.
- **Referral**: the introduction — generic qualifying target (`targetKind`/`targetId`: lead, opportunity, client, project, subscription, …), resolved policy version, credit fraction (splits create sibling Referrals sharing `splitGroupId`), lifecycle `pending → attributed → qualified | disqualified | expired | under_review`.
- **AttributionException**: conflict review queue. Conclusive policy resolves automatically; ambiguity creates an exception; overrides require a `resolutionReason` and are audited.
- **ReferralAgreement**: versioned per-Referrer terms binding — pins `commissionPlanKey`/`planVersion`, effective dating, and an immutable `ExecutedAgreement` before activation. Amendments are fresh unsigned drafts and never inherit execution evidence.
- **ReferralTermSnapshot**: immutable at qualification — freezes agreement/plan/policy version refs plus the calculation inputs needed to reproduce every later earning.
- **Services**: `ReferralAgreementExecutionService` binds generated Referral Agreement versions to the generic execution service and activates/supersedes them transactionally with future-effective amendment support; `AttributionService`, `ReferralQualificationService`, and `ReferralCommissionService` retain their existing attribution/qualification/earning responsibilities.
