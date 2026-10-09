# Ingestion reference evaluation (GitHub #3677)

This directory owns independent evaluation artifacts, not another ingestion stack.
The application handlers remain in `reference/handlers.ts`; source, extraction,
proposal, review and feedback behavior must use their owning public APIs.
Implementation is in progress. No paid inference or quality result is recorded here.

## Freeze and provenance

`protocol.json` is the preregistered design. `corpus/v1/families.json` contains 75
authored originating scenario/template families. All 20 near variants of a family
stay together: 15 training, five development and five held-out families per class.
The resulting 1,500 cases have 100 held-out draft, 100 attachment and 100 abstention
labels. These counts do **not** mean 300 independent observations. There are only
five held-out families per class. Primary uncertainty is the exact family summary
and observed range. Preregistered stratified family-cluster bootstrap percentile
95% intervals use seed 3677 and 10,000 resamples of whole families within expected
action classes, summing metric counts. Undefined ratios are counted explicitly;
intervals over remaining ratios are conditional. With five families per class these
are exploratory, poorly estimated intervals, not robust population guarantees.
Nominal case Wilson intervals assume independence and are
only descriptive. This narrow synthetic distribution cannot establish deployment
or automatic-action safety. Both reference actions always require human review.

Each readable family renders ten message texts, six embedded-text PDFs, two skewed raster
images and two intelligible synthetic speech WAVs. The unreadable families instead contain actual corrupt PDF/image/audio bytes and
are labeled as a separate deterministic-fault lane. Required held-out subtypes are
unknown category, ambiguous match, unreadable material, prompt injection and
confidential scope; each has its own family and 20 cases. Exact media counts come
from the materialized manifest. Images are authored raster documents,
not camera photographs; speech is synthesized, not a human recording. The limited
image/audio and family counts must appear alongside all measured results.

`generate-corpus.mjs` materializes source bytes and a full manifest outside Git.
It records family/generator hashes, exact source hashes and byte lengths, labels,
candidates, authored source text, tool versions and single-author annotation
provenance. Independent semantic adjudication is explicitly pending; mechanical
validation is not human adjudication. The checked-in compact index records 75 family digests/counts and the complete manifest SHA256; each family digest binds every case source hash, label, candidate and partition. The full manifest and media are reproducible artifacts, not required opaque Git rows. The current candidate materialization is not yet frozen;
root freeze and paid-run approval remain pending. Pin/record the actual Nix closure for ImageMagick, espeak-ng and
fonts when generating. Never silently regenerate a different corpus under a frozen
version. Reproduction must match the full manifest hash and every source hash.
No generated media directory belongs in Git.

Corpus generation uses the repository's required Node 26.10.0:

```sh
fnm exec --using=26.10.0 node packages/ingestion/evaluation/generate-corpus.mjs EXTERNAL_CORPUS_DIRECTORY INDEX_FILE
```

The host supplies `magick` and `espeak-ng` on PATH and explicitly sets
`EVALUATION_FONT_FILE` to the font file whose SHA256 is recorded in the manifest. Nix can provide these authoring
tools without replacing the documented Node/pnpm toolchain. Freeze the protocol,
family definitions, generator, compact index and run-profile digests before any
prompt fitting or held-out inference. Edited prompts cannot retrospectively change
labels, exclusions, matching rules or partitions.

## Aggregate budget boundary

`budget.mjs` uses Node's SQLite API for a **separate runner-owned accounting file**.
It never creates application schema or touches SMRT registry/models. All concurrent
processes, stages, development probes, retries and reruns must use the same absolute
ledger path for this authorized USD5 evaluation:
`/home/will/Work/tmp/smrt-epic-3668/evaluation-budget.sqlite`. Test fixtures use
separate temporary databases. Changing a run/model/corpus hash never resets the
live aggregate ceiling. It uses integer nano-USD, SQLite
`BEGIN IMMEDIATE`, full synchronous commits and a fixed USD5 ceiling. The host must
protect and retain this file and its WAL across restarts. Deleting/copying the ledger
or switching paths does not create new spending authorization. Do not place it on
an unsupported/network filesystem or run separate per-stage ledgers.

Reserve a defensible maximum **before** every network call. One unique call identity
can invoke at most once through `runReservedCall`; it cannot be replayed after a
crash because remote work may already have happened. A retry needs a new identity
and a new full reservation. The ledger performs no retries or transport calls itself.
The host must verify that the owning SDK has no hidden retries, continuation or
unmetered probes. Unknown usage, thrown requests, cancellation and crash retain the
full amount. Only a trusted adapter's final verified actual charge releases unused
reserve. A provider charge exceeding its bound halts further reservations and persists the
verified overrun and fixed failure reason. Snapshots expose known actual charges
and total accounted exposure separately from retained reservations; halted
ledgers report zero spendable remainder. The
retained ceiling is a conservative accounting upper bound, never reported as actual
usage. A violated provider bound means the original hard-bound premise failed;
local code cannot undo external charges.

No API key, provider response, source text or arbitrary metadata belongs in the
ledger: only call/stage identifiers, immutable request/run hashes and integer charges.
The runner is a trusted-host tool, not an authorization boundary against malicious
host code. Application grants/tenancy remain owning service responsibilities.

The selected profile is OpenAI `gpt-5.4-mini-2026-03-17` for vision/proposals and
`gpt-4o-mini-transcribe-2025-12-15` for audio (authenticated nonbillable
model-metadata GET returned the matching ID on 2026-10-09). Paid provider inference is **not authorized**. Before
root authorizes paid calls, verify current published prices, exact installed SDK
versions/options, complete serialized request/media token upper bounds, output
ceilings, zero hidden retries, host memory/resource isolation and the aggregate
conservative run bound. Duration-based speech pricing is an estimate and is not
accepted alone as a hard bound. Unsupported/unknown bounds refuse a call.
Missing OCR usage/completion and normalized AI stop metadata remain unknown under
[OCR #144](https://github.com/happyvertical/ocr/issues/144) and
[SDK #1381](https://github.com/happyvertical/sdk/issues/1381).

## Acceptance evidence

The evaluation Vitest config uses `smrtVitestPlugin`. `pnpm test:evaluation` runs the tooling contracts; it is not a measured
provider-quality gate.
Contract tests exercise hashes, grouping, scoring, persistent reservation and real
concurrent SQLite writers without provider inference. They cannot measure quality.

Final #3677 acceptance still requires actual merged UI/feedback contracts; real
upload/watch/email/camera/audio → extraction → proposal → authenticated review →
reference effect → correction → later suggestion composition; both application
SQLite/PostgreSQL; real browser/reload/retry/tenant/confidential/deletion coverage;
and the measured held-out run under the one USD5 ledger. Failed/missing gates must
be reported with exact denominators and observed limits. No reference quality or
automation claim follows merely from a valid corpus or a passing tooling suite.

System abstention may count only with the exact authoritative structural proof
preregistered in `protocol.json`: the frozen expected unreadable/unsupported reason,
current owning attempt/state/digests/source hashes, verified persisted provenance,
no eligible proposal or action and no model invocation. Generic provider errors,
timeouts, budget refusals and missing results remain failures. If owning APIs only
return a generic failure for a corrupt source, the evaluator cannot upgrade it to
a structural success. Model abstention and deterministic fault outcomes are
reported separately.

## Reconstructing the corpus artifact

A checkout contains the authored families, deterministic generator, pinned toolchain
record and compact index. Use `corpus/v1/toolchain.json` to provision the recorded
Nix source, eSpeak and font, then run the generator into a fresh external directory
and a temporary index. Compare that index with the checked-in index and run
`audit-materialization.mjs INDEX_FILE EXTERNAL_CORPUS_DIRECTORY REPORT_FILE`. The full manifest
SHA256 and all 75 family digests must match before using the bytes. This route does
not depend on the original developer's temporary directory. Final evaluation
publication must retain the full manifest, measured predictions and budget report
as immutable report artifacts identified by hashes; an unavailable artifact must
not be replaced by silently regenerated differing bytes.

The draft schedule disables the optional decision provider. Results concern the
generator, owning validation and explicitly reviewed effects, not independent model
decision quality. The $0.40 feedback demonstration reserve is inside the same $5
aggregate ledger. Cohorts and controls must be frozen before any paid call; zero
paid calibration, retries or reruns are scheduled.

## Maintained consumer and native host boundary

`ReferenceReviewHostOptions` supplies trusted deployment-only database, proposal
policy/generator and extraction configuration. Request bodies cannot set these
options; existing actor, tenant, confidential scope, principal, permissions and
human approval checks remain the owning gates. Defaults preserve the browser
fixture. Feedback adds its separate optional host configuration through its owner.

Before any paid SDK construction, the final runner must call `assertNativeScope()`
inside a systemd user scope with `MemoryMax=2147483648` and `MemorySwapMax=0`.
This is a **2 GiB aggregate ceiling for the evaluation host and inherited child
processes**, with sequential execution/concurrency one. It is not a 256 MiB
per-worker native memory claim. Kernel controls are read from the actual process
cgroup; absent or different controls fail closed. The canonical SQLite budget file
lives outside the process lifetime and survives an OOM kill with reservations intact.

`budgetExtractionAdapter` verifies frozen bytes/hash/media, PNG dimensions, PCM
speech duration and extraction configuration before entering the owning adapter.
Its composed public `beforeProviderCall` first rechecks owning authority, commits
a reservation, then acknowledges the child. OCR permits exactly two freshly
authorized gates per request (capabilities, then extraction), with one reservation
before the first gate and one actual HTTP call. Speech permits one gate. A third
OCR gate, repeated speech gate, or restarted request with the same paid identity
cannot acknowledge another invocation. Local unpdf permits at most
`2 + 2 * maxPages` authorized gates without a paid reservation. Unknown/error/timeout charges
retain the full bound. PDF is deliberately pinned to local unpdf with no paid OCR
fallback. The factory omits OCR, vision and speech configuration for PDF/text;
actual blank/scanned PDF child tests with ambient credentials prove zero HTTP and
zero reservations. Removing that restriction sends an unreserved HTTP request in
the regression baseline. Source metadata and text have no paid extraction route.

Corpus identifiers are logical labels. `freezeCaseIdentity` records an exact
bijection to actual database/evidence UUIDs after receipt and before provider I/O;
its immutable hash-bound artifact is retained per case. Comparison uses only the
recorded inverse mapping. Unknown model IDs are failures, never fuzzy matches or
newly invented mappings.


The separate actual-child transport proof requires those native controls and only
uses loopback HTTP fixtures (no inference): from `packages/ingestion`, run
`systemd-run --user --scope --quiet -p MemoryMax=2147483648 -p MemorySwapMax=0 fnm exec --using=26.10.0 pnpm exec vitest run --config evaluation/vitest.providers.config.ts`.
It checks durable reservation before HTTP, authority denial, exact OCR/speech
request counts, retained failure exposure and same-identity restart denial.

## Frozen runner

Run the TypeScript entry with the owning `pnpm exec tsx evaluation/run.ts` command
from `packages/ingestion`. The `prepare CORPUS FEEDBACK PROFILE EXTERNAL_RECEIPT`
mode verifies materialized corpus hashes, the fixed feedback schedule, installed
versions, source/build receipts and aggregate call bounds. It writes a receipt
with `authorizesPaidCalls: false`; preparation makes no provider requests.

The `run CORPUS FEEDBACK PROFILE RELEASE EXTERNAL_OUTPUT` mode additionally requires
the coordinator's external frozen release receipt, the inspected empty canonical
ledger and the verified native cgroup. It executes sequentially without retries.
The checked-in draft profile does not authorize inference. A changed profile,
source tree, build tree or corpus invalidates the release receipt.

The feedback cohort shares one retained database across its three training cases
and eight counterbalanced heldout arms. Only training judgments become examples;
heldout judgments are never recorded. Contexts run sequentially and release the
reference worker pointer before closing their owning database. Raw offers remain
separate from scripted review using the agent-authored synthetic oracle. This is
not an observed human review session, and review time is not a human-effort metric.

The known generic failures on 20 corrupt heldout cases remain failures in the
abstention denominator. Therefore the current contract cannot meet the ADR's 95%
system-abstention gate. A measured report must withhold the supported-reference
and automation claims even if other routing metrics pass. Suggest/review remains
available under its existing authorization and explicit approval requirements.

Source coverage distinguishes the actual entry contracts. Watchfolder and email
composition use their owning adapters; email goes through the released SDK MIME
parser and public `EmailAccount` snapshot with a deterministic transport fixture.
The maintained mobile browser selects image/audio files and renders their retained
originals. Evaluation PNG multipart requests carry camera source metadata, while
WAV requests carry audio metadata; neither is proof of physical camera or microphone
capture. No `getUserMedia` or real-device claim is made. Scanned/mixed PDF and TIFF
coverage is inherited adapter correctness evidence, not this paid corpus's measured
recognition quality.

`scoreStrata` additionally reports descriptive action-class, media and required-coverage subtype counts/metrics, retaining failed and missing cases in each intended denominator. These overlapping descriptive strata do not replace the overall preregistered gates or family-cluster uncertainty. The final report records `supportedReferenceClaim: false` for the known unmet abstention gate.

Transport metadata uses a stable opaque SHA256 capture ID and generic
`source.<format>` filename. Semantic case/group identifiers remain only in the
internal capture-identity artifact and scorer manifest, never the model-facing
capture metadata. Original authored text and candidate document titles remain
unchanged: named attack scenarios and explicit draft/attachment instructions are
highly simplified synthetic cues. Results measure this frozen distribution and
cannot establish real-world recognition quality or automation safety.

Preparation also records the exact Git HEAD and whether tracked or untracked
implementation changes remain. Dirty preparation is diagnostic only. Paid release
and execution require the same clean committed HEAD, binding the tracked owning
package context as well as the source/dist receipts; the run hash includes that
HEAD. Reports and receipts stay outside the worktree during execution. A later
report-only commit references the frozen execution HEAD rather than trying to put
its own self-referential commit identity in the profile.

## Measured result

The [2026-10-09 measured report](../../../docs/evaluation/3677-measured-evaluation.md) includes a portable hashed evidence export and offline score reproduction. Four accuracy gates failed; measured safety is unknown. Feedback was 0/4 baseline and 0/4 treatment. Supported-reference acceptance and automation remain disabled. Conservative exposure was $4.71927; actual charges are unknown. The completed run must not be repeated under its consumed release.

The [adoption checklist](../../../docs/evaluation/3677-adoption.md) covers production migrations, trusted sources/providers, handler authoring, review, retention/recovery and explicit release limits.

Projected predictions are flushed to `projected-prediction.json` before any
scripted preview/review/effect. `case-observations.json` records bounded stages and
reasons separately; exception text is never persisted. Later receipt/cleanup
failures recover the original offers, keeping precision denominators independent
of review success. Explicit duplicate-effect observations fail safety even when
other counters remain unknown. The historical measured export predates this fix;
its documented limitation and original scores remain unchanged.
