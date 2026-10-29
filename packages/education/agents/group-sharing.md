# Homeschool group sharing contract

Architecture and pre-implementation test design for [SMRT #4469](https://github.com/happyvertical/smrt/issues/4469), consumed by Hearth #41. This document defines the intended contract; it is not a claim that implementation or validation has passed. Risk is high: explicit cross-tenant authorization, private child media, concurrent consent mutation and new persistent schema.

## Ownership and boundary

A group has an independent users `Tenant`, created with `TenantService` in the caller transaction, and ordinary users memberships/roles/permissions for its supervisors. Family tenants remain independent; do not make them descendants of the group. A supervisor never receives family membership, an inherited family role, a guardian relationship, or a family resource grant. Profiles remain canonical identities. Users `Group` is tenant-local RBAC, not the homeschool relationship.

Education owns a per-child group relationship in the child's exact family tenant. Its identity is `(familyTenantId, learnerId, groupTenantId)`, allowing several children and several groups without copying work. All work, immutable attempts/revisions, source files, releases, marks and comments stay family-owned. Revoking participation or narrowing a policy changes access, never deletes learning history or attribution.

`ResourceGrantService.checkResourceOperationPermission` first requires permission in the resource's tenant. It cannot authorize these family reads without broadening supervisor authority. Reuse users permission checks in the group tenant; do not use ResourceGrant as a cache of policy matches. `TenantService` seeds roles during initialization and does not itself wrap create+ownership in a transaction; initialize/provision under the service's executor and reject partial creation.

The only cross-tenant entry is an explicit `GroupSharingService` operation. A trusted host authorizer receives the exact active executor and verifies current stored session, user, group membership and operation permission. Education then validates the persisted group, exact family/child edge and current policy before using exact family-scoped collection reads. No user-supplied SQL, cross-family list, system context, `allowCrossTenant` escape, synthesized guardian authorization, or direct collection handle is exposed. A reviewed scope switch may select only the already validated exact family and restore the caller context; it never turns a family collection into an unscoped query.

Group roster discovery uses only `GroupLearnerRosterEntry` enumerated with exact group tenant and group ID predicates. Its opaque selectors route to each exact family-owned membership and current policy, which are independently checked before any learner name or work is projected. A roster row is not an access grant: stale, revoked, corrupt or mismatched edges are denied. Never discover group participants by an unscoped query over family-owned memberships, invitations or work. Acceptance writes the roster index in the same transaction as the family edge/policy and invitation status. Revocation can retain that index for stable opaque history; it must confer no continued access. Concurrent acceptance/retry creates one index row, and rollback leaves none.

## Closed persistence

All models disable API, MCP, CLI and AI mutation/discovery surfaces. Exports/manifests/recipe registration must preserve that closure. Use qualified cross-package references to users/profiles and local foreign keys inside education. Models are root-importable for generated registration. Tenant predicates are explicit on every family lookup, including foreign-key validation. Do not silently upsert immutable identities.

| Model | Ownership and minimum fields | Invariants |
| --- | --- | --- |
| `EducationGroup` | Group tenant; name, active flag, creator user/profile | One record per group tenant. No family data. Group creation and users owner membership commit together. |
| `GroupLearnerInvitation` | Group tenant; group, opaque familyTenantId/learnerId selectors, exact invited parent user, creator, expiry, status, accepted edge ID, accepted policy digest | Status pending/accepted/revoked/declined; expiry required; immutable scope. Group staff creates a targeted invitation without reading or confirming family/learner data. Validate the exact family/learner only at parent acceptance. ID selects an invitation, never proves parent identity. |
| `GroupLearnerMembership` | Family tenant; group, learner, consent parent, status active/revoked, policyVersion | Unique family/learner/group tuple. Revocation is durable. A fresh invitation is required to reactivate a revoked edge; old accepted invitation cannot reactivate it. No one-child-only uniqueness. |
| `GroupLearnerRosterEntry` | Group tenant; groupId, familyTenantId, learnerId, membershipId | Unique group/membership tuple; immutable opaque scope index, populated atomically with acceptance. Stores no names, work or policy payload and confers no access. |
| `GroupSharingPolicy` | Family tenant; membership, monotonically increasing version, schemaVersion=1, canonical policy JSON, parent actor/time | Immutable append-only snapshots; edge points at current version. Unique membership/version. Explicit policy at acceptance; no implicit share-all. |
| `GroupRevisionComment` | Family tenant; edge, learner, activity, attempt, exact revision, author user/profile, body, createdAt, childVisible=false, visibility parent/time/version=0 | Stable author and revision binding; cannot grade, alter assessment/evidence or silently move to a newer revision. Only parent changes child visibility. Group departure retains row. |

Use guarded JSON getters/setters and runtime validation for policy documents. Enforce tuple uniqueness with database schema constraints. Validate status/version on model writes and revalidate persisted values on service reads, failing closed on corrupt or unknown values. The public model decorator does not expose SQL CHECK constraints; do not broaden core or claim database CHECK enforcement for these fields. Use normal manifest migrations; never create schema at runtime. Invitation delivery/authentication is host-owned; group invitations do not mint identity sessions, and acceptance requires an independently authenticated current parent. Initial release may use exact known parent IDs; mailbox identity onboarding is not implied by an invitation ID.

## Service API and policy

All requests carry authenticated `actorUserId`, actor session/context binding and explicit resource selectors; none of those are accepted as authority merely because they are present. Proposed public operations:

- `createGroup`, `getGroup`: current group administration/reading through users permissions; provision atomically.
- `inviteLearner`: current group invitation authority creates a group-owned invitation for an exact known parent and opaque preknown family/learner selectors; it does not read family data, prove those selectors exist or require the inviter to be a guardian. `revokeInvitation` requires current group invitation authority. `declineInvitation` requires the exact currently authenticated invited parent and makes a pending invitation terminal without revealing learner data. `acceptInvitation({ invitationId, policy })`: the exact named parent must currently be guardian of the selected child in the selected family; acceptance requires explicit valid policy. Accept locks the invitation and child/group edge, rechecks active group, parent authority and expiry, inserts edge/policy/group-owned roster index and marks accepted atomically. The parent need not be a group member or supervisor.
- `setSharingPolicy({ membershipId, expectedVersion, policy })`, `revokeMembership`: current family guardian only. An accepted retry returns the same edge only when parent and original canonical policy digest match and current edge remains active; it never resets policy changed later. Wrong-parent retries fail. Changed acceptance payload conflicts. Expired, revoked or declined pending invitations fail. Accepted historical retry may return original result after expiry only while its current edge is active and parent remains authorized.
- `previewSharing({ membershipId, policy? })`: current parent; evaluates saved or explicitly proposed policy using exactly the evaluator and projection used for supervisor reads. Proposed preview does not persist or grant access. Return per-item allowed facets and parent-facing reasons.
- `listSharedWork`, `getSharedWork`, `getSharedRevision`, `readSharedMedia`, `getSharedProgress`: current group supervisor, exact active edge and current policy, with bounded pagination. Reauthorize each call and each selected resource; no reusable authorization result escapes the invocation.
- `addRevisionComment`, `listRevisionComments`: supervisor comment write requires currently shared exact work/revision and group comment permission; parent reads retained family comments independently of group revocation. Child reads require own learner identity and the current saved parent comment-visibility policy; version-zero comments inherit that policy. `setCommentChildVisibility({ commentId, expectedVersion, visible })` is parent-only.

Policy v1 has explicit booleans `shareWork`, `shareMedia`, `shareFeedback`, `shareProgress`, `parentReviewedOnly`; `historyFrom` is a required valid UTC instant; `commentVisibility` is required and accepts only `parent-only` or `learner-visible`; the host presents `parent-only` as the initial default but the service requires an explicit saved choice. `subjects` and `courseIds` are explicit selector objects (`all` or nonempty `include` values). Unknown version/keys/enums, malformed or missing required fields fail closed. Empty include selects nothing or is rejected consistently; it never means all. An explicit all selector intentionally allows unknown metadata; any restriction requires matching authoritative metadata. Subject comes from the retained activity's authorized course metadata, not a browser label or inferred assessment text. Course metadata is resolved through the same authorized self/ancestor/global catalog scope for options, preview and supervisor reads, after validating the child's exact family-owned enrollment. Catalog scope conveys no family or guardian authority to a supervisor. Synthetic routing courses for unfiled captures are excluded from selector options; unfiled capture facts retain unknown course and subject even if a technical placeholder has a label or subject. Genuine enrolled courses remain selectable before any capture. An unfiled activity or missing course/subject does not match a restricted selector. Both restrictions intersect when present.

One pure evaluator takes normalized policy and verified work/revision facts. All public reads and preview call it. History is based on immutable attempt capture time, inclusive at the cutoff; reanalysis/re-filing does not make old work new. Each correction attempt is evaluated separately. `parentReviewedOnly` requires a valid guardian revision of the selected attempt; AI analysis, child release acknowledgement or merely having some other reviewed attempt is insufficient. Feedback is projected only when enabled and the exact selected revision satisfies the review gate; work and media DTOs never incidentally contain feedback, marks or hidden historical question text. Progress may be enabled independently of feedback/work payloads: derive it only from permitted attempts/revisions, never from the whole-family summary. Media is allowed only for an allowed work attempt and the explicit media flag. New matching work appears automatically through evaluation, without per-work grants or background grant materialization.

Supervisor projections contain stable activity/attempt/submission/revision IDs and authorized data only. They expose no writable models, family settings, sibling counts, source storage URLs, answer keys, personal-use catalog assets or ingestion scratch. Work identity does not authorize all revisions. Default omitted revision selects a deterministic permitted current revision; explicit unavailable revision refuses, never silently falls back. Policy flags remain independent; test every combination where one facet could leak through another.

### Fixed exported contracts for implementation

Put shared types and validators in `src/group-sharing-contracts.ts`; models import them, while the pure evaluator imports types only. The following names are the consumer contract, not alternate spellings for workers to invent:

```ts
type GroupSharingSelector =
  | { mode: 'all' }
  | { mode: 'include'; values: string[] };
interface GroupSharingPolicyV1 {
  schemaVersion: 1;
  shareWork: boolean;
  shareMedia: boolean;
  shareFeedback: boolean;
  shareProgress: boolean;
  parentReviewedOnly: boolean;
  commentVisibility: 'parent-only' | 'learner-visible';
  historyFrom: string;
  subjects: GroupSharingSelector;
  courseIds: GroupSharingSelector;
}
interface GroupSharingActor {
  actorUserId: string;
  sessionId: string;
}
interface GroupSharingScope extends GroupSharingActor {
  groupId: string;
  familyTenantId: string;
  learnerId: string;
}
interface GroupSharedWorkSelector extends GroupSharingScope {
  activityId: string;
  attemptId: string;
  revisionId?: string;
}
interface GroupSharingWorkFacts {
  capturedAt: string;
  courseId: string | null;
  subject: string | null;
  parentReviewed: boolean;
}
interface GroupSharingDecision {
  eligible: boolean;
  work: boolean;
  media: boolean;
  feedback: boolean;
  progress: boolean;
  reasons: string[];
}
```

Export `validateGroupSharingPolicy`, `evaluateGroupSharingPolicy(policy, facts)`, `GroupSharingAuthorizationError`, and `GroupSharingConflictError`. `GroupSharingWorkFacts` is populated only by the owning reader, never request JSON. Return names are `EducationGroupView`, `GroupLearnerInvitationView`, `GroupLearnerMembershipView`, `GroupSharedWorkView`, `GroupSharedRevisionView`, `GroupSharingPreview`, `GroupSharedProgressView`, and `GroupRevisionCommentView`. Views are immutable data DTOs, with no model instances or executor. Use `familyTenantId` in requests; family-owned models store that as their required `tenantId`. Invitation and roster-index ownership are the explicit exceptions: its `tenantId` is the group tenant and `familyTenantId` is a distinct opaque scope field. Invitation group staff DTOs disclose only submitted selectors/status, never dereferenced family names, existence or child data. `groupId` references EducationGroup, whose `tenantId` is the users group tenant. Do not confuse these two tenant selectors.

Eligibility means course/subject/history/review gates pass; facets intersect eligibility with their explicit flag. `media` additionally requires `shareWork`, so the first implementation exposes original media only with work enabled. Progress can remain enabled while work/feedback DTOs are disabled. Assessment-derived text, answers, scores, computed answer regions and annotated renditions count as feedback. With feedback disabled but work/media enabled, the authorized original child submission bytes remain accessible: marks physically present in those original bytes are intrinsic source content, not a hidden assessment projection. Hosts must make that parent choice clear. A hidden guardian-origin reference/cover or answer-key file is never promoted to an original child submission merely by this toggle.

The authorization callback is `GroupSharingAuthorizer(request)` where request carries actor, exact group/family/learner selectors as applicable, a discriminated action and `executor: DatabaseInterface`. Actions are `education.group.create`, `education.group.manage`, `education.group.read`, `education.group.invite`, `education.group.share`, `education.group.review`, `education.group.comment`, and `education.group.child-comments`. The host verifies live identity and its effective permissions/guardian terms; the service independently verifies persisted resource scope, current edge/policy and exact selectors. Callback success never bypasses those checks. The reader accepts this callback, never a boolean token, and exposes only read/projection methods. No generic `authorizeAsGuardian` or arbitrary collection callback belongs to this API.

## Owning workbook/media seams

Current `WorkbookService` activity/timeline APIs require learner/guardian authority; replacing the authorizer with unconditional true would create a broad guardian backdoor. Add an explicit read-only owning projection seam with a required exact-resource authorization callback, invoked on its active executor before loading private data and again at final projection/delivery where appropriate. It must not expose mutation methods or accept an externally cached authorization boolean. This seam can live in a dedicated education sharing reader that uses owned collections with exact predicates; private workbook algorithms should be shared through an owning helper rather than copied or private-state access.

The selected attempt must belong to exact family/learner/activity/submission; selected revision must belong to that attempt. Original bytes must be owned through `SubmissionAsset`, match the retained source ID/hash and belong to the learner's private asset owner. Photo covers/reference-only receipts are not work. The ordinary `signSubmissionAsset` returns a signed URL after learner authorization; it is insufficient for this sharing contract. `readSharedMedia` must run current policy/role/session/edge checks for every HTTP delivery and open the exact `withPrivateAssetAccess` scope only within that request. Return bytes or execute a scoped streaming callback; never return public/presigned storage URLs or a long-lived capability. The host route must invoke it even for a replayed/direct URL and configure private storage/cache headers. No framework can revoke bytes already delivered; successful reads linearize at their final authority check. A revocation completed before a new request must always deny that request.

Shared progress recomputes from the permitted subset of current guardian evidence and never calls the full guardian summary then merely redacts its citations. With `shareProgress=true` and `shareFeedback=false`, its strict field allowlist is counts of shared completed work, distinct practice episodes, and assistance categories (independent/assisted/unknown) only. Completion here means a permitted work attempt exists as completed/captured work, never a correctness threshold or private Grade-derived completion decision. Do not expose correctness, points, possible points, scores, concept labels, question identities/text/answers, feedback or outcome-derived aggregates. No question-level evidence citations appear in this counts-only shape. This restriction must hold even for a single attempt, where an aggregate would reveal the entire withheld outcome. When feedback is also enabled, authorized descriptive concept evidence may additionally be projected with permitted citations and existing episode deduplication; it still cannot include hidden subject/history/sibling evidence.

Comments remain outside Grades, assessment revision bodies, scoring and progress evidence. Parent-only comments can be shown to their currently authorized author/supervisors and guardians; this means hidden from children by default, not anonymous. Parent can retrieve original author/time after revocation. Child comment access always checks the current saved policy: `parent-only` denies all child comment reads immediately, including previously visible comments; `learner-visible` permits default comments whose `visibilityVersion` is zero. A parent may additionally set an individual override: when `visibilityVersion > 0`, `childVisible` must be true as well as the saved policy being `learner-visible`. Thus a saved learner-visible choice needs no per-comment opt-in, an individual false override narrows it, and an individual true override can never broaden parent-only. Policy changes apply on the next read and never rewrite the original comment or its attribution.

## Transaction and race semantics

Use one active executor for current users/session checks, guardian relationship terms, group state, edge/policy and owned data. Authorization hooks must not capture the outer pool. Mutations run in the education transaction/composite queue with deterministic lock ordering (learner, group/edge, invitation/comment as applicable); acquire the learner lock in the same order as workbook capture/review. PostgreSQL must arbitrate with row locks or conditional writes plus unique keys; process-local locks alone are insufficient. SQLite serialization must not overlap statements on a single native handle. Failed nested operations poison/roll back the enclosing operation even if a callback catches an error.

Concurrent identical acceptance converges to one active edge, one first policy, one group-owned roster entry and one accepted invitation result. Competing policies cannot both win; one conflicts. Concurrent policy updates using one expectedVersion produce one successor. Education-owned edge/policy/invitation mutations participate in the same lock/guard protocol: acceptance versus invitation revoke and comment writes versus edge revoke/policy narrowing are serialized, so the losing mutation cannot commit on stale education-owned state. External users sessions, roles/memberships and guardian-term writers do not participate in that protocol. Their authority linearizes at the final successful live authority read on the active executor, not at transaction commit. An operation authorized before a concurrent external revocation may finish; a new request starting after that revocation committed must deny. A same-executor callback or second read alone cannot close the final-check-to-commit window, and this contract does not claim otherwise. Do not use a transaction snapshot established before the request to satisfy a new request's current-authority check. Stronger commit-time exclusion would require an actual owning users/profiles writer protocol and is outside this contract. Media reads use final-check linearization; bytes already delivered cannot be recalled. Database, authorizer or asset failures propagate as failures, never authorize on fallback. Failed group creation, acceptance and policy append leave no partial tenant/owner/edge/policy/roster/acceptance state. No service starts containers.

## Behavior-to-test matrix

This is the test-design-contract matrix. Every row requires recorded execution evidence before release. Common context abbreviations: P = independently authenticated current family guardian; S = authenticated group supervisor; C = own child; X = outsider, sibling or other-group actor. TX means the same exact executor for authorization and persistence. SQ/PG means in-process SQLite and PostgreSQL; Node is the supported server runtime. Browser is intentionally not an authorization runtime. Command S: `pnpm --filter @happyvertical/smrt-education exec vitest run src/__tests__/group-sharing-lifecycle.test.ts src/__tests__/group-sharing-adversarial.test.ts src/__tests__/group-sharing-reader.test.ts src/__tests__/group-sharing-comments.test.ts`; command P: `pnpm --filter @happyvertical/smrt-education test:postgres`; command M: `pnpm --filter @happyvertical/smrt-education exec vitest run src/__tests__/group-sharing-models.test.ts src/__tests__/group-sharing-manifest.test.ts`; command B: package `typecheck`, `build`, `verify:pack`. The shared behavioral harness must be imported by both SQLite and `group-sharing.optional.test.ts`; a skipped optional PG suite is not passing PG evidence.

| ID / behavior | Reachable trigger | Positive | Negative / failure | Actor/context | Executor / transaction | Runtime / dialect | External edge | Level / command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G01 isolated group | createGroup | owner membership and group in distinct tenant | rollback after tenant insert; no family membership/parent hierarchy | P, X | TX provision atomic | Node SQ/PG | TenantService failure, unknown permission | integration S/P |
| G02 closed persistence | generated registration/discovery | package imports models/recipe | no REST/CLI/MCP/AI CRUD advertised | untrusted caller | manifest, no DB needed | Node; schema SQ/PG | packed root exports | contract M/B |
| G03 edge cardinality | invite/accept multiple edges | two children × two groups coexist | duplicate tuple or rebinding learner/family | P, X | TX unique constraints | Node SQ/PG | malformed IDs | integration S/P |
| G04 invite targeting | inviteLearner/accept | group inviter creates without family lookup; exact parent accepts with current effective guardian terms; exact parent declines | other parent, expired relationship, wrong family/group/sibling, expired/revoked/declined invite | P/X | TX current session + relationships | Node SQ/PG | absent/expired session, authorizer throw | adversarial S/P |
| G05 explicit policy | acceptInvitation | valid explicit v1 choice | omitted policy, unknown version/key, malformed date/selector/boolean | P | TX no partial writes | Node SQ/PG | untrusted JSON | service S/P |
| G06 retry | accept same invite | same edge/policy/result, even after later policy narrowing | changed payload/parent; revoked edge never reactivated | P/X | TX immutable digest | Node SQ/PG | request replay | integration S/P |
| G07 acceptance race | two accepts | identical requests converge | differing policy, revoke/expiry wins; injected failure rolls all back | P | independent root connections PG, serialized SQ; unique arbiter | Node SQ/PG | failure between edge/policy/roster/accepted writes; retry leaves one index row | concurrency S/P |
| G08 policy version | setSharingPolicy | append version and preserve previous snapshots | stale expected version, supervisor write, invalid payload | P/S | TX compare-and-set | Node SQ/PG | concurrent updates, upstream auth failure | concurrency S/P |
| G09 automatic evaluator | new capture/list | matching new work appears without grant creation | unknown restricted subject/course; course and subject mismatch | S/P preview | TX exact family queries | Node SQ/PG | unfiled/missing metadata | unit + service S/P |
| G10 history/review | get work/revision | inclusive cutoff and reviewed exact attempt | old attempt reanalysis, other attempt's review, provisional-only revision, malformed ancestry | S | TX immutable facts | Node SQ/PG | future/invalid dates, stale revision ID | unit + adversarial S/P |
| G11 facet independence | every public DTO | explicit work/media/feedback/progress combinations | disabled feedback leaks through marks/status/comment or progress; disabled media via anchors | S | TX projection | Node SQ/PG | omitted optional payload fields | table-driven S/P |
| G12 preview parity | preview and subsequent reads | identical allowed IDs/facets under same saved/proposed policy | unauthorized preview; proposal creates grant/write | P/S | same evaluator/TX | Node SQ/PG | policy parse failure | contract S/P |
| G13 current authority | list/detail/revision/media/comment/summary | active S exact group+edge | stale session, removed role, inactive membership/group, wrong active context, sibling/group edge | S/X | current TX reads, cache:false | Node SQ/PG | every public service path | adversarial parameterized S/P |
| G14 narrowing/revoke | reuse IDs/direct route after change | parent retains originals/history | previously allowed S denied after policy/edge/group/role/session revoke | P/S | TX; final check | Node SQ/PG | stale URL and request replay | service + host contract S/P |
| G15 exact source ownership | readSharedMedia | exact SubmissionAsset retained hash and private owner | foreign asset/submission/revision, source cover, answer key, tampered hash, public URL | S/X | TX + exact private scope | Node SQ/PG | storage missing/failure; no leaked locator | integration S/P |
| G16 immutable work IDs | list/get/correction/reanalysis | stable attempt/revision IDs and source citation | foreign revision, selector fallback, reanalysis counted as new practice | S | TX read-only | Node SQ/PG | workbook reader seam | integration S/P |
| G17 scoped progress | getSharedProgress | counts-only allowlist without feedback; descriptive evidence with feedback; episodes deduped | single-attempt or multi-attempt withheld correctness/score/concept/question leakage; hidden evidence contributes counts | S | TX filtered evidence before aggregate | Node SQ/PG | nullable scores/unknown assistance | integration S/P |
| G18 comment author/binding | add/list comments | exact visible revision, stored current author | forged author, hidden/foreign revision, supervisor grade/evidence mutation | S/P | TX immutable bind | Node SQ/PG | malformed/empty/oversize text | adversarial S/P |
| G19 comment visibility | set visibility/child list | saved learner-visible exposes version-zero defaults; explicit false narrows; parent-only immediately hides all | missing/unknown policy field, default parent-only C read, sibling, supervisor visibility update, stale version | P/C/S/X | TX guarded visibility version | Node SQ/PG | visibilityVersion=0 inherits; >0 requires childVisible plus saved learner-visible | integration S/P |
| G20 retained family records | revoke then family read | originals, revisions, comments/attribution remain | supervisor retains old access; cascade removes learning rows | P/S | TX family authority independent of group | Node SQ/PG | no byte cleanup on revoke | integration S/P |
| G21 transaction affinity | host hooks in operation | all callbacks observe exact TX including nested reads | outer-pool hook usage, swallowed failure commits, closed service reuse | P/S | instrument executor; rollback injection | Node SQ/PG | callback failure | integration S/P |
| G22 interleaving authorization | comment/media vs revoke/narrow | own edge/invite/policy mutations serialize; pre-external-revoke authorized operation may finish | stale own-edge check commits after winning revoke; new post-commit session/role/guardian-revoke request succeeds | P/S | independent PG transactions/barriers; SQ serial equivalent | Node SQ/PG | deterministic barriers for own-edge race and external final-check/new-request semantics | race S/P |
| G23 migration compatibility | manifest upgrade + normal schema apply | six closed models migrate on empty/existing DB; old workbook history unchanged | missing schema fails without runtime DDL; duplicate edge/roster tuple blocked; corrupt status/version read denied | deploy | explicit migration TX | Node SQ/PG | native UUID FKs, migration failure | schema U/P/B |
| G24 recipe/plugin contract | recipe discovery and packed import | group recipe registered, service/types usable | generated CRUD exposed or missing root symbol | host | N/A: static registration, no persistence | Node | downstream manifest/recipe consumer | contract M/B |
| G25 bounded query scope | list pagination/direct service | exact group-owned roster enumeration then each exact family edge/policy check; bounded results/stable cursors | forged/stale roster grants access; caller limit hides deny; cursor reveals foreign work; raw cross-family edge query | S/X | TX group index read then exact family predicates | Node SQ/PG | invalid cursor/limit | adversarial S/P |
| G26 staff group discovery | listMyGroups after login | own active groups; inactive group only for current manager | other user/session, removed membership, inactive nonmanager group | S/X with original session context | TX users own-membership enumeration then exact group scope | Node SQ/PG | unknown group tenant and authorizer error | integration S/P |
| G27 family/child navigation | listLearnerMemberships access guardian/child | parent retained summaries; own child active group names | sibling, wrong actor, child guardian-policy/history escalation; revoked/disabled child edge | P/C/X | TX exact family/learner, current own-user proof | Node SQ/PG | invalid access selector | adversarial S/P |
| G28 invitation preview/list | getInvitation/listInvitations | named guardian preview without group membership; staff opaque selectors | wrong invitee, missing guardian proof, staff family dereference | P/S/X | TX exact group invite; parent exact family proof | Node SQ/PG | parent/staff explicit access discriminator | integration S/P |
| G29 retained policy history | getSharingPolicyHistory after leave | immutable versions/actors/time and scoped numeric pagination | supervisor/child read, malformed cursor/limit, foreign edge | P/S/C/X | TX exact family edge, guardian before/after | Node SQ/PG | unknown stored policy or version fails closed | integration S/P |
| G30 opaque revision binding | feedback withheld; new revision before comment | work exposes immutable comment ID; comment remains on opened revision | foreign/provisional assessment under selected-review gate, hidden assessment payload | S | TX exact attempt/revision and current policy | Node SQ/PG | opaque comment selector independent of feedback | reader/comments S/P |

| G31 pre-consent policy options | getSharingPolicyOptions exact family/learner before invite acceptance | current guardian receives labeled learner course/subject options without a group edge | child/supervisor/outsider, wrong family/learner, stale guardian/session, private answer/catalog data | P/S/C/X | TX exact family/learner guardian before/after; no policy mutation | Node SQ/PG | groupId omitted; current scoped metadata only | reader S/P |
| G32 metadata/private capability isolation | ordinary member group home vs roster/work | education.group.read permits group metadata/discovery only; education.group.review permits authorized private scope | metadata-only member roster/work/revision/media/progress, role/action escalation | current stored ordinary member/S | TX role/session/group plus exact edge/policy before/after | Node SQ/PG | guardian review remains separate exact guardian proof | adversarial S/P |

## Implementation ownership partitions

Coordinate these partitions before editing; integrations are serial, not concurrent edits to the same file.

1. Persistence/contracts worker: `src/group-sharing-models.ts`, `src/group-sharing-contracts.ts`, `src/__tests__/group-sharing-models.test.ts`. Own validation/types/closed models and unique schema; freeze exported interfaces first.
2. Lifecycle worker: `src/group-sharing-service.ts`, `src/group-sharing-authorization.ts`, `src/__tests__/group-sharing-lifecycle-workflows.ts`. Own group/invitation/edge/policy state machine, shared transaction and current-authority boundary. Do not implement a second workbook reader.
3. Read/projection worker: `src/group-sharing-reader.ts`, `src/group-sharing-policy.ts`, `src/__tests__/group-sharing-read-workflows.ts`. Own same evaluator for preview/reads, exact work/media projection and scoped summary. Any changes needed to `src/workbook-service.ts` or `src/submission-service.ts` belong exclusively to this worker after parent approves the owning seam. Do not widen LearnerAuthorizer.
4. Integration owner: `src/group-sharing-comments.ts`, shared test runner `src/__tests__/group-sharing-workflows.ts`, SQLite/PG entrypoints, `src/index.ts`, `src/recipes.ts`, recipe help, package docs/AGENTS and generated artifacts. Integrate comment API after lifecycle/read interfaces stabilize, run full validation/review once. Could delegate comments as a separate non-overlapping worker after contracts freeze.
5. Architecture owner: this document only. Record executable evidence/results through the parent session; proposed matrix rows do not substitute for executed tests.

## Upstream/host contract gaps to resolve before release

- Existing workbook guardian projections and signed asset API are not a sharing boundary. The new owning read seam and host authenticated media route are mandatory, not optional integration notes.
- Host current-session/group permission and current guardian-term verification must use the provided transaction executor. No external app is permitted to supply an always-allow callback or stale role snapshot. Document exact action names/role seed in implementation.
- Course.subject is a mutable string; define whether policy uses current authoritative metadata (recommended for immediate narrowing) or immutable metadata snapshots. This design uses current authoritative course metadata and immutable capture time. Missing/re-filed metadata is reevaluated each read.
- PostgreSQL concurrent tests need independent connections and deterministic barriers. One connection or in-process mutex does not establish multi-process acceptance/revocation safety. Integration owner supplies the isolated existing test service; workers do not provision containers.
- Public consumer contract must record the published SMRT version, exported types/actions, migration/recipe activation and media route obligations. Hearth consumes that release only; no local tarball or host shim.

## Host integration and migrations

The public `GroupSharingService(db, authorize, options?)` facade owns lifecycle,
reader and comment operations. Internal reader/comment classes are not root
exports: their borrowed-executor flags are owning implementation details.
`options` uses the normal `SubmissionServiceOptions` private storage adapter.
The facade supports atomic `withTransaction` composition; any failed queued
operation poisons the complete transaction, and escaped services reject reuse.

`updateGroup` changes the bounded display name or active flag under live
`education.group.manage` authority. Management can reactivate an inactive group;
normal read, invitation and supervisor operations cannot use an inactive group.
Disabling does not delete family rows. `removeLearner` is group-management
revocation, `leaveGroup`/`revokeMembership` are guardian revocation.
`listMemberships` enumerates only the active group's roster index and rechecks
each authoritative family edge under `education.group.review`. `getGroup` and
active `listMyGroups` use `education.group.read` for group metadata only; that
capability never authorizes child roster or shared work, revisions, media or
progress. Those private supervisor operations require `education.group.review`
and the current exact family edge/policy. Hosts may grant ordinary members group
metadata reading without any private learner access. `listLearnerMemberships` is exact-family guardian
access. Neither method offers arbitrary cross-family education discovery.

Shared work includes an opaque `commentRevisionId` even when assessment feedback
is withheld. Bind the comment form to that exact viewed revision and submit it
unchanged; never resolve the latest assessment again when saving a comment.
The identifier grants no assessment access. Feedback and child comment visibility
still pass their independent current policy checks on every read.

Activate `education.supervisor` through the host cookbook, rebuild registration
and apply the host's normal manifest migrations before serving group routes.
The six additive tables use generated native UUID references and unique keys.
Do not alter existing workbook rows or remove family data when a group leaves.
A missing table is a migration error, never permission to create schema during
a request. Test schema generation uses the same structured manifest on SQLite
and PostgreSQL; deployments retain their normal migration backup/rollback policy.

Hosts refresh the stored session and effective group permissions/guardian terms
on the callback's exact executor. Action strings above are capability names,
not a promise that any ordinary users role receives them automatically. Seed
only the desired group supervisor/admin roles and never grant family guardian
permissions. Invitation delivery is host-owned; an invitation identifier alone
is not a bearer credential. Parents can use only existing currently authorized
learners named by the immutable invitation.

Serve original bytes through `readSharedMedia` on every authenticated HTTP
request, including direct bookmarks. The result carries `private, no-store`;
hosts must also set safe MIME/disposition, sandbox CSP and `nosniff`, and never
cache responses in a service worker or expose underlying asset paths. Uploaded
originals can contain marks physically present on paper even when generated
assessment feedback sharing is disabled.

Host navigation uses `listMyGroups(actor)` for the actor's current users memberships
and `listLearnerMemberships({ ..., access: 'child' })` for an authenticated child's
own active group edges. Child navigation uses `education.group.child-comments`
and never grants guardian access to consent or policy history. Group discovery
keeps the original authenticated session context and derives exact group scopes
from stored memberships; inactive groups require current management authority.
Staff role assignment/removal uses the existing public users collections under
host authorization on the same executor. Education sharing never substitutes
for those users permission checks or gives staff family authority.

`getSharingPolicyOptions({ actorUserId, sessionId, familyTenantId, learnerId })`
returns current course labels/subjects for a currently authorized guardian before
consent, without requiring a group or accepted invitation. It uses the same
active executor and exact learner ownership checks; it creates no grants or
policy history. Host guardian decisions must validate the supplied exact current
relationships/terms separately from a group's `education.group.review` role.

## Trusted workspace-kind metadata

`isGroupTenant(db, tenantId): Promise<boolean>` is a trusted host-only metadata
lookup for an exact server-selected resource tenant. It uses the supplied current
executor, verifies that the Tenant exists freshly, and checks the owning
`education_groups` table for that exact tenant. Blank, malformed, missing or
ambiguous scope fails closed. The result is independent of group activation,
Tenant status, memberships and staff roles: disabling a group or removing a staff
membership never turns it into a family. The result contains no name, roster,
permission or grant and creates no session or tenant context. It has no generated
REST, MCP or CLI surface.

On PostgreSQL, the exact bounded group count and `row_security_active` check
share one statement on the caller's executor. One visible row establishes group
kind; an ambiguous result fails closed. Zero rows establishes family kind only
when PostgreSQL reports row security inactive for that relation and caller.
Under active RLS, zero rows is indeterminate and throws `Tenant kind is unavailable`,
including for an actual family tenant. The host needs an already trusted metadata
executor with provable unrestricted visibility to classify families. Policy-level
bypass settings alone do not prove that visibility. The helper never changes
roles, permissions, session settings or tenant context to obtain visibility.

This result is not authorization. Hosts must separately require a freshly ACTIVE
Tenant plus current signed-session, background-job or independent-proof authority
on the same relevant executor. Never pass a browser-selected tenant as authority,
interpret a missing Tenant as family, or use absence of group membership to infer
family kind. The helper provides no arbitrary cross-tenant directory.

| Behavior/invariant | Trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| G33 workspace kind | trusted exact resource lookup | existing family false; active/inactive group true | blank/malformed/absent tenant; ambiguous group rows; PostgreSQL RLS-hidden or indeterminate zero refuses family; database failures propagate | host-selected exact tenant, no synthetic session/context | caller-supplied executor, fresh reads; no writes | Node SQLite/PostgreSQL | status/membership/role absence never implies family or grants | integration | `pnpm --filter @happyvertical/smrt-education exec vitest run src/__tests__/group-sharing-workspace.test.ts` (same file with TEST_DB_ADAPTER=postgres and isolated DATABASE_URL) |
