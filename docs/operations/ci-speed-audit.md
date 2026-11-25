# CI speed and reliability audit

Measured 2026-11-20 from the GitHub API over the 14 days 2026-11-06 to
2026-11-20 (`gh run list`, `gh api .../actions/runs/<id>/jobs`, and the job
logs of every failed job in the sample). The sample is the 400 newest runs of
`on-pull-request.yml` and of `postgres-tests.yml`; job and step timings come
from the 130 newest successful or failed runs of each (6,322 jobs). All times
are wall-clock minutes. Percentiles are nearest-rank.

## Headline numbers

| Workflow / event | Runs (ok+fail) | p50 | p90 |
| --- | --- | --- | --- |
| Pull Request Validation, `pull_request` | 205 | 28.0 (ok) / 29.1 (fail) | 41.1 / 38.5 |
| Pull Request Validation, `merge_group` | 97 | 35.0 / 38.1 | 47.6 / 40.5 |
| PostgreSQL Tests, `pull_request` | 220 | 18.7 / 16.8 | 26.9 / 24.8 |
| PostgreSQL Tests, `merge_group` | 104 | 19.1 / 5.3 | 25.9 |

- **Queue time is not the problem.** Every job started within 0.1 minutes of
  creation at p90; no job class queued at p50. Runner capacity is not the
  limit, so adding runners or `max-parallel` would not help.
- **Superseded runs are already cancelled.** Both workflows set `concurrency`
  with `cancel-in-progress` (always for Pull Request Validation; for pull
  requests only in PostgreSQL Tests). 82 of 400 Pull Request Validation runs
  and 62 of 400 PostgreSQL runs ended `cancelled`, which is that mechanism
  working. Nothing to add.
- **Re-run rate is low.** 20 of 400 Pull Request Validation runs (5%) and 2 of
  283 PostgreSQL runs (under 1%) were re-run (`attempt > 1`).

## Where the time goes

### Pull request critical path

The last job to finish is `affected-package-tests (2/5)` in all three PR runs
inspected end to end (33.9, 21.9, 21.9 minutes from run start to `Required CI`).

| Job | p50 run | p90 run |
| --- | --- | --- |
| affected-package-tests (2/5) | 20.7 | 27.1 |
| M5 Reference Fixture Gate | 19.4 (step "Run the M5 aggregate gate" 14.9) | 23.4 |
| affected-package-tests (1/5) | 15.5 | 19.8 |
| Affected Typecheck | 12.5 | 18.3 |
| affected-package-tests (3/5, 4/5, 5/5) | 12.9 to 13.7 | 17.5 to 18.3 |
| Affected Knowledge Freshness | 6.5 (11.2 when the release upgrade gate runs) | 8.9 |

Shard 2/5 is 5 to 8 minutes slower than its neighbours on every run.

### Merge queue (`merge_group`) critical path

`Merge Group Fail Fast` (the sentinel) lasts the whole run, p50 33.9. Behind it:

| Job | p50 run | p90 run |
| --- | --- | --- |
| test-packages (2/5) | 25.1 | 30.2 |
| test-packages (1/5, 3/5, 4/5, 5/5) | 13.7 to 15.5 | 16.1 to 19.8 |
| Typecheck | 14.4 | 18.0 |
| Knowledge Freshness | 11.8 | 14.1 |
| Build | 8.7 | 10.2 |
| Coverage Gate | 6.7 | 18.3 |

In the latest merge-group run (44699654477) `test-packages (2/5)` took 29.7
minutes against 14 to 16 for the other four. One package in it, `app-shell`,
ran for 1196 s (118 test files, 1124 tests; vitest's own `Duration` line), but
`scripts/test-shard-balance.mjs` weighted it at 628 s. The balancer therefore
put it with about 580 s of other packages and the shard became the long pole
of every run where it is selected, in both the PR (`affected-test-shard.mjs`)
and merge-queue (`test-packages-shard.mjs`) lanes. The tables there are
documented as hand-refreshed, and this one is stale.

### PostgreSQL Tests

| Shard | p50 run | p90 run | Failed jobs |
| --- | --- | --- | --- |
| remaining:1/3 | 15.8 | 19.2 | 14 |
| ingestion:1/2 | 13.4 | 15.6 | 5 |
| ingestion:2/2 | 12.8 | 15.2 | 6 |
| remaining:2/3 | 11.9 | 13.8 | 5 |
| remaining:3/3 | 11.2 | 13.4 | 11 |

The test step is 9.4 to 13.8 minutes of each shard; environment setup is 1.0
minutes at p50 and 3.0 to 5.4 at p90. The wall clock is the slowest shard
(remaining:1/3), 2.4 minutes behind the second slowest.

Failed shard jobs in this lane are real test failures, not infrastructure: the
same `issue-2537-postgres-manifest-foreign-keys.optional.test.ts` and
`schema/inspection.test.ts` failures repeat across consecutive runs of the
same pull requests until the code is fixed. Only 5 failed jobs (3 runs) died
in "Setup environment".

### Does the merge-queue PostgreSQL run repeat the PR run?

Yes, in the measured window. Of 40 merge-group runs, 39 ran all five shards
(68.2 runner-minutes p50) against 71 of 88 pull-request runs (65.4 runner-minutes
p50): the same suites on a commit that differs from the PR head only by what
merged ahead of it. Merge-group wall time was 19.1 minutes p50, the same as the
PR event.

Caveat: #5364 / #5366 (merged 2026-11-20 06:16 UTC, mid-window) added
`scripts/merge-group-scope.mjs`, which lets a merge group run only the suites a
change can affect. Almost all of the sample predates it, and the first merge
group after it (44699654477) still ran the full `test-packages` matrix. The
duplication figure above is therefore the pre-#5366 baseline. Re-measure after
a week before deciding anything about the merge-queue lane (see Proposals).

## Failures and flakes

Every failed job in the 260 sampled runs was classified from its log
(`gh api repos/happyvertical/smrt/actions/jobs/<id>/logs`), 111 failed jobs
excluding the two aggregator jobs.

| Cause | Failed jobs | Runs | Class |
| --- | --- | --- | --- |
| `tsc` errors / failed package build | 60 | 11 | real code failure |
| Vitest assertion failures | 16 | 15 | real code failure |
| `ERR_PNPM_FETCH_503` from `npm.happyvertical.com` during `pnpm install` | 13 | 3 | infrastructure flake |
| `apt-get update` failing on `packages.microsoft.com` (HTTP 429) | 3 | 2 | infrastructure flake |
| onnxruntime binary download | 1 | 1 | infrastructure flake |
| Vitest `Test timed out` | 3 | 3 | see below |
| Unclassified (PR title and standards checks, PostgreSQL step failures with no vitest marker) | 18 | n/a | mostly author error |

Infrastructure flakes hit 6 of 260 runs (2.3%), but each one fails a whole
job that had already spent 3.5 to 4.5 minutes in `pnpm install` before dying,
and a re-run costs the full run again. These are the only failures a retry
removes.

Test timeouts: `ingestion` `proposals.part1.test.ts` timed out at the 30 s
`testTimeout` once (run 44592377967), and `app-shell`
`import-workflow.test.ts` timed out at 60 s in two runs of one branch
(`claude/change-feed-delivery`, runs 44649938803 and 44654617043). Two of the
three are the same branch failing twice, which looks like a regression rather
than load; the ingestion one passes on every other run in the window.

### Batched Release failures: admission guard vs batched queue (fixed by #5380)

3 of 8 Batched Release runs ended `failure`. Two of them (44694204870,
44696012400), including the 07:20 UTC scheduled run, failed in
`Reserve Release Snapshot` with `Release admission requires a one-entry merge
queue`: `scripts/release-admission.mjs` required `max_entries_to_build === 1`
and `max_entries_to_merge === 1`, while the main ruleset's merge queue batches
several entries. That was a real misconfiguration between the guard and the
queue, not intended behaviour. #5380 (merged 2026-11-20) lets admission run on
a batched queue: it now only requires a merge queue on main, and `close`
revokes any untracked live grant before freezing the snapshot. Re-check the
next scheduled runs to confirm. The third (44696916801) is different: its
`Publish / Deploy Documentation` job failed with `Multiple artifacts named
"github-pages" were unexpectedly found for this workflow run` after a manual
re-dispatch, a duplicate-artifact condition worth a separate look.

14 `Release Admission` runs also ended `failure`, all in the `reconcile` job
with `Admission reconciliation incomplete (1 heads): Stale PR validation head`.
That is the guard reporting a superseded PR head; it is noisy rather than
broken and was left alone.

### Runner hardware

The known pre-AVX Xeon landing risk (`ci-sigill-prebuilt-avx-baseline`) did
not show up in this window: no failed job logged `SIGILL`, exit 132 or
`Worker exited unexpectedly`.

### Turbo cache

A cache HIT proves an artifact exists for the task hash, not that `dist/`
holds it (switching branches A to B to A leaves B's output in place). The
audit did not change cache behaviour; see Proposals.

## What this change ships

| Change | File | Expected effect |
| --- | --- | --- |
| `pnpm install` retried up to 3 times, 30 s then 60 s backoff, only for transient network errors (registry 5xx/429, resets, timeouts, onnxruntime download); a lockfile or resolution error still fails on the first try. pnpm's own per-request retries raised to 5 (10 to 60 s) | `.github/actions/setup-environment/action.yml` | Removes the 13-job, 3-run registry-503 class (about 1.2% of runs, 4 minutes lost per failed job plus a full re-run) |
| `packages.microsoft.com` apt source parked on GitHub-hosted runners, plus `Acquire::Retries "5"` | same | Removes the 429 class (2 runs). The ONNX packages all come from the Ubuntu archive; self-hosted pods and `CI_ONNX_DEPS_READY` runners are untouched |
| `smrt-app-shell` weight 628 to 1200 in the shard table | `scripts/test-shard-balance.mjs` | `app-shell` gets a shard to itself; shard 2/5 was 25.1 p50 in the merge queue against 13 to 15 elsewhere. Expected 3 to 6 minutes off the merge-queue and PR critical path. Re-measure after merge |
| `testTimeout` 30 s to 60 s in `ingestion` | `packages/ingestion/vitest.config.ts` | Matches `app-shell`; no test is skipped or weakened, a hang just fails 30 s later |
| Dropped ordering-only `needs` on `affected-package-tests` (waited on `affected-test-scope`, which waited on `affected-scope`); `affected-core-tests` keeps its need because it reads the scope output (#5646) | `.github/workflows/test-suite.yml` | The package shards start with their sibling jobs instead of about 80 s later (PR run 45077001900). Same jobs, same `Required CI` aggregate: a failed scope job still fails the reusable workflow |

Not changed: required checks, rulesets, branch protection, runner
infrastructure, secrets. `concurrency` already cancels superseded runs. The
`app-shell` `testTimeout` stays at 60 s because the only two observed
timeouts are one branch failing twice.

## Ranked proposals

Minutes saved are per affected run at p50 unless stated. Risk and effort are
rough.

| # | Proposal | Saves | Risk | Effort | Needs owner decision |
| --- | --- | --- | --- | --- | --- |
| 1 | Shipped on `release/ci-wall-clock` (#5647): `app-shell` runs as three units (default config `--shard` 1/2 and 2/2, and pglite+dom+packed), balanced like any package. Original proposal: split `app-shell` tests across two shards, or give it its own matrix entry, and reduce its 1196 s (`fileParallelism: false`, one test file `minimal-row.generated.test.ts` is a large share of the 2221 s of summed test time) | 6 to 9 (new critical path becomes M5 gate, 19 min) | Low | Medium | No |
| 2 | Shipped here: weight fix for `app-shell` | 3 to 6 | Low | Done | No |
| 3 | Shipped here: install and apt retries | 0 p50, removes about 1 in 80 failed runs (about 25 to 30 minutes each with a re-run) | Low | Done | No |
| 4 | Refresh `TEST_SECONDS` / `POSTGRES_TEST_SECONDS` automatically, from a nightly job summing per-package `Duration`, instead of by hand. Package attribution from raw job logs is unreliable; use `turbo run --summarize` output | Keeps 2 from regressing | Low | Medium | No |
| 5 | Shorten the M5 Reference Fixture Gate (19.4 min p50 on every PR, 14.9 in one step) by caching its reference application closure build, or splitting it | 2 to 5 once shard 2/5 is fixed (it becomes the PR critical path) | Medium | Medium | No |
| 6 | Run the PostgreSQL merge-queue lane only on a cheap subset or drop it when the PR run on the same code was green (**proposal only, not implemented**). Today 39 of 40 merge groups re-ran all five shards for 68 runner-minutes and 19 minutes wall | up to 19 min of queue time per merge, 68 runner-minutes | Medium to high (the merge result can differ from the PR head, and the queue is the last gate) | Low (workflow condition) | **Yes.** Re-measure after #5366 has been live a week; it may already have taken most of this |
| 7 | Rebalance PostgreSQL `remaining` groups: `remaining:1/3` is 2.4 min behind the next shard and failed 14 times; move one large package (`smrt-users` 606 s or `smrt-education` 325 s) | 1 to 2 | Low | Low | No |
| 8 | Make `Turbo` cache HITs verify `dist/` identity before trusting them (a stamp written next to `dist/` and compared with the task hash) | Reliability only | Medium | Medium | Yes, touches build contract |
| 9 | Look at the duplicate `github-pages` artifact failure in Batched Release docs deploy, and quiet the `Stale PR validation head` reconcile failures | Reliability only | Low | Low | No |

## Method notes and limits

- Per-package durations from merged job logs are ambiguous because Turbo runs
  two tasks at once and its output interleaves. The `app-shell` figure comes
  from a block whose test names, test counts and `Start at` stamp identify the
  package unambiguously; other packages were not re-weighted for that reason.
  Refresh them with `turbo run --summarize` (proposal 4).
- Timeout, apt and pnpm failure counts come from regex classification of 111
  failed job logs; the classes overlap for jobs with both a build error and a
  test failure.
- The 14-day window is short and most of it predates #5366. All numbers
  are a baseline to compare against after this change merges.
