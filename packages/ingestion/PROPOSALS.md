# Application-aware proposal generation

`@happyvertical/smrt-ingestion/proposals` is server-only. Configure
`IngestionOptions.proposals` and the existing `execution.handlers` catalog.
Handlers opt into discovery with `discovery.mediaTypes`, `references`, and an
optional `candidates` callback. There is one catalog: the same operation or
ordered playbook adapter is discovered, validated, previewed, and later applied
by the execution service. Generation never approves or applies.

## Discovery and authority

`listHandlers(itemId)` returns a bounded detached catalog. The owning execution
service checks the current principal, captured permissions/handler/operation
ceiling, policy, confidential scope, public registered operation facts, and
ordered playbook definition. Every configured provider must occur in the current
policy's `providers` allowlist. Missing grants remove handlers before model input.
An authorized catalog larger than the configured bound is rejected; the host must
narrow it explicitly instead of relying on silent truncation.

`findCandidates({itemId,handlerId,handlerVersion,query,limit})` returns
`{items,truncated}`. Its trusted handler callback receives `HandlerContext` with
the authorized transaction executor. Query by tenant and confidential scope
**before** selecting, ranking, or building labels. Use a bounded query (often
`limit + 1`) and report `hasMore`. The service projects candidate identity, model,
revision and label, then checks every target with the owning execution callback.
There are no hidden counts or pagination tokens. Truncated discovery forces
`needs_review` and cannot enter generated preview.

Completed generation reload checks process authority, the current attempt, and
owner/candidate visibility in the same final transaction. Database-backed grant
callbacks must use the supplied executor. The owning retention lifecycle encloses
that transaction so a denied read cannot roll back an authorized shorter privacy
ceiling; restoration starts only after the outer transaction has rolled back.

Candidate callbacks perform bounded database reads only: no provider I/O, network,
or domain mutations. Target locks and existing retention enforcement remain
owned by execution. Hosts configure their database's statement deadlines; an
arbitrary trusted callback is not a sandbox. Each existing-record argument must
be a declared top-level `references` field of kind `candidate` with its qualified
model, or `evidence`. Closed JSON argument schemas are required. The host owns
that declaration and its target authorization semantics.

## Durable stages

1. Complete extraction through the existing analysis ledger.
2. Call `prepareGeneration(itemId, extractionAttemptId)`. It reads the current
   completed/partial immutable extraction and returns configuration with
   `stage: 'interpret'`, pinned source attempt/revision/input/output/evidence
   digests, prompt/configuration/catalog/provider versions, limits and thresholds.
3. Pass that configuration to `analyze(itemId, configuration, requestKey)` and
   claim its new revision with `claimAnalysis`.
4. The host's existing job callback routes on the frozen `configuration.stage`:
   extraction invokes `extractAnalysis`; interpretation invokes
   `generateProposals(lease)`.
5. Reload the current completed generation using `getCompletedAnalysis(itemId)`,
   or pass an explicit attempt ID to additionally reject stale client state.
   Queued/running revisions never return an older completed attempt.

A generation revision does not rewrite terminal extraction. Reprocessing starts
with a new extraction revision, followed by interpretation, while the host keeps
the same business intention keys. An interrupted still-current generation lease
can be retried; terminal generation output remains immutable. `getGenerationInput`
reads historical extraction only through the current generation lease and its
frozen source pin. It verifies same-item scope, immutable hashes, durable evidence,
and current process permission before returning detached data. The source must be
the immediately preceding revision, so an intervening reprocess invalidates a
prepared generation. Completed generation reads additionally recheck current
catalog and target visibility before disclosing persisted candidate labels.
Expired, cancelled, revoked, retried or superseded workers cannot read or publish late output. The
current lease and each offered handler/candidate are rechecked immediately before
each outbound generative/decision boundary and before publication.

## Providers and validation

`createSDKProposalGenerator(client, identity, {maxTokens,timeoutMs})` uses an
existing AI SDK `chat` client. It sends a fixed system instruction and separate
JSON evidence/catalog data, requests JSON, supplies cancellation and bounds, uses
no tools or continuation, and rejects known truncation or tool calls,
unexpected models, malformed JSON and oversized output. Configure SDK clients
without automatic retry that would bypass application boundary checks. The
adapter's public identity is exactly provider/model/version; credentials and raw
provider errors are never provenance.

A trusted custom `ProposalGenerator` must likewise honor cancellation, bound its
response, and explicitly declare validated `complete` or `unknown` completion.
The SDK currently normalizes missing/unknown finish reasons to `stop`
([owning SDK follow-up](https://github.com/happyvertical/sdk/issues/1381)), so its
adapter conservatively declares `unknown`, persisted as
`generation_completion_unknown`. Otherwise valid suggestions remain available
for human preview; automatic eligibility always remains false. The service
deadline aborts requests and prevents late publication; it does not claim to terminate computation at a remote
provider or isolate native allocations. Extractor process limits remain separate.

Model output can contain only offered handler versions, schema-valid arguments,
retained evidence locations and offered alternative handler/candidate keys.
Candidate IDs must occur in the offered set, and evidence IDs in retained source
results. Unknown enums, invented IDs, extra authority/tool/approval fields and
malformed structures fail closed. Missing required top-level fields are retained
as `missingFields`, with `needs_review`; values are never invented to satisfy a
schema. Observed page/time/source granularity is preserved. Logical scan splits
use `proposeDocumentSplits`; originals and hashes remain intact.

`createSDKProposalDecisionClient(client)` adapts an existing SDK client’s optional
capability without changing its errors or protocol. Optional `decision` uses public core `executeDecision` and the existing SDK
predicate, choice, score and batch contracts. Supported-effect predicates,
handler classification, candidate entity matching, and action ambiguity/risk
are distinct questions. Their validated probabilities and provenance are stored
separately from generative provenance and unknown OCR certainty. The complete
serialized decision request, including suggestions and questions, must fit the
minimum configured/current policy byte ceiling before capability probing and
again before deciding. A policy change between these boundaries fails closed.
Ties, support probability or selected-handler confidence below
`minimumDecisionProbability`, and actually incomplete extraction require review.
Unknown provider
completion metadata is preserved as `source_completion_unknown`; it does not
block otherwise schema-valid **human** preview or imply completeness. Automatic
action eligibility remains false. An unconfigured decision path
is recorded explicitly. Configured errors produce a durable safe failure outcome;
they never silently switch to a generative decision fallback.

Output records zero, one or multiple suggestions, alternatives, missing fields,
source links, proposed splits, versions, allowlisted usage, warnings and explicit
`unknown`, `ambiguous`, `no_action`, `needs_review` or `provider_error` outcomes.
`automaticActionEligible` is always false. Provider input/output and the complete
serialized persisted envelope are bounded by configuration, live policy and the
receipt ceiling. Oversized output becomes a bounded review/limit result; when
no safe envelope fits, the owning service records fixed `failAnalysis` metadata
outside the provider payload budget without retaining provider output.

## Explicit preview and stable intentions

The host chooses persisted suggestion indexes and calls:

```ts
await service.previewGeneratedProposals({
  itemId,
  attemptId: generationAttemptId,
  selections: [{
    index: 0,
    intentionKey: 'document:meeting-2026-10-09',
    expectedRevision: 0,
    requestId: 'review-request-1',
  }],
});
```

`intentionKey` is the host's stable business-intention identity across generation
revisions. Never derive a fresh key from model output, suggestion order or a retry.
Selections must reference current persisted validated `ready_for_review` output.
Each batch requires distinct suggestion indexes and intention keys; duplicate
indexes are rejected before any operation or plan preview is written.
The service rechecks current catalog/schema/target/source provenance, then calls
the existing operation or plan preview. Each result still requires the ordinary
human review and execution APIs. Reprocessing creates no new business identity;
successful-action replay protection stays with execution.

## Evidence and limits

The test matrix is `docs/test-matrix/3673-ingestion-proposals.md`. SQLite and real
PostgreSQL suites exercise authority, revisions, abstention, hostile output,
compound proposals, split provenance and reviewed domain effects. The upload
reference composes authenticated multipart delivery of a generated embedded-text
PDF through the actual packaged PDF child, durable interpretation, and the existing
ordered ContentDocument draft/retained-asset plan. It checks duplicate delivery,
unauthenticated and foreign-tenant denial, explicit approval of both steps,
idempotent execution replay, page provenance, and unchanged original bytes.
The compound-email case uses a declared messages-owner snapshot fixture.

Local HTTP fixtures execute the actual AI SDK transport and cancellation contract.
Generative responses and the separate injected PDF split boundaries establish
deterministic orchestration, not model accuracy or OCR quality. No held-out routing
evaluation or automatic approval is claimed. Missing/unknown AI completion remains
explicit under [SDK #1381](https://github.com/happyvertical/sdk/issues/1381).
