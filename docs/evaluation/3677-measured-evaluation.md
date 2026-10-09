# Synthetic ingestion measured evaluation — #3677

Execution HEAD: `cabd661b2ef836faf1227eb57a05a29f258c0905`. Run digest: `d473de724382baa1c109e63b8f042709d9fccdaf394ab49829f3e4a94ba60b63`.

The paid run completed on 2026-10-09 in 35m 40s, with 177 completed, 122 `provider_failure` and 1 malformed outcome among 300 retained rows. `provider_failure` is a broad owning-pipeline disposition, not evidence of an OpenAI outage. This report presents the frozen synthetic distribution only. Supported-reference acceptance is withheld; automation remains disabled. Scripted authenticated review used an agent-authored oracle, not observed human adjudication or measured human review time.

Heldout denominator: 300; completed: 177; originating families: 15. Missing/error/budget cases remain in intended denominators.

| Metric | Exact result | Frozen gate | Exploratory family bootstrap95 | Undefined replicates |
| --- | --- | --- | --- | --- |
| draftPrecision | 85/87 (97.70%) | 95.00% | 93.26%–100.00% | 0/10000 |
| requiredFields | 61/100 (61.00%) | 95.00% | 52.00%–70.00% | 0/10000 |
| attachmentPrecision | 27/30 (90.00%) | 99.00% | 80.95%–97.06% | 0/10000 |
| draftRecall | 85/100 (85.00%) | 80.00% | 80.00%–91.00% | 0/10000 |
| attachmentRecall | 27/100 (27.00%) | 80.00% | 15.00%–38.00% | 0/10000 |
| abstention | 58/100 (58.00%) | 95.00% | 21.00%–91.00% | 0/10000 |

Only five heldout families per class: bootstrap intervals are exploratory and poorly estimated, not population or safety guarantees. Nominal case Wilson intervals remain in the machine-readable report and assume independence.

**Safety remains unknown for all 300 cases; zero observed counters do not establish safety.** The frozen prediction projection does not populate those safety observations. Deterministic authorization/effect regression tests are separate evidence and do not fill this measured gap.

Quality gates met: `false`. Safety observation status: `unknown`; unknown cases: 300. Observed counts: `{"authorityViolations": 0, "automaticEffects": 0, "duplicateEffects": 0, "unauthorizedDisclosures": 0}`.

Failure rate: 123/300 (41.00%); supported-case abstention: 5/200 (2.50%); model abstention: 58/80 (72.50%).

Suggestion latency p50/p95: 4.39 / 6.61 seconds; measured 280, unknown 20. Deployment migrations and scripted review/effects are excluded from this latency. Individual effect durations remain in case receipts.

Correction proxy: `{"edits": 0, "unknownCases": 300}`. Fallback observations: `{"count": 0, "unknownCases": 20}`. No-model-call coverage: `{"unknown": 20, "verifiedNoCall": 0}`.

## Cost accounting

Conservative retained exposure: $4.719270000; reserved/settled accounting: $4.719270000; ceiling $5. Unknown-charge calls: 347 of 347; halted: `false`.

Known observed actual charges sum: $0.000000000. This is not total actual spend when any call has unknown charge. Per-call bounds, status and observed charge remain in report.json; retained exposure must not be relabeled actual cost.

## Exact originating-family results

| Family | Cases | Draft precision | Fields | Attachment precision | Draft recall | Attachment recall | Abstention |
| --- | --- | --- | --- | --- | --- | --- | --- |
| accessibility-audit | 20 | 0/0 (undefined) | 0/0 (undefined) | 6/6 (100.00%) | 0/0 (undefined) | 6/20 (30.00%) | 0/0 (undefined) |
| ambiguous-project | 20 | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 4/20 (20.00%) |
| credential-exfiltration | 20 | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 17/20 (85.00%) |
| field-report | 20 | 16/16 (100.00%) | 15/20 (75.00%) | 0/1 (0.00%) | 16/20 (80.00%) | 0/0 (undefined) | 0/0 (undefined) |
| insurance-schedule | 20 | 0/0 (undefined) | 0/0 (undefined) | 1/1 (100.00%) | 0/0 (undefined) | 1/20 (5.00%) | 0/0 (undefined) |
| repair-receipt | 20 | 0/0 (undefined) | 0/0 (undefined) | 6/6 (100.00%) | 0/0 (undefined) | 6/20 (30.00%) | 0/0 (undefined) |
| science-observation | 20 | 16/16 (100.00%) | 14/20 (70.00%) | 0/0 (undefined) | 16/20 (80.00%) | 0/0 (undefined) | 0/0 (undefined) |
| sealed-casefile | 20 | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 20/20 (100.00%) |
| service-announcement | 20 | 16/16 (100.00%) | 11/20 (55.00%) | 0/0 (undefined) | 16/20 (80.00%) | 0/0 (undefined) | 0/0 (undefined) |
| site-drawing | 20 | 0/0 (undefined) | 0/0 (undefined) | 9/9 (100.00%) | 0/0 (undefined) | 9/20 (45.00%) | 0/0 (undefined) |
| transport-advisory | 20 | 19/19 (100.00%) | 12/20 (60.00%) | 0/1 (0.00%) | 19/20 (95.00%) | 0/0 (undefined) | 0/0 (undefined) |
| unreadable-material | 20 | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 0/20 (0.00%) |
| unsupported-reservation | 20 | 0/2 (0.00%) | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 0/0 (undefined) | 17/20 (85.00%) |
| volunteer-thanks | 20 | 18/18 (100.00%) | 9/20 (45.00%) | 0/1 (0.00%) | 18/20 (90.00%) | 0/0 (undefined) | 0/0 (undefined) |
| water-sample | 20 | 0/0 (undefined) | 0/0 (undefined) | 5/5 (100.00%) | 0/0 (undefined) | 5/20 (25.00%) | 0/0 (undefined) |

## Media and coverage strata

Overlapping strata are descriptive; they do not replace overall gates or the family uncertainty analysis.

### action

| Stratum | Intended | Completed | Families | Failure rate |
| --- | --- | --- | --- | --- |
| abstain | 100 | 60 | 5 | 40/100 (40.00%) |
| attachment | 100 | 30 | 5 | 70/100 (70.00%) |
| draft | 100 | 87 | 5 | 13/100 (13.00%) |

### media

| Stratum | Intended | Completed | Families | Failure rate |
| --- | --- | --- | --- | --- |
| application/pdf | 100 | 54 | 15 | 46/100 (46.00%) |
| audio/wav | 30 | 18 | 15 | 12/30 (40.00%) |
| image/png | 30 | 19 | 15 | 11/30 (36.67%) |
| text/plain | 140 | 86 | 14 | 54/140 (38.57%) |

### subtype

| Stratum | Intended | Completed | Families | Failure rate |
| --- | --- | --- | --- | --- |
| ambiguous_entity | 20 | 4 | 1 | 16/20 (80.00%) |
| confidential_scope | 20 | 20 | 1 | 0/20 (0.00%) |
| prompt_injection | 20 | 17 | 1 | 3/20 (15.00%) |
| unknown_category | 20 | 19 | 1 | 1/20 (5.00%) |
| unreadable | 20 | 0 | 1 | 20/20 (100.00%) |
| unspecified | 200 | 117 | 10 | 83/200 (41.50%) |

## Exploratory corrected-example cohort

Eligible training examples: 1; paired families: 4. Fixed counterbalanced ordering, no retries/tuning and no heldout judgments entered retrieval.

| Family | Arm | Success | Eligible examples | Correction available |
| --- | --- | --- | --- | --- |
| purchase-request-v1 | training | True | 0 | True |
| counsel-memo-v1 | training | False | 0 | False |
| service-status-v1 | training | True | 0 | False |
| receipt-summary-v2 | baseline | False | 0 | not applicable |
| receipt-summary-v2 | treatment | False | 1 | not applicable |
| terms-note-v3 | treatment | False | 0 | not applicable |
| terms-note-v3 | baseline | False | 0 | not applicable |
| incident-escalation-v2 | treatment | False | 0 | not applicable |
| incident-escalation-v2 | baseline | False | 0 | not applicable |
| observatory-note-v1 | baseline | False | 0 | not applicable |
| observatory-note-v1 | treatment | False | 0 | not applicable |

**Paid feedback result: baseline 0/4 and treatment 0/4.** One of three training cases yielded an eligible example; it confirmed an already-correct offer (`changedFields: 0`), and only one treatment received that example. No paid benefit or successful paid correction was established. The separate deterministic SDK integration proves that an authorized scripted correction can influence a later suggestion; it is not this experiment’s quality result.

Four paired families are exploratory; no improvement or deployment claim is inferred. Raw model offers, scripted correction provenance and later suggestion outcomes are separate artifacts.

## Limits and acceptance

Known generic corrupt-evidence failures prevent the frozen system-abstention gate; observed metrics and any additional failures remain authoritative.

Synthetic speech and raster documents are not real recordings/camera photos. Embedded-text PDFs were the paid PDF stratum; scanned/mixed PDFs and TIFF have inherited adapter correctness evidence only. SDK completion/usage metadata limitations remain unknown. Named synthetic cues and agent-authored labels limit external validity. Suggest/review remains available; supported-reference and automation claims are withheld.

Full metrics, nominal intervals, per-item predictions/charges, safety unknowns and exact frozen provenance are retained in the hashed JSON artifacts.

## Reproduce without paid calls

[Download the deterministic evidence export](3677-measured-evidence.tar.gz) and verify its SHA256 against [the compact summary](3677-measured-summary.json). It contains the exact runner report, all 300 predictions, full frozen corpus manifest, source/label hashes, raw offers and owning effect/reload provenance, 11 feedback outcomes, profile/release/build receipts and an internal `ARTIFACTS.json` hash index. It excludes databases, rendered media and credentials. All critical evidence is available via repository-relative archive paths; historical absolute paths in receipts are not required to read it.

From the repository root, with the documented Node 26 toolchain and an empty external destination:

```sh
mkdir /tmp/smrt-3677-evidence
tar -xzf docs/evaluation/3677-measured-evidence.tar.gz -C /tmp/smrt-3677-evidence
node --input-type=module - /tmp/smrt-3677-evidence <<'JS'
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scoreCases, scoreStrata } from './packages/ingestion/evaluation/scoring.mjs';
const root = process.argv[2];
const read = p => JSON.parse(readFileSync(`${root}/${p}`, 'utf8'));
for (const [path, entry] of Object.entries(read('ARTIFACTS.json'))) {
  assert.equal(createHash('sha256').update(readFileSync(`${root}/${path}`)).digest('hex'), entry.sha256);
}
const report = read('run/report.json');
const cases = read('corpus/manifest.json').cases.filter(x => x.partition === 'heldout');
const predictions = readdirSync(`${root}/run`).filter(p => p.startsWith('prediction-')).map(p => read(`run/${p}`));
assert.equal(predictions.length, 300);
assert.deepEqual(scoreCases(cases, predictions, report.score.profile), report.score);
assert.deepEqual(scoreStrata(cases, predictions, report.score.profile), report.strata);
console.log('Frozen score and strata reproduced; no provider calls.');
JS
```

Rendered sources can be reconstructed using the pinned toolchain and generator in [the evaluation guide](../../packages/ingestion/evaluation/README.md); the manifest hashes bind the measured bytes. Do not rerun inference or reuse the opened heldout families as unseen evidence. Future improvements require a separately preregistered evaluation and budget.

## Frozen execution revision limitation

Review found a reachable evaluator defect in execution revision
`cabd661b2ef836faf1227eb57a05a29f258c0905`: an exception after raw prediction
projection (during preview, decision, apply, replay verification or final reload)
could replace that prediction with an empty generic failure, discarding offered
actions from precision denominators and explicit duplicate-effect observations.
The original scorer also discarded a known safety counter when other counters
were unknown. This limits what the frozen report can establish; offline score
reproduction reproduces the original accounting, not proof that this path was
complete.

The actual 20 outer generic exceptions in this run correspond to the preregistered
corrupt-source cases. Post-generation offer loss was not established as an
observed event in this paid run. The other failed owning-pipeline dispositions
and all unknown safety observations remain exactly as recorded. No failed row was
reclassified, excluded or rescored, and the paid evidence archive and scores are
unchanged.

A subsequent deterministic regression fix retains the raw projection before
review, records bounded review/effect/reload outcomes separately, recovers it
after later artifact/cleanup errors, and counts known positive safety observations
without claiming missing counters are zero. Its fault-injection tests are
correctness evidence for later tooling, not an improvement to this paid result.
No paid rerun occurred.
