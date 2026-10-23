# Application-aware proposal generation

`@happyvertical/smrt-ingestion/proposals` is server-only. Configure
`IngestionOptions.proposals` and the existing `execution.handlers` catalog.
Handlers opt into discovery with `discovery.mediaTypes`, `references`, and an
optional `candidates` callback. There is one catalog: the same operation or
ordered playbook adapter is discovered, validated, previewed, and later applied
by the execution service. Generation never approves or applies.

Credential-free review hosts may configure `IngestionOptions.proposalRead` with
`ProposalReadConfiguration`: public generator/decision identities, version,
prompt version, limits and thresholds only. It reads completed proposals,
preserves current authority and snapshot validation, and permits human preview;
it never accepts a generator or provider client. If a process supplies both
settings, their public configuration must match exactly. Preparing or generating
proposals still requires `proposals` with a real generator.

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
`needs_review`; a person may still preview it explicitly, and automation never
becomes eligible.

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

`analyze` refuses an interpretation configuration whose pinned source is not
the item's latest extraction, checked under the item lock before anything is
superseded (`GenerationSourceStaleError`, nothing appended). A preparation
superseded by a later extraction therefore fails at append time rather than
after a revision was created.

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

When the pinned extraction carries an authenticated reviewer instruction
(REVIEW.md), `prepareGeneration` copies it into the interpretation configuration
and `generateProposals` verifies that copy against the extraction record and its
own digest before provider disclosure (`integrity` otherwise). The prompt then
carries it in its own **trusted reviewer guidance** section after the fixed
system instruction and handler contract: the guidance is named as authenticated
human input, limited to the offered catalog, and the evidence remains untrusted
data. `GenerativeProposalInput.reviewerInstruction` exposes `{id, text}` to custom
generators; `provenance.reviewerInstruction` records `{id, digest}`. The
instruction never changes `offered`, `catalogDigest`, argument schemas,
permissions or `automaticActionEligible`; a reply that follows guidance outside
the catalog fails validation like any other hostile output. **Budget cost:** the instruction counts once against the input budget
(`maxInputBytes`, each offered handler's `maxBytes` and the live policy
ceiling), as its JSON-escaped text inside the prompt's guidance section — up
to 4,000 characters plus escaping and the fixed guidance sentence. The
`reviewerInstruction` field duplicated for custom generators is not counted
again. The decision stage also carries it once: its request state holds the
evidence-side input with the un-guided base instructions under `evidence`, and
the guidance only under a separate `reviewerGuidance` key, never under
`evidence`; the decision budget measures that serialized request as sent. Size `maxInputBytes` with that headroom. Learned examples are
still retrieved for an instructed generation; only a logical split correction
suppresses them. Every instruction costs a fresh extraction revision before the
new interpretation: the predecessor-pin contract above (source = immediately
preceding revision, current-revision reads) is deliberately left intact rather
than reused for a same-source second interpretation, so OCR/speech hosts budget
one extraction per instruction, as for split corrections.

Model output can contain only offered handler versions, schema-valid arguments,
retained evidence locations and offered alternative handler/candidate keys.
Candidate IDs must occur in the offered set, and evidence IDs in retained source
results. Unknown enums, invented IDs, extra authority/tool/approval fields and
malformed structures fail closed. Missing required top-level fields are retained
as `missingFields`, with `needs_review`; values are never invented to satisfy a
schema. Observed page/time/source granularity is preserved. Logical scan splits
use `proposeDocumentSplits`; originals and hashes remain intact.

A rejected reply ends the attempt as `provider_error` with the `malformed_output`
warning and a bounded, value-free `provenance.failure` `{category, reason}` (#4207).
The reason lists schema-owned paths, keywords and schema constants, for example
`/outcome enum (allowedValues=proposals|unknown|...)` and
`/suggestions/0 required (missingProperty=evidence)`, or the fixed internal check
and its path, such as `Unoffered handler: /suggestions/0`. Path segments are
kept only when they are keys declared under the schema's `properties` or
indexes into a value that actually is an array in the rejected reply; any other
segment, numeric or not (for example a key under an open
`additionalProperties` argument sub-schema, or a numeric key of an object),
becomes `?`, and an extra property's name is never echoed.
It never contains document text, argument values, evidence content or
model-chosen keys, is cut at 1000 characters,
and is dropped before the output-limit fallback. Hosts read it from the
completed/partial analysis at `analysis.result.output.proposals.provenance.failure`.
The SDK adapter constrains replies with a `json_schema` response format built
from the validator's schema and the fixed instructions describe the shape; a
custom `ProposalGenerator` receives no schema, so its raw reply meets the
validator directly and the same reason is recorded.

`createSDKProposalDecisionClient(client)` adapts an existing SDK client’s optional
capability without changing its errors or protocol. Optional `decision` uses public core `executeDecision` and the existing SDK
predicate, choice, score and batch contracts. Supported-effect predicates,
handler classification, candidate entity matching, and action ambiguity/risk
are distinct questions. Their validated probabilities and provenance are stored
separately from generative provenance and unknown OCR certainty. The complete
serialized decision request, including suggestions and questions, must fit the
minimum configured/current policy byte ceiling before capability probing and
again before deciding. A policy change between these boundaries fails closed.
Actually incomplete extraction always requires review. Unknown provider
completion metadata is preserved as `source_completion_unknown`; it does not
block otherwise schema-valid **human** preview or imply completeness. Automatic
action eligibility remains false. An unconfigured decision path
is recorded explicitly. Configured errors produce a durable safe failure outcome;
they never silently switch to a generative decision fallback.

### Decision readiness gate (#4209)

For every suggestion `i` the request asks `supported_i` (predicate),
`route_i` (choice over the offered `handlerId@version` keys plus `none`),
`risk_i` (ordered score over `clear`, `uncertain`, `ambiguous`) and one
`entity_i_<field>` choice per candidate-reference argument. The validated
answers are always persisted under `provenance.decision.answers`. With the
default `decisionReadiness: 'gate'` they are read as follows, and any failing
check sets the suggestion to `needs_review` (a tie also sets the outcome to
`ambiguous`):

- `supported.probability >= minimumDecisionProbability` (default `0.8`).
- `route.choice` equals the suggestion's own `handlerId@handlerVersion`,
  `route.confidence >= minimumDecisionProbability`, and the gap between the two
  largest route probabilities is greater than `tieMargin` (default `0.1`).
- `risk.score < 1`: only the `clear` level passes; `uncertain` and `ambiguous`
  require review.
- Each entity match chooses the suggested candidate's key with confidence at or
  above the threshold and a gap above `tieMargin`.

These values are provider outputs read as if they were calibrated
probabilities; nothing in this package calibrates them for this use. The
teamworks-os measurement in #4209 (self-hosted Laya `typed-decisions`) found no
separation between right and wrong suggestions: a correctly read vendor invoice
scored `supported` 0.37, garbage input 0.45–0.50, a wrongly proposed purchase
order 0.51, route confidence 0.003–0.15 and `risk` ≥ 0.94, so the gate sent
every suggestion to review. Until a labelled sample shows separation, treat the
answers as diagnostics and configure:

- `decisionMaxLen`: positive integer forwarded unchanged as the per-request
  `maxLen` of the decision client (the SDK Laya provider's token window; the
  checkpoint default is 1024 and the serialized evidence plus suggestions is
  otherwise truncated). Other clients ignore it.
- `decisionReadiness: 'record'`: the decision still runs, is bounded and
  authorized exactly as before and its answers, usage, `readiness` and `maxLen`
  are recorded, but the gate never changes `outcome` or `disposition`; readiness
  comes from the validator alone (`missingFields`, outcome, source completeness).
  A client error or timeout is recorded as the `decision_unavailable`
  warning. A reply that comes back and then fails the core `executeDecision`
  identity or answer-shape check is recorded as `decision_malformed` with the
  reply's usage; this is the path for injected `DecisionClient`s. SDK clients,
  including the Laya provider behind `createSDKProposalDecisionClient`,
  validate the reply's shape inside `client.decide` and throw, so a malformed
  SDK reply is recorded as `decision_unavailable` with no usage. Every case
  records the `provenance.decision` identity. The generated suggestions stay
  as they were. The serialized request exceeding the byte budget is a
  configuration failure, not a provider answer: it ends the attempt as `limit`
  in both modes, and in `gate` mode every failure above still ends the attempt
  as `provider_error`. Lease, catalog, policy and provider-allowlist revocation
  fail closed in both modes.

Successful output also records `provenance.decision.readiness` (`'gate'` or
`'record'`) and `maxLen` when set; configuration digests are unchanged, but
persisted output is therefore not byte-identical to earlier releases.

Both settings are public configuration: they are part of
`ProposalReadConfiguration`, the frozen `GenerationStageConfiguration.proposals`
(present only when set, so existing digests are unchanged) and the completed
snapshot authority check. Invalid values fail at proposal service construction.
Neither mode affects automation: `automaticActionEligible` stays `false`, and
`authorizeAutomatic` reads only the host's `evaluateAutomatic` callback and
policy, never these answers.

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
Selections must reference current persisted validated `ready_for_review` or
`needs_review` output (#4208); a `provider_error` attempt, an unoffered handler or
a non-interpretation stage is rejected. A `needs_review` suggestion whose
`missingFields` are still absent fails the handler schema inside the ordinary
preview (`Invalid handler payload`) and publishes nothing; the reviewer supplies
the missing values through the explicit human path (`previewProposal` /
`previewPlan`, as the published review host does for `preview({args})`), and the
handler's `validate` and `preview` run again on the completed arguments.
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

Proposal limits are checked at `IngestionService` construction: positive safe
integers, at most 20 handlers/candidates/suggestions and 2147483647 ms timeout.
Interpretation output uses the exported `GenerationAnalysisOutput` wrapper at
`analysis.result.output.proposals`; the published review host unwraps it.
An explicit feedback `retrieve` denial omits optional examples and feedback
provenance and continues generation. Item/execution denials, unexpected failures,
and revocation after examples were selected still fail closed before disclosure.
