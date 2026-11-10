# Bounded release window operations

This is the operator contract for [#4306](https://github.com/happyvertical/smrt/issues/4306).
The implementation is in `scripts/release-admission-state.mjs`,
`scripts/release-admission-store.mjs`, `scripts/release-admission.mjs` and the
`release-admission.yml`, `on-merge-main.yml` and `publish.yml` workflows.
Merging code and enabling repository controls are separate actions. This change
does not authorize an agent to merge or apply live rules, permissions or flags.

## Rollout without a bootstrap deadlock

Keep the merge queue quiescent throughout bootstrap: stop new enqueues, let
existing groups finish, and pause scheduled/manual release dispatch. Preserve
all existing branch checks, review requirements and queue settings except the
explicit one-entry constraint below. Do not enable the required context before
the controller code exists on `main`.

1. Obtain normal review and merge the code through the existing protections.
   Leave `CI_RELEASE_WINDOW_ENABLED` unset or `false` during code rollout.
   The legacy idle-queue release path remains selected while the flag is off;
   the new controller jobs do not run.
2. Grant release App **2315871** repository **Commit statuses: write**
   (`statuses:write`) in addition to its existing contents write permission.
   The installation owner must approve the updated permission request. The
   approval is required before activation. Full bypass verification additionally
   uses private App **5496137**, `smrt-release-fence-verifier`, installed on
   **selected repository `happyvertical/smrt` only**, installation **175845335**.
   Workflow token minting pins both App and installation IDs. Grant only repository
   Administration write and mandatory Metadata read. GitHub redacts
   `bypass_actors` without ruleset write access; Administration read is not enough.
   Administration write can also change protections, environment policies, deploy
   keys, collaborator access and settings. It is not a GitHub-enforced read-only
   permission. Do not expand the organization-wide release App or reuse an owner's
   token. The verifier App must have no ruleset bypass entries.

   Store `HAVE_FENCE_APP_PRIVATE_KEY` only in the dedicated
   `release-fence-verifier` environment, with a **branch-type `main`** deployment
   policy. Never store it in the shared `release` environment or organization
   secrets. The owner generates and enters the private key directly. Only clean
   reservation and publication-authorization jobs may reference that environment
   or secret. They check out the trusted release workflow source, install no
   dependencies and execute no candidate code. Mint a token explicitly restricted
   to `smrt`, Administration write and Metadata read. Before private rule GETs,
   the adapter independently verifies that the installation token enumerates only
   repository ID **1077603934** (`happyvertical/smrt`). The token action revokes it
   before either job completes. No key, JWT or verifier token crosses a job output.

   Retain the reviewed `release` environment,
   its main-only deployment rule, `HAVE_RELEASE_APP_ID`,
   `HAVE_RELEASE_APP_PRIVATE_KEY` and primary registry publish credential.
3. Create the active state-branch ruleset below. Only the App may create,
   update, delete or force-update `refs/heads/hv-release-admission`. Do this
   **before** creating the state branch. Keep it excluded from broad rules
   requiring application builds or PRs; its sole file is protocol state.
4. Initialize explicitly through **Release Admission → Run workflow → command
   `init`**, using the workflow on `main`, with the feature flag still off.
   This explicit bootstrap is allowed while ordinary controller jobs remain
   disabled. Keep the queue and release dispatch quiescent. Initialization creates one
   pristine `open` state; ordinary admission and reconciliation never create
   missing state automatically. Repeating `init` on existing state fails.
5. While the queue is still quiescent, add the App-bound **Release Admission**
   required status on `main` using the additive ruleset below. Preserve every
   existing required check, including **Required CI** and the repository's
   PostgreSQL protection. Keep the queue limited to
   `max_entries_to_build: 1` and `max_entries_to_merge: 1`; update those fields
   in the existing queue rule without replacing its other parameters.
6. Set `CI_MERGE_QUEUE_ENABLED=true` and finally
   `CI_RELEASE_WINDOW_ENABLED=true`. Run **Release Admission → `reconcile`**,
   verify a healthy `open` state and App-issued statuses on current validated
   heads, then resume enqueues and release dispatch. Do not disable the flag
   while leaving its required status unserved; a rollback needs the same
   quiescent, reviewed rules/flag coordination.

The controller's full `verifyFence()` reads private bypass actors directly with
the verifier credential before closing and immediately before publication
authorization enters `publishing`. It refuses missing/inactive protections, a context without App binding,
non-App bypass actors, missing state-ref restrictions, a queue wider than one
entry, or an unprotected/moved `main`. `close` also requires
`CI_MERGE_QUEUE_ENABLED=true`. A flag alone is insufficient readiness proof.
Qualification's `assert-window` uses only the Actions read token. It checks live
public rule structure (App-bound context, state-ref restrictions and one-entry
queue), protected main, exact owner/attempt/source, qualifying phase and deadline.
It does not claim to see private bypass actors and cannot authorize publication.
The separate authorization job repeats full private verification after all
qualification and sealing, before any registry write. A missing verifier token or
missing bypass evidence fails closed. Never reuse a saved bypass list based on
`updated_at`: the live #4306 probe did not establish a reliable bypass revision
marker.

Check App installation permissions and state initialization separately; GitHub
permission failures and missing state fail closed.

## Exact ruleset examples

These are reviewable JSON request bodies for **new additive rulesets**, not
instructions to overwrite the existing main ruleset. Preserve existing checks,
approval requirements and protections. Existing overlapping rulesets must also
allow the release App's intended writes; do not add an administrator, team,
Actions App or broad role bypass to make a failed preflight pass. GitHub's
[repository rules REST reference](https://docs.github.com/en/rest/repos/rules)
defines the rule and App binding fields used here.

State branch, created before initialization:

```json
{
  "name": "Release admission state: release App only",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [
    { "actor_id": 2315871, "actor_type": "Integration", "bypass_mode": "always" }
  ],
  "conditions": {
    "ref_name": { "include": ["refs/heads/hv-release-admission"], "exclude": [] }
  },
  "rules": [
    { "type": "creation" },
    { "type": "update", "parameters": { "update_allows_fetch_and_merge": false } },
    { "type": "deletion" },
    { "type": "non_fast_forward" }
  ]
}
```

Additional main status protection, leaving existing check rules intact:

```json
{
  "name": "Release admission status",
  "target": "branch",
  "enforcement": "active",
  "bypass_actors": [
    { "actor_id": 2315871, "actor_type": "Integration", "bypass_mode": "always" }
  ],
  "conditions": {
    "ref_name": { "include": ["refs/heads/main"], "exclude": [] }
  },
  "rules": [{
    "type": "required_status_checks",
    "parameters": {
      "required_status_checks": [
        { "context": "Release Admission", "integration_id": 2315871 }
      ],
      "strict_required_status_checks_policy": true,
      "do_not_enforce_on_create": false
    }
  }]
}
```

Use the literal state branch above. No wildcard admission namespace, alternate
writer token or unbound status context is equivalent. The Actions token reads
forge evidence; the separate release App token writes admission state/statuses.
The controller checks out trusted `main`, installs no candidate dependencies and
executes no candidate artifacts when deciding admission.

## Window, source and irreversible boundary

`open` records every SHA receiving a green admission status, including validated
PR heads: a PR head can reuse a former synthetic queue commit. Each status write
first reserves an exclusive grant containing its nonce, controller run/attempt
and validation run, then acknowledges that grant only after the POST returns.
The per-head `windowGrantId` records that nonce separately from the in-flight
`grant`. Repeated admission of an unchanged head reuses its acknowledgement only
after live validation and verification that the latest authenticated release
App status for this SHA/context is that exact nonce-bearing success. Historical
success cannot override a newer pending status. Concurrent reservations that
observe an older acknowledgement cannot replace a newly completed one or post
another success. Closed-window and drain retries also reuse an identical latest
App pending status instead of repeatedly consuming the SHA/context status quota.
Closing atomically records the owning Batched Release run ID/attempt and this
finite SHA inventory, then enters `draining`. New PR/group grants wait without
extending the inventory. Existing queue refs must disappear; absent queue heads
are changed to pending before they are marked resolved. Resolved SHAs cannot
receive another green status while the window is closed.

An in-flight grant prevents resolution and freezing even if its queue ref has
disappeared. This orders delayed green writes before drain revocation; a state
read alone cannot order a remote status POST. A lost acknowledgement remains
visible and blocks the drain rather than being silently cleared on timeout.
Each drain poll refreshes durable state and checks its exact owner/phase, so an
acknowledgement can unblock the same uninterrupted drain invocation. Closing and
reopening both clear `windowGrantId`; a late writer or manual acknowledgement
may settle its saved grant but cannot establish reuse in a later window.

Persisted schema-version 1 entries without `windowGrantId` remain readable and
retain any unsettled grant. Missing identity means no reusable acknowledgement;
the next validated admission must reserve a fresh nonce. No inferred success or
automatic clearing of an existing grant is part of this compatibility path.

The current workflow allows **90 minutes total before publication** and
**30 minutes to drain**. Once every admitted queue ref has disappeared,
authenticated protected `main` is frozen as `snapshotSha`, and the window enters
`qualifying`. This source SHA pins documentation selection and every publishing
checkout, pack shard and Planner qualification. Queue wait time counts against
the protocol deadline even when a job has not started.

Ordinary failed-job retries with the flag **off** reuse the successful
preparation's exact workspace and version-patch artifact IDs. The two explicit
pack producers expose separate upload IDs, digests and producer attempts; the
aggregate requires both successful results and complete, distinct identities.
Planner and publishing download those exact IDs, including when only one pack
reruns on attempt 2 while its sibling remains successful on attempt 1. Artifact
names retain their producer attempt; consumers never derive names from their
own attempt, use a wildcard, select a latest artifact or overwrite an upload.
Digest outputs record producer identity; their presence alone does not prove
content verification. Existing packed-manifest/tarball verification still gates
publication.

With the flag **on**, this ordinary retry behavior does not transfer window
ownership. Before downloading artifacts, each pack, Planner and publisher
asserts the original run/attempt, frozen source, qualifying phase and deadline.
These assertions use the Actions read credential, and the forge adapter rejects
all mutations in this mode; Planner receives no App credential or write
permission. The aggregate also rejects producer attempts that differ from its
reserved attempt. A rerun that changes the owning attempt must stop; after
publication has begun, use the explicit original-owner recovery below. Qualification
remains subject to the original deadline.

The flag-on release has three final jobs: **Seal Release Candidate** creates the
candidate and uploads its bundle after qualification; **Authorize Exact
Publication** downloads the exact immutable ZIPs, checks their sizes/digests and
original ownership, restores Git objects with hooks/filters disabled and verifies
the candidate and packs as data; **Publish Authorized Window** publishes those
same bound bytes using the trusted recovery engine. Candidate code, installs and
npm lifecycle scripts never execute in the latter two jobs. The verifier key is
present only in authorization. Legacy flag-off publishing remains separate.

`releaseCommitSha` is a different, newly versioned commit whose sole parent is
`snapshotSha`. It is created locally before npm publication. Before entering
`publishing`, the workflow uploads its Git bundle and binds the original run's
immutable artifact IDs, names and digests for:

- `release-candidate-<run-id>-<attempt>`;
- `publish-release-pack-<run-id>-<attempt>-1`;
- `publish-release-pack-<run-id>-<attempt>-2`.

These artifacts retain **30 days**. The state records source SHA, versioned
commit SHA, version, tag ref and the exact recovery inventory. Artifacts from a
later rerun attempt cannot substitute for the original attempt's artifacts.
Pack inventory/digests and actual versioned tarballs are verified before
publication; the Git push is dry-run first. `begin-publishing` persists the
irreversible boundary before the first registry write.

The state branch uses Git compare-and-swap with a direct-parent commit and a
non-force ref update. Concurrent writers refresh and retry; permission/policy
failures are not treated as successful updates. Before publication, failure,
abort or deadline expiry can reopen through that CAS protocol. Authorization persists `publishing` before the final publisher is scheduled.
Consequently even a publisher runner delay or failure before its first npm write
requires original-owner recovery after the originating attempt terminates; it is
not proof that the window can safely reopen. The original 90-minute deadline
still gates authorization, and immutable artifacts retain their 30-day recovery
window. Once publishing
has begun, failure/timeout stays fenced in `recovery`; it never automatically
reopens just because a workflow finished or a deadline elapsed.

Completion verifies every expected tarball against
`https://npm.happyvertical.com/`, the exact protected main SHA and lightweight
version tag, and the release commit's source parent. Only then does it reopen.
The normal publisher must be the exact currently running original run/attempt
and consume a `publishing` state; it cannot publish a `recovery` state. Manual
recovery retains the separate requirement that the original attempt be completed.
Neither path transfers ownership or rebuilds packages. The primary registry gates reopening; npmjs mirroring runs independently
afterward and cannot extend the release fence. Direct/manual **Publish** does
not reserve its own window: with the flag enabled its `assert-window` must find
the exact owning run/attempt and frozen snapshot or publication stops.

## Reconciliation and recovery

For a stranded status grant, record its SHA, grant nonce, original controller
run ID/attempt and validation run from the state. Wait until the original
controller attempt is completed. Select **Release Admission → Run workflow →
command `ack-grant`**, supplying `grant-sha`, `grant-id`, `writer-run-id` and
`writer-run-attempt` exactly as recorded. The trusted controller verifies the
terminated writer independently and requires the exact nonce-bearing success
status from release App bot **244849939**, with the expected repository/SHA
URL and `Release Admission` context. It then acknowledges the saved grant
through CAS; it never reposts green or changes ownership.

A directly observed HTTP 4xx rejection of a success POST, excluding request
timeout (408), cancels only that request's exact saved grant and clears its
reuse identity. This includes quota
rejection (422) and missing permission (403); the command still fails and the
underlying quota/permission problem still needs correction. Request timeouts,
network failures, redirects, 5xx responses and malformed success acknowledgements leave the grant
unsettled because the write outcome is unknown. If an already exhausted SHA
cannot accept the pending revocation needed to drain, the window stays blocked;
the controller never treats rejection as successful revocation.

If that success was never recorded, its origin cannot be verified, or the
writer is still active, acknowledgement is refused. Keep the grant intact:
this is a concrete reviewed-recovery blocker, not permission to clear state,
force-update the state branch or disable required checks. A publication window
can time out safely before npm writes, but timeout does not prove an unknown
status write has stopped. Ordinary reconciliation never clears such a grant.

`workflow_run` callbacks carry the source run ID **and source attempt**. Events
can be dropped/coalesced, so the controller reconciles every ten minutes and on
manual `reconcile`, independently fetching the exact owner attempt and current
PR/queue heads. It does not replay stored stale queue heads or treat event JSON
as authenticated proof. A changed owner attempt needs reviewed recovery, not
silent takeover.

For a fenced partial publication, select **Release Admission → Run workflow →
command `recover`**, supplying `owner-run-id` and `owner-run-attempt` from the
state. These are the **original** Batched Release owner, not the recovery
executor's run/attempt. Recovery first verifies that the original attempt has
completed, preventing concurrent publication by the original runner. It then
fetches the bound immutable artifacts, verifies
their IDs/digests and original ownership, restores the original release commit
from its Git bundle even if that commit was never pushed, and resumes the
original tarballs. It must verify exact
primary publication and main/tag recording before reopening. It does not build
a new candidate, regenerate tarballs or change ownership.

If the bundle or any required pack artifact is expired, missing, ambiguous or
has a different digest, stop: this is a concrete manual recovery blocker. Keep
the fence closed and retain the state/owner, observed registry inventory and
ref identities for a reviewed repair. Thirty-day retention is a recovery
window, not a guarantee that lost artifacts can be regenerated identically.

## Evidence and remaining measurement

`validation-receipt.mjs` validates a future reuse proof; **cross-run validation
reuse is not enabled**. Similar PR, merge-group and release suites do not prove
equivalent source/artifact identity. Packed-consumer HTTP SSR checks and
versioned package/Planner checks remain meaningful gates. PostgreSQL retains
the `postgres-required` aggregate over every selected shard and fails on failed,
cancelled or unexpectedly skipped shards.

The #4306 baseline separates executor time, queue time and release scheduling.
Post-change end-to-end timings for metadata/export, shared runtime and
persistence are **pending activation and representative live runs**. Do not
report unit tests, targets or pre-activation workflow edits as measured latency
improvements. Record unchanged slow paths alongside any improvement.

## Verifier credential recovery

If the verifier key is suspected compromised, disable its two consuming jobs,
revoke the private key and uninstall its SMRT installation. Inspect the
organization audit log for that App's changes to rules, environments, deploy keys,
collaborators and settings; restore protections from owner-reviewed beforeimages.
Keep publication paused/fenced until repaired. Do not clear admission state,
force-update its branch or disable a served required context. Creating additional
audit infrastructure or changing organization-wide deploy-key policy requires its
own scoped decision; neither is implicitly authorized by this credential.
