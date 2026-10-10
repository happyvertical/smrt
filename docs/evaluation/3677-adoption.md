# Ingestion reference adoption checklist

The maintained reference demonstrates suggest/review workflows; the [measured
synthetic evaluation](3677-measured-evaluation.md) **did not meet supported-reference
quality gates and did not establish safety**. Neither reference action is approved
for automatic execution. The first production consumer, traffic volume, residency
and retention periods remain application-owner choices.

## Provision and configure

1. Use the package's supported SQLite or PostgreSQL deployment. Apply public
   migrations before constructing services; verify parity with `smrt db:status
   --parity`. Runtime `assertReady()` checks tables and never provisions application
   schema. The reference host's test-database provisioning is a fixture, not a
   production migration mechanism.
2. Configure the existing AssetRuntime/store and derived-data purge callback.
   Bind authenticated tenant, actor and confidential scope in trusted host code;
   never accept those grants from source text or model output. Current grant
   resolvers must use the supplied transaction executor and intersect the captured
   ceiling with live policy. See the [service contract](../../packages/ingestion/README.md).
3. Configure each [source adapter](../../packages/ingestion/README.md#configured-source-adapters)
   with delivery identity, replay/age limits, retention, byte/media limits and
   trusted binding resolution. Use the actual email/watch-folder adapters when
   selecting those sources. The maintained camera/audio UI selects files; it does
   not prove physical device capture. Video remains unsupported.
4. Configure existing PDF/OCR/speech/AI providers with residency and resource/cost
   limits. Native extraction needs a real host-enforced memory boundary and
   killable workers; a timeout promise is not memory isolation. Preserve original
   bytes and page/time provenance. Unsupported/malformed/provider failures remain
   inspectable. Confidence, boxes, completion and usage absent from SDK contracts
   stay unknown. See [extraction](../../packages/ingestion/EXTRACTION.md).

## Author handlers and review

5. Start from the maintained [reference handlers](../../packages/ingestion/reference/handlers.ts).
   Register application-specific handler IDs/versions and read-only discovery
   callbacks through the existing execution catalog. Do not create another
   registry or infer executable intention identity from model order. Require
   schema-valid arguments, explicit stable host intention keys and fresh readable
   targets. See [execution](../../packages/ingestion/agents/execution.md) and
   [proposal generation](../../packages/ingestion/PROPOSALS.md).
6. Route analysis jobs by frozen stage/configuration using the existing jobs
   target. Preserve generation attempt/input/output provenance and explicit
   abstention. Preview does not approve/apply. Mount the authenticated
   [review host/components](../../packages/ingestion/REVIEW.md), preserving exact
   revision/review-version/binding hashes, reviewer authority, assignment,
   origin/CSRF protection and stale-tab reload semantics.
7. Keep both reference actions human-reviewed. An approval is a fresh scoped
   decision, not a correctness label or enduring grant. Execution revalidates
   current handler/target/source-example policy. External unknown outcomes require
   the handler's reconciliation contract; never manufacture success or blindly
   repeat effects. Existing action IDs and successful result identities survive
   reprocessing and retry.
8. Enable [feedback](../../packages/ingestion/FEEDBACK.md) only with explicit bounded
   configuration. Correctness judgments stay separate from approval/application
   events. Retrieval rechecks tenant, confidential scope, retention, current source
   and receiver policy. Examples do not add candidate authority or approval.
   Routing-policy adoption is explicit/versioned; no cross-tenant learning or
   automatic policy expansion is supplied.

## Operate and release

9. Run the owning package's documented SQLite/PostgreSQL, provider, component,
   browser, type and build gates against the chosen host. Exercise duplicate
   deliveries, crash/restart, concurrent review, stale grants, deletion and
   external unknown outcomes. Schedule `repairDispatches`, `repairDeletions` and
   `sweepRetention`; retain visible failure states and continue cleanup sweeps for
   the retained namespace. Purge host caches/indexes alongside owning privacy
   deletion; do not resurrect expired delivery IDs.
10. Evaluate a separately frozen, representative heldout corpus before making a
    supported-handler claim. Report exact counts, family uncertainty, unknown
    safety observations and trustworthy actual costs separately from reservations.
    This run's opened synthetic families are not unseen test data for prompt
    tuning. Keep suggest/review usable when a quality gate fails; do not choose a
    nearest category merely to avoid abstention. A future automatic path needs its
    own preregistered harm bound, confidence level, sample-size justification and
    explicit per-action policy. The current evaluation authorizes none.

The [behavior matrix](../test-matrix/3677-ingestion-evaluation.md) distinguishes
real adapter/transport/database/browser evidence from measured recognition quality.
The portable evidence export reproduces the frozen scores without provider calls.
