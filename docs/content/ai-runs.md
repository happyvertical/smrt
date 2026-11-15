---
title: AI runs, calls and trajectories
---

# AI runs, calls and trajectories

This page defines the words SMRT uses for AI work, shows how each kind of work
is recorded, and states the rules for budgets, resuming and retention. It is
written for someone who has not seen the code. The [inference
guide](./inference.md) covers which model answers a call; this page covers
what is written down about the work afterwards, and what a long piece of work
may spend.

Everything here follows one idea: **every model call is recorded once, in one
place, and anything that groups calls (a fusion, a chat turn, a workflow) is a
run laid over those records.** There is no second record of a call's cost or
tokens.

Lines that begin with **Proposed:** are details this page adds to the agreed
design. They are part of the specification code is built from, and they are
marked so a reviewer can accept or change each one.

## 1. Terms

| Term | Definition |
|---|---|
| **Host** | The application or service that uses SMRT and drives AI work: it defines the steps and checks of a workflow, starts runs, stops them and resumes them. |
| **Prompt** | A registered prompt template, identified by its **prompt key**. Its version is its `templateHash`. |
| **Call** | One model call: one request sent to one provider and its response. It has exactly one **call id** and at most one row in `_smrt_ai_usage`. A transport retry inside the provider client is not a second call; anything SMRT itself sends again is. |
| **Entry call** | The call a caller asked for, such as one `do()`. Usually it is one call. When its tier is bound to an alias chain or a fusion it becomes several calls, which share the entry call's id (`entry_call_id`). |
| **Tier** | The quality a prompt asks for: `cheap`, `good`, `great`, `best` or `auto`. The app binds each tier to a model, an alias chain or a fusion. |
| **Latency** | Whether a caller waits for the answer: `interactive` or `background`. |
| **Rate card** | The price table used to estimate a call's cost: input and output prices per 1,000 tokens for each provider and model (built-in defaults plus the app's `usage.costRates`). |
| **Uncosted** | A call whose model is not on the rate card. Its `estimated_cost` is NULL, never zero. |
| **Run** | One piece of AI work that has its own record: a status, a budget and a trajectory. It may contain any number of calls, including none yet. A single call made on its own is **not** a run; its usage row has no `run_id`. |
| **Run type** | The shape of the work. An open string. The framework's own types are `fusion`, `turn` and `workflow`. A type defined by an app or package carries its owner's namespace. A reader must cope with a type whose code is not loaded: it shows the row and does not interpret the type's state. |
| **Definition** | One specific task of a run type, with a `definition_key` and a `definition_version`; for example one workflow definition, or one fusion. Apps add definitions often and run types rarely. |
| **Workflow run** | A run of type `workflow`. The host fixes the order: a list of **steps**, each with a schema-checked output and a host check. It is linear, with repair and an approval pause; there is no branching and no parallel step. It replaces "design run". |
| **Step** | One host-defined stage of a workflow. It replaces "pass". In a model-driven loop the equivalent round is an **iteration**. Each time a step is started it is a new **step instance**, with its own `step_instance_id`. |
| **Attempt** | One try at a step's call. A repair is attempt 2 of the same step. |
| **Durable** | A property of a run, not a run type: a durable run keeps a checkpoint and can be resumed after a restart. Any run type can be durable. |
| **Checkpoint** | The saved state a durable run resumes from. |
| **Lease** | A time-limited claim a worker process holds on the background job that runs a durable run. The worker renews it while it works; if the worker dies, the lease expires and another worker may take the job. |
| **Claim fencing** | The check in `smrt-jobs` that a write comes from the worker holding the job's current claim. A worker whose claim has been taken over is refused, so a stale worker cannot write. |
| **Event** | One ordered entry in a run: a call, an action, an observation, a check, an approval or a hand-off. |
| **Trajectory** | The ordered events of one run, read with `getRunTrajectory(runId)`. A trajectory is a way of reading, not a table. |
| **Evaluation** | A judgment on one call or one run, made by a person, the app or an automated grader. It replaces "outcome". A check or an approval inside a run is an event, not an evaluation. |
| **Budget** | The limits a run must stay within. |
| **Reservation** | Room in a budget held for one call from just before it is sent until it ends. |
| **Experiment, dataset item** | An experiment is a set of runs meant to be compared; a dataset item is what each run attempted. Both are plain references on the run; there are no experiment or dataset tables. |
| **Fusion, seat** | A fusion answers one entry call with several models (elsewhere called a model ensemble). A seat is one named call inside it: a panelist or the judge. |

Proposed: a run type owned by an app or package is written `@scope/pkg:type`,
for example `@happyvertical/smrt-agents:coding`. The framework's own three
types have no prefix.

A "work profile" is not a concept any more. What it bundled is expressed
through the tier, latency, reasoning effort and the budget.

## 2. The model

```
 prompt (prompt_key + template_hash)
    ^
    | each call names the prompt it used
    |
 usage row (_smrt_ai_usage): one per call, the cost ledger      <----------+
   call_id, entry_call_id, run_id, prompt_key, template_hash, tier,        |
   step_index, step_instance_id, attempt, tokens, estimated_cost           |
    |                          |                                           |
    | run_id                   | entry_call_id                             |
    | (none for a call         v                                           |
    |  on its own)          transcript (_smrt_ai_transcripts)              |
    v                       opt-in text of one entry call                  |
 run (_smrt_ai_runs)                                                       |
   type, definition, status, budget, totals                                |
   parent_run_id ----> the parent run (none for a root run)                |
    |                                                                      |
    +-- events (_smrt_ai_run_events), ordered by seq, each with run_id     |
    |     call event ------------------ call_id ---------------------------+
    |     action, observation, check, approval, handoff
    |
    +-- checkpoint (_smrt_ai_run_checkpoints), durable runs only

 evaluation (_smrt_ai_evaluations): on exactly one call (call_id)
                                    or exactly one run (run_id)
```

Reading the picture:

- A **call** names the prompt it used. A run does not ask for a prompt; its
  calls do, and different steps of one run may use different prompts.
- The **usage row is the ledger of calls**. One row per call, written when the
  call ends, carrying `run_id` when the call belongs to a run. Tokens and cost
  of a call are recorded there and nowhere else. An event of type `call` is
  only a pointer to its usage row, so a call's cost is never recorded twice.
- The **run row** is written when the run starts, updated at step boundaries
  and when a call reserves or settles budget (not on every event), and closed
  at the end. It carries running totals that are maintained with each call (see
  [section 6](#6-budgets-and-how-they-are-accounted)).
- `parent_run_id` points **up**, from a child run to the run that started it.
- **Events** are the ordered record of what happened. `seq` is append order,
  not causal order; `parent_event_id` carries cause.
- A **checkpoint** exists only for a durable run and holds what resuming needs.
- An **evaluation** attaches to exactly one call or exactly one run.

### Usage row

`_smrt_ai_usage` keeps its name and its existing columns: `id`, `provider`,
`model`, `operation`, `prompt_tokens`, `completion_tokens`, `total_tokens`,
`estimated_cost`, `duration`, `class_name`, `tenant_id`, `tags`, `created_at`,
`prompt_key`, `tier_requested`, `tier_resolved`, `run_id` and `call_id`. It
gains:

| Column | Meaning |
|---|---|
| `entry_call_id` | The entry call this call belongs to. Equal to `call_id` for a call made on its own. |
| `template_hash` | The prompt version. Today it is only a tag; it becomes a column. |
| `step_index`, `step_name` | The workflow step that made the call, if any. |
| `step_instance_id` | The step instance, so a repeated or resumed step is told apart from the first. |
| `attempt` | 1 for a step's first try, 2 for its first repair, and so on. |

**Call ids.** Every tracked call gets a call id **minted before the call is
sent**, whether or not transcripts are enabled. The usage row is written with
`id = call_id`, so the primary key deduplicates: the insert is `INSERT ... ON
CONFLICT (id) DO NOTHING`, which works the same on every engine. A call that
finished but failed to save, or a retried save, never produces a second row.
`call_id` also gets a unique index.

Today `call_id` holds something else: the id of the entry call, shared by
every seat row of a fusion, and minted only while transcripts are on. That
meaning moves to `entry_call_id`. `_smrt_ai_transcripts` is unchanged; its
`call_id` column holds an entry call id, so a transcript joins to usage on
`_smrt_ai_usage.entry_call_id = _smrt_ai_transcripts.call_id`.

**Alias chains and fusions.** Each candidate in an alias chain that is
actually sent to a provider is its own call, with its own call id, reservation
and (when the provider reports usage) usage row. A candidate skipped before
sending (unavailable, or missing a capability) is not a call. Each fusion seat
is its own call. All of them share the entry call's `entry_call_id`.

Proposed: when no candidate of a chain answers, the executor's existing
zero-token failure row gets its own call id. It has no reservation and is
charged as a call with no reservation (section 6.4).

### Run row

`_smrt_ai_runs` has one row for every run:

| Column | Meaning |
|---|---|
| `id`, `tenant_id`, `class_name` | As today. |
| `type`, `definition_key`, `definition_version` | What ran. `definition_key` is today's `fusion_key`, renamed. |
| `prompt_key` | Kept: the prompt key of the entry call that started the run, if any. |
| `owner_id`, `parent_run_id` | Who started it; the run that started it. |
| `experiment_id`, `dataset_item`, `tags` | Grouping. `tags` records **what was varied** in the run (for example the model or the template version under test), so runs can be compared. |
| `status`, `degraded`, `stop_reason` | How it stands (below). |
| `stopped_by_run_id` | The run whose limit or stop stopped this one: itself or an ancestor. |
| `budget` | The limits, as JSON (section 6.1). |
| `tokens`, `cost_used`, `calls`, `uncosted_calls`, `steps_used`, `duration` | **Own totals**: this run's own calls and steps. `duration` is active time in milliseconds, following the existing `duration` columns. |
| `active_since` | When the current active period began; NULL while stopped, waiting or finished. |
| `inclusive_tokens`, `inclusive_cost`, `inclusive_calls`, `inclusive_uncosted_calls` | **Inclusive totals**: own totals plus those of every descendant run. |
| `reserved_tokens`, `reserved_cost`, `reserved_calls` | Room held for calls in flight, inclusive of descendants. |
| `checks_passed`, `checks_failed`, `approvals_given`, `approvals_refused` | Counts saved when the trajectory is pruned (section 8). |
| `retain`, `trajectory_pruned` | Retention flags. |
| `started_at`, `finished_at`, `created_at` | `created_at` is kept as the row's insert time, so its indexes and retention keep working; for a new run it equals `started_at`. |
| `mode`, `seats`, `degraded_seats`, `details` | Kept for fusion runs, as today: the fusion's mode, seats that ran, seats degraded, and per-seat identities as JSON. NULL for other run types. |

Proposed: the column names `stopped_by_run_id`, `uncosted_calls`,
`inclusive_uncosted_calls`, `active_since`, `checks_passed`, `checks_failed`,
`approvals_given` and `approvals_refused`.

Steps and duration have **no inclusive total**. A child run's steps are its
own, and a child runs inside its parent's active time, so adding the child's
duration to the parent's would count the same time twice.

`status` is one of:

| Status | Meaning |
|---|---|
| `running` | Work is in progress (or was, and nothing has said otherwise yet). |
| `waiting-approval` | Paused at an approval event until a person decides. Resumable. |
| `stopped` | Stopped with a `stop_reason`, and **resumable**. |
| `failed` | Something went wrong. Not resumable. |
| `done` | Finished. |

`stop_reason` is one column holding a typed code, never free text. It says why
a run stopped or failed:

| Code | Status | Meaning |
|---|---|---|
| `max_steps`, `max_calls`, `max_cost`, `max_tokens`, `max_duration` | `stopped` | A budget limit was reached. |
| `cancelled` | `stopped` | The host asked the run to stop (for a person, a shutdown or any other reason of its own). |
| `definition_changed` | `stopped` | The definition changed and does not accept the run's checkpoint. |
| `uncosted` | `stopped` | A cost limit applies and the next call's model has no price (section 6.3). |
| `repairs_exhausted`, `check_failed` | `failed` | A step's output never passed. |
| `abandoned` | `failed` | The process running a run that is not durable disappeared (section 6.7). |
| `error` | `failed` | Anything else that went wrong. |

Proposed: `cancelled` is a resumable stop. It replaces the earlier
`host_stopped`, which meant the same thing.

Proposed: `uncosted` and `abandoned` are new codes.

Proposed: a `failed` run is never resumed. A host that wants to try again
starts a new run.

A worker that loses its lease does not change the run: another worker takes
the job and continues the same run. Losing a lease is something that happens
to a worker, so it is not a reason on the run.

### Event row

`_smrt_ai_run_events` has: `id` (stable), `run_id`, `seq`, `parent_event_id`,
`type`, `call_id`, `step_index`, `name`, `status`, `duration`, `payload`,
`payload_ref`, `truncated`, `created_at`, and, for `call` events only, the
reservation: `reservation` (its state, section 6.4), `reserved_tokens` and
`reserved_cost`. The reservation amounts are typed columns, never part of the
payload, because a payload may be capped, cut or redacted.

Proposed: the columns `reservation`, `reserved_tokens` and `reserved_cost`, and
an index on `(type, reservation, created_at)` for the sweep in section 6.7.

| Event type | What it records |
|---|---|
| `call` | A model call. Points at its usage row through `call_id`. Written when the call reserves room, before it is sent. |
| `action` | Something the run did: a tool call, a write, a command. |
| `observation` | What came back from an action. |
| `check` | A host check of a step's output, passed or failed. |
| `approval` | A person's decision, requested or given. |
| `handoff` | Work passed to another run, a person or an outside tool. |

Proposed: a `check` or `approval` event's `parent_event_id` is the `call` event
whose output it judges. That link is how checks and approvals are attributed
to a prompt (section 5).

`(run_id, seq)` is unique, declared inline in the table definition (DuckDB
honours `ON CONFLICT` only against an inline constraint). `seq` is allocated
in the same transaction as the insert, as one more than the run's largest
`seq`:

```sql
INSERT INTO _smrt_ai_run_events (id, run_id, seq, type, ...)
SELECT $1, $2, COALESCE(MAX(seq), 0) + 1, $3, ...
  FROM _smrt_ai_run_events
 WHERE run_id = $2
ON CONFLICT (run_id, seq) DO NOTHING
RETURNING seq;
```

On PostgreSQL the transaction first locks the run row (`SELECT id FROM
_smrt_ai_runs WHERE id = $2 FOR UPDATE`), so two writers of one run's events
take turns and do not collide. Taking a lock does not update the run row. If
the insert still returns no row, it is retried with a fresh `seq`, a bounded
number of times. `ON CONFLICT DO NOTHING` never aborts a PostgreSQL
transaction, so no savepoint is needed. On SQLite and DuckDB a write
transaction is already exclusive (section 6.5).

No transaction is held open across a model call. Each event's `payload` is
capped; when it is cut the head and the tail are kept and `truncated` is set.

`payload_ref` points at content the host already stores, such as a chat
message or a file handle. The framework stores nothing behind it. For a chat
turn an event may point at the chat message instead of copying its content.

### Evaluation row

`_smrt_ai_evaluations` replaces `_smrt_ai_usage_outcomes`, and
`recordAiEvaluation` replaces `recordAiUsageOutcome`. An evaluation attaches to
exactly one call (`call_id`) or exactly one run (`run_id`), never both. It
carries a metric name, a value with its type and scale, a label, evidence, and
the evaluator with its version, written as one of:

- `human`: a person;
- `app`: the app's own code;
- `grader:<name>@<version>`: an automated grader, for example
  `grader:faithfulness@2`.

Proposed: the columns are `id`, `call_id`, `run_id`, `metric`, `value`,
`value_type` (`number`, `boolean` or `text`), `scale` (for example `0..1`),
`label`, `evidence`, `evaluator`, `tenant_id` and `created_at`.

### Checkpoint row

See [section 7](#7-resuming).

## 3. How each case is recorded

| Case | Records |
|---|---|
| `do()`, `is()`, `describe()` whose tier is bound to a model or an alias chain | One usage row per call (one, unless the chain fell back). No run. |
| `do()`, `is()`, `describe()` whose tier is bound to a fusion | A `fusion` run, as below. |
| A fusion | One `fusion` run, one usage row and one `call` event per seat. The run row is written when the fusion starts, not when it ends. |
| A chat turn | One `turn` run, one usage row and one `call` event per model call in the tool loop, `action` and `observation` events for tool use. |
| A workflow run | One `workflow` run, a checkpoint, usage rows that carry the step and attempt, one `call` event per call, `check` and `approval` events. |
| A fusion inside a workflow step | A child `fusion` run whose `parent_run_id` is the workflow run. |

A caller that wants a status, a budget or a trajectory opens a run. A caller that
wants only the answer makes a call.

The run a call belongs to is **passed explicitly**, as a run context on the
call, never read from a process-wide variable. A background job carries the run
id in its payload and rebuilds the context when it runs. Tracking is scoped to
the tenant and database the work belongs to.

**Staying on the tracked path.** Every model call goes through the tracked
client, and every tracked call carries a prompt key, resolved through
`resolvePrompt` from `smrt-prompts`. A repository check fails when code makes a
model call outside the tracked client. It has a short allow-list of
exceptions, each with a written reason.

Proposed: runs need usage persistence. When usage persistence is off for a
database, no run is opened there, and asking for a budget is an error.

## 4. Reading it: trajectories

`getRunTrajectory(runId)` returns the run row and its events in `seq` order,
with each `call` event joined to its usage row (tokens, cost, model, tier,
latency) and each event's evaluation, if any. It works for a call inside a run
and, through the same reader, for a call on its own (a one-entry trajectory
with no run). A run whose `trajectory_pruned` is set returns the row, its saved
counts and no events. A `call` event whose usage row has been pruned is
returned without it.

## 5. Asking how a prompt performs

Prompt performance is a query over usage rows grouped by `(prompt_key,
template_hash)`; evaluations add labels and scores. `compareAiPromptRuns` and
`smrt ai:compare` report these side by side for two template versions, two
models or two tiers.

| Measure | How it is computed |
|---|---|
| Cost, tokens | Sum of `estimated_cost`, `prompt_tokens`, `completion_tokens` and `total_tokens` over the group's usage rows. Uncosted rows are counted separately, never as zero cost. |
| Latency p50, p95 | Nearest-rank percentiles of `duration` over the group's rows. |
| Repair rate | Step instances in the group with at least one usage row where `attempt > 1`, divided by step instances in the group. |
| Check pass rate | `check` events whose judged call (its `parent_event_id`) used the group's prompt and template, passed divided by all. |
| Approval rate | `approval` events attributed the same way, approved divided by decided. |
| Labels, scores | Evaluations on the group's calls, and on runs whose calls used the group's prompt, counted once per group. |

For example, repair rate per template version:

```sql
SELECT template_hash,
       COUNT(DISTINCT run_id || ':' || step_instance_id)                AS steps,
       COUNT(DISTINCT CASE WHEN attempt > 1
                           THEN run_id || ':' || step_instance_id END)  AS repaired
FROM _smrt_ai_usage
WHERE prompt_key = :promptKey AND step_instance_id IS NOT NULL
GROUP BY template_hash;
```

Check pass rate per template version. Each check is counted once, against the
prompt and template of the call it judged, not against every prompt its run
used:

```sql
SELECT u.template_hash, chk.status, COUNT(*) AS checks
FROM _smrt_ai_run_events chk
JOIN _smrt_ai_run_events c ON c.id = chk.parent_event_id AND c.type = 'call'
JOIN _smrt_ai_usage u      ON u.call_id = c.call_id
WHERE chk.type = 'check' AND u.prompt_key = :promptKey
GROUP BY u.template_hash, chk.status;
```

These per-prompt measures cover runs whose trajectory is still kept and whose
judged call still has its usage row. The check and approval counts saved on a
pruned run (section 8) are per run, not per prompt, so they serve per-run and
per-definition reports and are **not** part of per-prompt measures.

## 6. Budgets and how they are accounted

### 6.1 The limits

A budget is a set of optional keys, stored as JSON in the run's `budget`
column:

| Key | Limit |
|---|---|
| `maxSteps` | Steps the run may start. |
| `maxCalls` | Calls the run may make, its descendants' included. |
| `maxCost` | Cost, in the rate card's unit, descendants included. **Approximate** (section 6.3). |
| `maxTokens` | Input plus output tokens, descendants included. Best effort when a call is cancelled before it reports usage. |
| `maxDurationMs` | The run's own active time. Time spent stopped or waiting for approval does not count. |
| `maxCallTokens` | Largest single call, input plus output. |
| `callTimeoutMs` | Wall-clock limit for one call. |
| `actionTimeoutMs` | Wall-clock limit for one action. |
| `repairRetries` | Repairs allowed per step. |

When a limit in the first five rows is reached the run **stops with the typed
reason and stays resumable**. It does not fail. Failing is for things that went
wrong, such as repairs exhausted.

Proposed: `maxCallTokens`, `callTimeoutMs` and `actionTimeoutMs` bound one
call or action. Reaching one fails that call or action, and the run's repair
or stop rules decide what happens next; they do not stop the run by
themselves.

The app may set a ceiling on how far a budget can be raised when a stopped
run is resumed. A resume asking for more than the ceiling is refused.

### 6.2 What is counted, and where

- **Usage rows** are the ledger of calls: one row per call, the record that
  prompt reports and billing read. They are pruned on their own schedule
  (section 8), even while a run that made them is still alive.
- **Run totals** (own, inclusive, reserved) are **authoritative for budgets**.
  They are maintained in the same transaction as each reservation and
  settlement, so they are never rebuilt from usage rows, which may have been
  pruned. Section 6.6 says how they are checked.

A call is charged **once**. It is added to the own totals of the run that made
it and to the **inclusive** totals of that run and of each ancestor. It is never
added to an ancestor's own totals. Each run's `maxCalls`, `maxTokens` and
`maxCost` are checked against that run's inclusive numbers, so a child's
spending counts against its own budget, its parent's and every ancestor's.
`maxSteps` and `maxDurationMs` are checked against the run's own numbers only.

Proposed: when an ancestor's limit is reached, or an ancestor is stopped, its
descendants stop as well, each at its own next reservation or step start. Each
one stops with the ancestor's reason (`cancelled` when the ancestor itself was
cancelled) and records that ancestor in `stopped_by_run_id`. No transaction
writes a whole subtree.

### 6.3 How much a call reserves

Before a call is sent, the tracked client works out what to hold for it:

- `E`: the estimated input tokens of the request.
- `O`: the request's own output-token limit, if it sets one.
- `M`: the smallest `maxCallTokens` on the run and its ancestors, if any.

| Case | Output limit sent to the provider | Tokens reserved `R` |
|---|---|---|
| `M` is set | `min(O, M - E)` (`M - E` when `O` is not set) | `E` + that output limit |
| `M` is not set, `O` is set | `O` | `E + O` |
| Neither is set | none | `E + D` |

`M - E` below 1 means the request cannot fit: the call fails before it is sent,
and nothing is reserved. `maxCallTokens` already covers input and output, so the
input is counted once.

`D` is a default output allowance. Proposed: `D` is the model's maximum
output tokens where the model's capabilities record it, else 4,096; `E` is the
provider's token count when the client offers one, else the request's
characters divided by 4. A call with no output limit can spend more than `R`;
the difference is overshoot, like a cost estimate's.

The cost reserved is `C = E × input price + (R - E) × output price`, per 1,000
tokens, from the rate card. The call reserves one call, `R` tokens and `C`
cost.

The reservation succeeds only if **every** run in the chain (the run making
the call and each ancestor) has room for all of it:

```
inclusive_calls  + reserved_calls  + 1 <= maxCalls
inclusive_tokens + reserved_tokens + R <= maxTokens
inclusive_cost   + reserved_cost   + C <= maxCost
```

A limit that is not set is not checked. The reservation is never shrunk to
fit: if any run lacks room for the whole amount, including when it has no room
at all, the call is refused and the run stops with that limit's reason. The
same check also refuses a call when a chain run's own active time has reached
its `maxDurationMs`.

Calls made in parallel, such as the panel seats of a fusion, reserve one by
one, first come first served, each for its own `R`. Because a call without
`maxCallTokens` reserves `E + D` and not "all the room left", the first seat
does not take the room the others need. A seat whose reservation is refused
does not run, and its run stops with the limit's reason; seats already sent
finish and settle normally.

**Uncosted models.** Proposed: when `maxCost` is set on the run or any
ancestor and the call's model is not on the rate card, the reservation is
refused and the run stops with reason `uncosted`; it can resume once a price
is configured or the cost limit is removed. Without a cost limit an uncosted
call is allowed: it reserves no cost, adds nothing to `cost_used`, and adds one
to `uncosted_calls` and `inclusive_uncosted_calls`, so a reader knows the cost
total is a lower bound.

Because the actual cost of a call is only known when it ends, a call can
overshoot `maxCost` by the difference between the reserved and the actual
cost. The next reservation then fails and the run stops. Cost limits are
therefore approximate: they bound spending to the limit plus the overshoot of
calls that were in flight.

**Steps.** Starting a step checks `steps_used + 1 <= maxSteps` on the run's own
row, and `maxDurationMs`, in the transaction that records the step boundary
(with the checkpoint, for a durable run). If either fails, the run stops with
`max_steps` or `max_duration` and the step does not start. A repair is an
attempt, not a new step. Proposed: a step started again after a crash is a new
step instance and counts again, because it spends again.

**Duration.** `duration` accumulates closed active periods; `active_since`
marks the open one. The current active time is `duration + (now -
active_since)`. Every write of the run row (step boundaries, reservations,
settlements, status changes) folds the open period into `duration`; stopping or
waiting for approval closes it and sets `active_since` to NULL; resuming opens
a new one.

### 6.4 The reservation's life: reserve, settle, release

A reservation is recorded on its `call` event, in the `reservation` column. It
moves through these states, and every move is a conditional update that
succeeds only from the expected state, so the same move can never be applied
twice:

```
                 settle                       late usage
    reserved ----------------> settled
        |
        +-- release ---------> released  ---------------> settled_late
        |
        +-- reconciliation --> abandoned ---------------> settled_late

    unreserved: usage for a call that never reserved (charged once, on write)
```

| Move | Changes to every run in the chain | Changes to the event |
|---|---|---|
| **Reserve** | `reserved_*` += the amounts | Inserted, `reserved`, with `reserved_tokens`, `reserved_cost`. |
| **Settle** (the call ended with usage) | `reserved_*` -= the event's amounts; inclusive totals += actuals; own totals += actuals for the run that made the call | `reserved` → `settled`; `status` set to the call's outcome. |
| **Release** (the call ended without usage: failed, timed out, cancelled) | `reserved_*` -= the event's amounts | `reserved` → `released`; `status` = `failed`, `timed_out` or `cancelled`. |
| **Abandon** (reconciliation, section 6.7) | `reserved_*` -= the event's amounts | `reserved` → `abandoned`; `status` = `abandoned`. |
| **Late usage** (usage arrives after a release or an abandonment) | inclusive totals += actuals; own totals += actuals; `reserved_*` **untouched**, because the reservation was already returned | `released` or `abandoned` → `settled_late`. |
| **Unreserved usage** (a usage row for the run with no `call` event) | As late usage | A `call` event is inserted as `unreserved`. |
| Usage for a `settled` or `settled_late` call | Nothing | Nothing. |

So a call that timed out and was released, whose provider then reports usage,
is charged exactly once, and `reserved_*` never goes below zero. A call that
reconciliation abandoned while its process was in fact still alive is likewise
charged once when that process settles it: it finds `abandoned` and takes the
late-usage path.

**Actual amounts.** The tokens charged are the usage row's `total_tokens`, else
`prompt_tokens + completion_tokens`. The cost charged is `estimated_cost`, or
nothing (and one uncosted call) when it is NULL. Proposed: a call that
answered without reporting any token count is charged its reserved `R` tokens,
and its usage row keeps NULL token columns. An answered call is always
settled, never released.

**Reserve, step by step**, in one transaction, before the call is sent:

1. For a durable run, `assertJobClaim(tx, claim)` (claim fencing), so a worker
   that lost its lease cannot start new calls.
2. Read the chain (each run's `parent_run_id`, which never changes after the
   run is created) and lock it, root first (section 6.5). For each run read
   `status`, `budget`, the inclusive and reserved totals, `duration` and
   `active_since`:

   ```sql
   SELECT id, parent_run_id, status, budget,
          inclusive_calls, inclusive_tokens, inclusive_cost,
          reserved_calls, reserved_tokens, reserved_cost,
          duration, active_since
     FROM _smrt_ai_runs
    WHERE id = $1
      FOR UPDATE;          -- PostgreSQL only; one statement per run
   ```

3. Check, in code, with the limits taken from each run's stored `budget`: every
   ancestor is `running`, and every run has room (section 6.3). Limits are read
   inside the locked transaction, so they cannot change underneath it; a budget
   is only ever changed when a stopped run is resumed.
4. If a check fails: set the calling run to `stopped` with the reason and
   `stopped_by_run_id`, insert nothing else, and commit. Only the calling run's
   row changes; the others find out at their own next reservation.
5. Otherwise, for each run, root first:

   ```sql
   UPDATE _smrt_ai_runs
      SET reserved_calls  = reserved_calls  + 1,
          reserved_tokens = reserved_tokens + $2,
          reserved_cost   = reserved_cost   + $3
    WHERE id = $1;
   ```

   then insert the `call` event (`reservation = 'reserved'`, the amounts, the
   call id) and commit. The model is called **after** the commit.

**Settle, step by step**, in one transaction, when the call ends with usage:

1. Lock the chain, root first.
2. Move the event:

   ```sql
   UPDATE _smrt_ai_run_events
      SET reservation = 'settled', status = $3
    WHERE run_id = $1 AND call_id = $2 AND type = 'call'
      AND reservation = 'reserved'
   RETURNING reserved_tokens, reserved_cost;
   ```

   If no row came back, try `released` or `abandoned` → `settled_late` the same
   way. If that also returns nothing, the call was already settled, or (when no
   `call` event exists at all) it is unreserved usage.
3. Insert the usage row: `INSERT INTO _smrt_ai_usage ... ON CONFLICT (id) DO
   NOTHING RETURNING id`, with `id = call_id`.
4. Apply the changes in the table above to each run, root first. For
   unreserved usage, charge only if step 3 inserted the row; this is the one
   case where the insert, not the event, guards against charging twice.

**Release** is the same transaction with `reserved` → `released` in step 2, no
usage row, and only the `reserved_*` subtraction in step 4.

**The usage pipeline.** Today usage rows are written by
`AiUsagePersistenceHandler`, one of possibly several pluggable handlers, each
called outside any transaction, whose failures are logged and swallowed. For
a call inside a run:

- The tracked client captures the call's usage event and writes the usage row
  **inside the settle transaction** (step 3), with the same insert the
  persistence handler uses.
- It then hands the event to the handlers as today. The persistence handler's
  insert finds the row already there and does nothing; other handlers run as
  before, outside the transaction, and their failures are logged.
- If the settle transaction fails after the provider has answered, it is
  retried (section 6.5). The caller still gets the answer. Proposed: if every
  retry fails, the settlement is kept in a per-database pending list in the
  process and written before that database's next reservation; a run's next
  reservation does not go ahead until its own pending settlements are written.
  If the process ends first, the reservation stays `reserved` until
  reconciliation abandons it, so the room is returned, but the spend is lost:
  the same documented limit as a lost provider response.

A call outside any run has no reservation; its usage row is written by the
persistence handler, deduplicated on `id = call_id`.

### 6.5 Transactions and lock order

Every accounting transaction (reserve, settle, release, abandon, step start,
totals repair) is short, never spans a model call or an action, and is safe
to retry as a whole, because every move is guarded by its expected state.

**Lock order.** All transactions take row locks in one total order:

1. the job row, when claim fencing asserts it (durable runs);
2. run rows in increasing **depth** (a root run is depth 0, its children 1, and
   so on), and among runs at the same depth, in increasing `id`;
3. event rows, which are only inserted or updated while their run's row is
   locked.

A chain from the root to a run has one run per depth, so "root first" follows
this order. Today no transaction locks a subtree, because subtree stops are
noticed lazily (section 6.2); any future operation that does must follow the
same order. Two transactions that take locks in one total order cannot
deadlock.

| Engine | How the transaction runs |
|---|---|
| PostgreSQL | Default `READ COMMITTED`. Rows are locked with `SELECT ... FOR UPDATE` in the order above, one statement per row, because a multi-row `FOR UPDATE` does not lock in a guaranteed order. Conflicts on unique keys use `ON CONFLICT DO NOTHING`, which never aborts the transaction. Any other error aborts it: roll back and retry the whole transaction. Proposed: `SET LOCAL lock_timeout = '5s'`. |
| SQLite | `db.transaction()`. Every SQLite adapter in `@happyvertical/sql` begins it with `BEGIN IMMEDIATE`, so the write lock is taken at the start and two transactions never both try to upgrade to a writer. Within one process, `withEmbeddedWriteTransaction` queues writers. Another process holding the lock gives `SQLITE_BUSY` at `BEGIN`: the adapter discards that connection, and the whole transaction is retried on a new one. |
| DuckDB | Optimistic: a conflicting write is reported as a transaction conflict instead of waiting. The adapter runs one transaction at a time per database handle, and `withEmbeddedWriteTransaction` queues writers within the process, so conflicts are rare; when one is raised the transaction is rolled back and retried as a whole. DuckDB has no savepoint: an accounting step called inside a caller's transaction uses that transaction's handle, never a nested one. |

Proposed: a failed accounting transaction is retried up to 5 times, with a
jittered delay growing from 10 ms to 500 ms. A reservation that still fails
fails the call before it is sent.

### 6.6 Checking and repairing totals

Because run totals change only inside the transactions above, together with
the event that justifies each change, they do not drift through crashes or
retries. Drift would come only from a bug or a hand edit, so totals are never
rebuilt automatically, and resuming never recomputes them.

Proposed: `checkAiRunTotals(runId)` compares a run's own totals with its usage
rows. It can do so only while every `settled`, `settled_late` and `unreserved`
call event of the run still has its usage row; otherwise it reports the run as
unverifiable, never as wrong.

Proposed: `repairAiRunTotals(runId)` is an explicit operator action. It
refuses an unverifiable run. Otherwise it recomputes the run's own totals from
its usage rows, takes the difference from the stored values, and adds that
difference to the run's own and inclusive totals and to the inclusive totals
of every ancestor, in one chain transaction, root first. It never touches
descendants (their totals are their own) and never touches `reserved_*`
(reservations are returned only by settle, release and reconciliation).

### 6.7 Recovering after a crash

A process can die between reserve and settle. The records that make recovery
possible are the `call` events still `reserved` and the usage rows. A
transaction that dies half-way rolls back as a whole, so nothing is ever
half-applied.

**Stale reservations.** A `call` event still `reserved` after its threshold is
abandoned (the move in section 6.4), in one chain transaction. The threshold
is the smallest `callTimeoutMs` on the chain plus a grace period. Proposed: the
grace period is one minute, and when no `callTimeoutMs` is set the threshold is
one hour. Abandoning a call whose
process is in fact still running is safe: when that process settles, the late
usage is charged once and the reservation is not returned twice.

Reconciliation runs when a stopped or crashed durable run is claimed for
resume, and from a periodic sweep. Proposed: the sweep is a task named
`ai-runs` in the retention sweep.

**Durable runs** are run by a background job with a lease. When the lease
expires the job is claimed by another worker, which reconciles the run's stale
reservations and resumes from the checkpoint. Proposed: if the job ends for
good (failed or cancelled) while the run is still `running`, the run is set to
`failed` with `error`, or `stopped` with `cancelled`, to match; the sweep
catches any run left behind.

**Runs that are not durable** (a fusion, a chat turn) have no lease and cannot
resume. Proposed: the sweep sets such a run to `failed` with `abandoned` when
it is `running`, has no `call` event still `reserved`, and has had no event or
run-row write for 24 hours (configurable). Proposed: only a durable run may
wait for approval, because waiting needs a checkpoint to resume from.

A call that was running when its process died, whose provider response was
lost, is never charged. That is the documented limit of best-effort
accounting.

### 6.8 What a resumed run keeps

The budget limits stay as they were unless the resume raises them (up to the
app's ceiling). Spending already made stays counted. The run continues with the
remaining room; `maxDurationMs` counts active time across all resumes.

## 7. Resuming

A durable run keeps a **checkpoint** (`_smrt_ai_run_checkpoints`): the
`run_id`, a `revision`, a `lease`, `last_seq`, the `definition_version` that
wrote it, and a `state` that each run type owns, inside a versioned and
validated envelope. A workflow stores its step index, its repair count and the
accepted outputs of finished steps. The checkpoint and the run row are written
in one transaction.

- **Two saves.** The `revision` is compare-and-swap: a save that read an older
  revision fails and the caller reloads.
- **Two runners.** The revision does not stop two processes both acting. A
  durable run runs as a background job with claim fencing on, renews its lease
  while it works, and requires its actions to be safe to repeat, because after
  a lost lease the new runner may repeat the last action. Checkpoint saves and
  reservations assert the job claim; settlements do not, because spending that
  happened must be counted whoever reports it.
- **Versions.** A run resumes only under the `definition_version` that saved its
  checkpoint, unless a newer version declares that it accepts older checkpoints
  and validates or migrates them. Otherwise the run stops with reason
  `definition_changed`.
- **After a stop.** A `stopped` run resumes from its checkpoint with the same
  or a larger budget. A run that stopped at a budget limit and is resumed
  without more room stops again at once with the same reason.

## 8. Retention

- **Trajectory.** Every run keeps its whole trajectory for **30 days** after it
  finishes, by default. An app can change the period or turn on sampling. The
  decision is made **once per run**, never per call: a trajectory is kept whole
  or deleted whole.
- **Not pruned.** A run that is `running`, `waiting-approval` or `stopped`, a run
  in an experiment, and a run with `retain` set.
- **When a trajectory is deleted**, the counts of checks and approvals passed and
  failed are first saved on the run row and `trajectory_pruned` is set. The run
  row is kept.
- **Run rows.** Proposed: a run row that is not protected by the rule above is
  pruned by the usage age limit, as fusion run rows are today; a protected run
  row is never pruned.
- **Usage rows** follow their existing retention policy (by age, and
  optionally by row count). They are not part of a trajectory, and they may be
  pruned while their run is still alive; budgets do not depend on them
  (section 6.2).
- **Payloads by reference.** `payload_ref` points at content the host owns,
  such as a chat message or a file. The framework owns none of it, so pruning a
  trajectory deletes only the events, never what they point at.
- **Checkpoints of finished runs** are deleted with the trajectory.
- **Payload size.** Each event payload is capped (head and tail kept, `truncated`
  set). Full request and response text of a call is stored only when
  transcripts are enabled.
- **Privacy.** Trajectories hold user data. The tracking supports redaction
  before an event is stored, with the same redactor transcripts use.

## 9. Existing data

Every change here upgrades an existing database unattended, from the oldest
supported release; nothing needs hand-written SQL by an operator.

- **Design runs.** Existing rows of `_smrt_inference_design_runs` are dropped,
  not migrated (they exist only as example-host data on development machines).
  The table is removed by the migrator's declared **retire step**
  (`table.retire`): the owning package declares the table retired, with a
  reason and `rows: 'discard'`, and only a whole-schema migrate drops it. See
  the retired-tables section of the core schema notes.
- **Queued jobs** that target the old design-run code are marked failed.
- **Work profiles.** Saved work-profile preferences are dropped, not converted.
- **Fusion runs.** Stored `status 'ok'` becomes `'done'`, in one idempotent
  update. Proposed: stored `'degraded'` becomes `'done'` with `degraded` set,
  and `'failed'` stays `'failed'` with `stop_reason` `error`. Proposed: an old
  row gets `type 'fusion'`, `finished_at = created_at` and `started_at =
  created_at` minus `duration`, because old rows were written when the fusion
  ended.
- **Run table shape.** Proposed: `_smrt_ai_runs` is rebuilt once by the system
  compatibility step (create the new shape, copy the rows, rename, recreate the
  indexes, as already done for `_smrt_dispatch_subscriptions`), because
  `fusion_key` is renamed and `mode`, `seats` and `degraded_seats` must stop
  being `NOT NULL` for runs that are not fusions. The step runs only while the
  table still has `fusion_key`.
- **Usage call ids.** Proposed: for every existing usage row,
  `entry_call_id = call_id` and then `call_id = id`, after which the unique
  index on `call_id` is created. Fusion seat rows that shared one `call_id`
  keep that link through `entry_call_id`, and their transcripts still join.
- **Outcome labels** move to `_smrt_ai_evaluations`. Proposed: a label with a
  `usage_id` attaches to that call (`call_id = usage_id`); one with only a
  `call_id` attaches to the call whose `entry_call_id` matches, or to the shared
  run when several calls match (a fusion); one with only a `run_id` attaches to
  the run. `score` becomes `value` (`value_type 'number'`, no scale), `actor`
  becomes `evaluator` unchanged, and `metric` is `outcome`.
- **New columns** on existing tables are added by the system compatibility
  step, with a schema version bump, so a legacy database ends in the same shape
  as a fresh install.

## 10. What is deliberately not here

A model-driven loop driver, workspace tools, a sandbox, a blob store, dataset
and grader tables and an eval runner are not part of this model. The model is
shaped so that adding them later adds rows and event types rather than
renames: a coding agent would be a run type owned by the agents package, one
run per task, one event per action and observation, a grader writing an
evaluation, and many runs compared as one experiment.
