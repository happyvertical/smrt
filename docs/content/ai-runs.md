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
run laid over those records.** There is no second ledger of calls. A run keeps
running totals of what its calls spent, and those totals are what its budget
is enforced against (section 6.2). Section 6.9 follows one workflow run, with
a fusion inside a step, through a budget stop and a resume, row by row.

Lines that begin with **Proposed:** are details this page adds to the agreed
design. They are part of the specification code is built from, and they are
marked so a reviewer can accept or change each one. Everything else on the
page, including the product rules on cancelling, retrying a failed run,
waiting for approval, usage persistence and run-row retention, is decided.

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
| **Uncosted** | A call whose model is not on the rate card. Its `estimated_cost` is NULL, never zero. It is always allowed, even under a cost limit, and counted (section 6.3). |
| **Run** | One piece of AI work that has its own record: a status, a budget and a trajectory. It may contain any number of calls, including none yet. A single call made on its own is **not** a run; its usage row has no `run_id`. |
| **Run type** | The shape of the work. An open string. The framework's own types are `fusion`, `turn` and `workflow`. A type defined by an app or package carries its owner's namespace. A reader must cope with a type whose code is not loaded: it shows the row and does not interpret the type's state. |
| **Definition** | One specific task of a run type, with a `definition_key` and a `definition_version`; for example one workflow definition, or one fusion. Apps add definitions often and run types rarely. |
| **Workflow run** | A run of type `workflow`. The host fixes the order: a list of **steps**, each with a schema-checked output and a host check. It is linear, with repair and an approval pause; there is no branching and no parallel step. It replaces "design run". |
| **Step** | One host-defined stage of a workflow. It replaces "pass". In a model-driven loop the equivalent round is an **iteration**. Each time a step is started it is a new **step instance**, with its own `step_instance_id`. |
| **Attempt** | One try at a step's call. A repair is attempt 2 of the same step. |
| **Durable** | A property of a run, not a run type: a durable run keeps a checkpoint and can be resumed after a restart. Any run type can be durable. Only a durable run may wait for approval. |
| **Checkpoint** | The saved state a durable run resumes from. |
| **Stop, cancel** | A **stop** pauses a run with a reason; a durable run can be resumed from it. A **cancel** ends a run for good: a cancelled run is never resumed. |
| **Retry** | A new run that picks up the completed steps of a failed durable workflow run and names it in `retry_of_run_id`. A failed run is never resumed in place (section 7). |
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
   call_id, entry_call_id, run_id, prompt_key, template_hash,              |
   tier_requested, tier_resolved, step_index, step_instance_id,            |
   attempt, tokens, estimated_cost                                         |
    |                          |                                           |
    | run_id                   | entry_call_id                             |
    | (none for a call         v                                           |
    |  on its own)          transcript (_smrt_ai_transcripts)              |
    v                       opt-in text of one entry call                  |
 run (_smrt_ai_runs)                                                       |
   type, definition, status, budget, totals                                |
   parent_run_id ----> the parent run (none for a root run)                |
   retry_of_run_id --> the failed run it retries (none otherwise)          |
    |                                                                      |
    +-- events (_smrt_ai_run_events), ordered by seq, each with run_id     |
    |     call event ------------------ call_id ---------------------------+
    |     handoff event --- child_run_id ---> a child run
    |     action, observation, check, approval
    |
    +-- checkpoint (_smrt_ai_run_checkpoints), durable runs only

 evaluation (_smrt_ai_evaluations): on exactly one call (call_id)
                                    or exactly one run (run_id)
```

Reading the picture:

- A **call** names the prompt it used. A run does not ask for a prompt; its
  calls do, and different steps of one run may use different prompts.
- The **usage row is the ledger of calls**. One row per call, written when the
  call ends, carrying `run_id` when the call belongs to a run. It is the record
  billing and reports read. An event of type `call` is only a pointer to its
  usage row, so no event repeats a call's cost.
- The **run row** is written when the run starts, updated at step boundaries
  and when a call reserves or settles budget (not on every event), and closed
  at the end. It carries running totals, added to as each call settles. They
  are the authority for the run's budget and are never rebuilt automatically
  (see [section 6](#6-budgets-and-how-they-are-accounted)).
- `parent_run_id` points **up**, from a child run to the run that started it.
  `retry_of_run_id` points **back**, from a retry to the failed run it picks
  up from.
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
`call_id` gets no unique index of its own: it equals the primary key, so a
second unique constraint would add nothing, and DuckDB checks unique indexes
eagerly, so updating an indexed column (as the upgrade in section 9 does) can
report a violation that is not there.

Today `call_id` holds something else: the id of the entry call, shared by
every seat row of a fusion, and minted only while transcripts are on. That
meaning moves to `entry_call_id`. `_smrt_ai_transcripts` is unchanged; its
`call_id` column holds an entry call id, so a transcript joins to usage on
`_smrt_ai_usage.entry_call_id = _smrt_ai_transcripts.call_id`. Proposed: the
existing non-unique index on `_smrt_ai_usage(call_id)` is replaced by one on
`entry_call_id`, which that join uses; `call_id` lookups use the primary key.

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
| `prompt_key`, `template_hash` | The prompt key (kept) and prompt version (new) of the entry call that started the run, if any. A fusion's seats may use prompts of their own; these say which prompt the fusion answered. |
| `owner_id`, `parent_run_id` | Who started it; the run that started it. |
| `retry_of_run_id` | For a retry, the failed run it retries (section 7); NULL otherwise. A plain reference: it may name a run whose row has since been pruned. |
| `experiment_id`, `dataset_item`, `tags` | Grouping. `tags` records **what was varied** in the run (for example the model or the template version under test), so runs can be compared. |
| `status`, `degraded`, `stop_reason` | How it stands (below). |
| `stopped_by_run_id` | The run whose limit or stop stopped this one: itself, an ancestor, or a child whose own limit stopped it (section 6.2). |
| `stop_detail` | A JSON column. For a stop at a budget limit: which limit, how much was asked for and how much room was left (section 6.4). NULL for any other stop. |
| `budget` | The limits, as JSON (section 6.1). |
| `tokens`, `cost_used`, `calls`, `uncosted_calls`, `steps_used`, `duration` | **Own totals**: this run's own calls and steps. `duration` is active time in milliseconds, following the existing `duration` columns. |
| `active_since` | When the current active period began; NULL while stopped, waiting or finished. |
| `inclusive_tokens`, `inclusive_cost`, `inclusive_calls`, `inclusive_uncosted_calls` | **Inclusive totals**: own totals plus those of every descendant run. |
| `reserved_tokens`, `reserved_cost`, `reserved_calls` | Room held for calls in flight, inclusive of descendants. |
| `checks_passed`, `checks_failed`, `approvals_given`, `approvals_refused` | Counts saved when the trajectory is pruned (section 8). |
| `retain`, `trajectory_pruned` | Retention flags. |
| `started_at`, `finished_at`, `created_at` | `created_at` is kept as the row's insert time, so its indexes and retention keep working; for a new run it equals `started_at`. |
| `mode`, `seats`, `degraded_seats`, `details` | Kept for fusion runs, as today: the fusion's mode, seats that ran, seats degraded, and per-seat identities as JSON. NULL for other run types. |

Proposed: the column names `stopped_by_run_id`, `stop_detail`,
`retry_of_run_id`, `uncosted_calls`, `inclusive_uncosted_calls`,
`active_since`, `checks_passed`, `checks_failed`, `approvals_given` and
`approvals_refused`, and the run-row `template_hash`.

Steps and duration have **no inclusive total**. A child run's steps are its
own, and a child runs inside its parent's active time, so adding the child's
duration to the parent's would count the same time twice.

`status` is one of:

| Status | Meaning |
|---|---|
| `running` | Work is in progress (or was, and nothing has said otherwise yet). |
| `waiting-approval` | Paused at an approval event until a person decides. Resumable. Durable runs only (section 6.7). |
| `stopped` | Paused with a `stop_reason`: a budget limit, an interruption or a definition change. **Resumable** when the run is durable; final when it is not (below). |
| `cancelled` | Ended for good by the host or a person. Never resumed and never retried. Final. |
| `failed` | Something went wrong. Never resumed in place; a failed durable workflow run may be retried as a new run (section 7). Final. |
| `done` | Finished. Final. |

`finished_at` is set when a run reaches `cancelled`, `failed` or `done`, and
when a run that is not durable stops.

**A stopped run that is not durable.** A fusion or chat turn that stops (at a
budget limit, say) has no checkpoint, so it cannot be resumed. Its stop is
final for that run: it keeps status `stopped` and its typed reason, so a reader
still sees that a limit was reached and not that something broke,
`finished_at` is set, and retention treats it as finished (section 8). The
work goes on only through a durable ancestor, which on resume repeats the step
with a new child run, or, for a root run, by the host starting a new run.

**Status changes are guarded.** Every change of `status` is a conditional
update from the status the writer expects:

```sql
UPDATE _smrt_ai_runs
   SET status = $3, stop_reason = $4, ...
 WHERE id = $1 AND status = $2;
```

If no row changes, the run has moved on underneath the writer; the change is
refused, never applied over the newer status. The allowed moves are:

| From | To |
|---|---|
| `running` | `waiting-approval` (durable runs only), `stopped`, `cancelled`, `failed`, `done` |
| `waiting-approval` | `running` (decided and resumed), `stopped`, `cancelled`, `failed` |
| `stopped` | `running` (resumed; durable runs only), `cancelled` (durable runs only; a stopped run that is not durable is already final) |
| `cancelled`, `failed`, `done` | nothing: all three are final |

So a slow run that the sweep has already set to `failed` (section 6.7) cannot
later write `done` over it, and, because a reservation and a step start both
require the calling run to be `running` (section 6.4), it cannot make another
call either. What it already spent is still settled: settlement does not look
at status, because spending that happened must be counted.

`stop_reason` is one column holding a typed code, never free text. It says why
a run stopped, was cancelled or failed:

| Code | Status | Meaning |
|---|---|---|
| `max_steps`, `max_calls`, `max_cost`, `max_tokens`, `max_duration` | `stopped` | A budget limit was reached. |
| `interrupted` | `stopped` | The host or a person paused the run, or the host stopped it because it is shutting down. Resumable when durable. |
| `definition_changed` | `stopped` | The definition changed and does not accept the run's checkpoint. |
| `cancelled` | `cancelled` | The host or a person ended the run for good. |
| `repairs_exhausted`, `check_failed` | `failed` | A step's output never passed. |
| `abandoned` | `failed` | The process running a run that is not durable disappeared (section 6.7). |
| `error` | `failed` | Anything else that went wrong. |

**Interrupting and cancelling are different.** An interruption pauses: a
durable run stopped with `interrupted` is resumed later, from its checkpoint,
exactly as after a budget stop. A cancel ends: the run moves to the final
status `cancelled` with reason `cancelled`, is never resumed or retried, and
is not protected from retention as a resumable run (section 8). Cancel is not
used for a shutdown, and `interrupted` replaces the earlier `host_stopped`.
Cancelling a run sets `stopped_by_run_id` to the run itself.

**A cancel reaches every descendant at once.** A running descendant would
notice a cancelled ancestor at its next reservation, but a durable descendant
that is `stopped` or `waiting-approval` never reserves, so it would never
notice: it would stay protected from retention forever (section 8), its
cancelled ancestor could be pruned before it, and resuming it would read a
missing ancestor chain. So a cancel moves the run **and every descendant that
is not final** (`running`, `waiting-approval`, or a durable `stopped`) to
`cancelled`, in the same call and the same transaction, locking the run and
then its descendants in the lock order of section 6.5 (shallowest first).
Each descendant gets reason `cancelled`, `stopped_by_run_id` set to the
cancelled run, `stop_detail` NULL and `finished_at` set. A descendant already
final, including a stopped run that is not durable, is left as it is. Calls a
cancelled descendant already has in flight still settle (settlement does not
look at status). A descendant opened under the run while the cancel was
running, or one left behind for any other reason, is repaired by the
`ai-runs` sweep (section 6.7).

Proposed: the code `interrupted` (rather than `host_stopped`), because the
stop is the same whether a host, a person or a shutdown asked for it, and the
status `cancelled` (rather than `stopped` or `failed` with a `cancelled`
reason), because `stopped` means resumable and `failed` means something went
wrong. `abandoned` is a new code. There is no stop for a call to a model with
no price: such a call is allowed (section 6.3).

**A failed run is never resumed in place.** A host may **retry** a failed
durable workflow run from its last accepted step: it opens a new run with
`retry_of_run_id` naming the failed run, and that new run picks up the
completed steps of the failed one (section 7). To make that possible, a failed
run's checkpoint is kept after its trajectory is pruned, for as long as the
failed run's row is kept (section 8).

A worker that loses its lease does not change the run: another worker takes
the job and continues the same run. Losing a lease is something that happens
to a worker, so it is not a reason on the run.

### Event row

`_smrt_ai_run_events` has: `id` (stable), `run_id`, `seq`, `parent_event_id`,
`type`, `call_id`, `step_index`, `name`, `status`, `duration`, `payload`,
`payload_ref`, `truncated`, `created_at`, `child_run_id` (for a `handoff` to a
child run), and, for `call` events only, the reservation: `reservation` (its
state, section 6.4), `reserved_tokens` and `reserved_cost`. The reservation
amounts and the child run are typed columns, never part of the payload,
because a payload may be capped, cut or redacted.

Proposed: the columns `reservation`, `reserved_tokens`, `reserved_cost` and
`child_run_id`, and an index on `(type, reservation, created_at)` for the
sweep in section 6.7.

| Event type | What it records |
|---|---|
| `call` | A model call. Points at its usage row through `call_id`. Written when the call reserves room, before it is sent. |
| `action` | Something the run did: a tool call, a write, a command. |
| `observation` | What came back from an action. |
| `check` | A host check of a step's output, passed or failed. |
| `approval` | A person's decision, requested or given. |
| `handoff` | Work passed to another run, a person or an outside tool. When it is a child run, `child_run_id` names it. |

**A call answered by a child run.** When a run makes an entry call whose tier
is bound to a fusion, the calls are the fusion's seats, and their `call`
events belong to the child `fusion` run. The run that made the entry call
records a `handoff` event instead, with `child_run_id` set to the fusion run
and `call_id` set to the entry call id. It carries no reservation: the seats
reserve for themselves, against the whole chain.

Proposed: a `check` or `approval` event's `parent_event_id` is the event whose
output it judges: the `call` event, or the `handoff` event when the output came
from a child run. That link is how checks and approvals are attributed to a
prompt (section 5).

**Approval events.** An approval is two events: the **request**, with
`status` `requested`, whose `parent_event_id` is the judged event as above,
and the **decision**, with `status` `approved` or `refused`, whose
`parent_event_id` is the request event. In a durable run both are in the same
run. A chat turn does not wait (section 3): its request is in the turn that
asked, which ends `done`, and the decision is recorded in the run of the
**next** turn. That decision's `parent_event_id` points at the request event
**in another run**. This is the one place a `parent_event_id` may cross runs,
and it is allowed. It is a plain reference: the request's run may have been
pruned, so a reader must accept a decision whose request no longer resolves.

Proposed: approvals are counted per run by these rules, so neither half of a
cross-run approval skews a rate:

- A **decision** is counted in the run that recorded it, once: `approved` in
  `approvals_given`, `refused` in `approvals_refused`, whether or not its
  request is in the same run or still exists.
- A **request** is counted only as requested. It is never a decision, so a
  request with no decision in its own run (the turn that asked) counts
  neither as approved nor as refused.
- The **approval rate** is decisions approved divided by decisions made
  (`approved / (approved + refused)`). Requests are not in the denominator,
  so a turn that asked and a turn that decided each give the right rate.

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

`call_id` and `run_id` are plain references, not foreign keys. An evaluation
is never swept, so it may outlive the call or run it judged and then name an
id that no longer resolves; readers return it with an empty target (section
8).

### Checkpoint row

See [section 7](#7-resuming).

## 3. How each case is recorded

| Case | Records |
|---|---|
| `do()`, `is()`, `describe()` whose tier is bound to a model or an alias chain | One usage row per call (one, unless the chain fell back). No run. |
| `do()`, `is()`, `describe()` whose tier is bound to a fusion | A `fusion` run, as below. |
| A fusion | One `fusion` run, one usage row and one `call` event per seat. The run row is written when the fusion starts, not when it ends. |
| A chat turn | One `turn` run, one usage row and one `call` event per model call in the tool loop, `action` and `observation` events for tool use. |
| A chat turn that needs approval | The turn records a requested `approval` event and ends `done`, with the approval pending; it does not wait. The next turn carries on, and the person's decision is recorded as an `approval` event in that turn's run, as approval cards behave today. The decision's `parent_event_id` points back at the request in the earlier turn (section 2, approval events). |
| A workflow run | One `workflow` run, a checkpoint, usage rows that carry the step and attempt, one `call` event per call, `check` and `approval` events. |
| A retried workflow run | A new `workflow` run with `retry_of_run_id` naming the failed run, a checkpoint that starts with the failed run's accepted step outputs, and its own usage rows and events from the step it starts at. |
| A fusion inside a workflow step | A child `fusion` run whose `parent_run_id` is the workflow run, and a `handoff` event in the workflow run naming it. The step's `check` event points at that `handoff`. |
| A fusion inside a chat turn | A child `fusion` run whose `parent_run_id` is the `turn` run, and a `handoff` event in the turn naming it. |

A caller that wants a status, a budget or a trajectory opens a run, which
needs usage tracking (below). A caller that wants only the answer makes a
call.

The run a call belongs to is **passed explicitly**, as a run context on the
call, never read from a process-wide variable. A background job carries the run
id in its payload and rebuilds the context when it runs. Tracking is scoped to
the tenant and database the work belongs to.

**Staying on the tracked path.** Every model call goes through the tracked
client, and every tracked call carries a prompt key, resolved through
`resolvePrompt` from `smrt-prompts`. A repository check fails when code makes a
model call outside the tracked client. It has a short allow-list of
exceptions, each with a written reason.

**Runs need usage tracking.** Opening a run requires usage persistence (usage
tracking) to be on for the run's database. When it is off, opening a run of
any type fails with a typed `AiRunTrackingDisabledError` that says so, before
any call is sent. Fusions and chat turns do not run untracked: a fusion, a
`do()`, `is()` or `describe()` whose tier is bound to a fusion, and a chat
turn all fail with that error until persistence is turned on. Single calls
(a tier bound to a model or an alias chain) still work without it; they open
no run, and no usage row is written for them.

**Tracking switched off while a run is open.** The check is made **only when
a run opens**. Resuming a stopped run, a step start, a reservation and a
settlement do not make it again. Every settlement of an open run writes its
usage row inside the settle transaction (section 6.4) whatever the setting
says by then, because the run's totals and its `settled` events must agree
with the ledger. So a run opened while tracking was on finishes with every
call it made recorded; only runs opened after tracking was turned off are
refused, and single calls made after that write no usage row. The other usage
handlers follow their own settings.

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
| Check pass rate | `check` events whose judged event (its `parent_event_id`) used the group's prompt and template, passed divided by all. A judged `call` event is attributed through its usage row; a judged `handoff` to a fusion, through the fusion run's `prompt_key` and `template_hash`. |
| Approval rate | Decision events (`approved` or `refused`), attributed through their request (`parent_event_id`) to the request's judged event, the same way as a check; approved divided by decided. Requests are not counted. A decision whose request no longer resolves (its run was pruned) cannot be attributed to a prompt and is left out here, though it still counts in its own run (section 2). |
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
used. A check on a fusion-backed step is counted against the prompt the fusion
answered, not against its seats' prompts:

```sql
SELECT COALESCE(u.template_hash, f.template_hash) AS template_hash,
       chk.status, COUNT(*) AS checks
FROM _smrt_ai_run_events chk
JOIN _smrt_ai_run_events j
  ON j.id = chk.parent_event_id AND j.type IN ('call', 'handoff')
LEFT JOIN _smrt_ai_usage u
  ON j.type = 'call' AND u.id = j.call_id
LEFT JOIN _smrt_ai_runs f
  ON j.type = 'handoff' AND f.id = j.child_run_id AND f.type = 'fusion'
WHERE chk.type = 'check'
  AND COALESCE(u.prompt_key, f.prompt_key) = :promptKey
GROUP BY COALESCE(u.template_hash, f.template_hash), chk.status;
```

These per-prompt measures cover runs whose trajectory is still kept and whose
judged call still has its usage row (or whose judged fusion still has its run
row). The check and approval counts saved on a
pruned run (section 8) are per run, not per prompt, so they serve per-run and
per-definition reports and are **not** part of per-prompt measures.

## 6. Budgets and how they are accounted

In plain terms: a budget caps what a run, and every run it starts, may spend.
Just before each model call the framework sets aside (**reserves**) a fair
estimate of what the call will use, in the calling run and in every run above
it, and refuses the call if any of them lacks room. The run then stops with a
reason that names the limit, and a durable run can be resumed once that limit
is raised. When the call ends, the estimate is swapped for what the call
really used. Totals change only in short database transactions, each written
together with the event that justifies it, so a crash or a retry never counts
a call twice, and room set aside by a process that died is given back when its
run is recovered. Token and cost limits are close, not exact: a call can use
more than was set aside, and that excess is always counted but can carry a run
a little past its limit (section 6.3 says by how much).

### 6.1 The limits

A budget is a set of optional keys, stored as JSON in the run's `budget`
column:

| Key | Limit |
|---|---|
| `maxSteps` | Steps the run may start. |
| `maxCalls` | Calls the run may make, its descendants' included. |
| `maxCost` | Cost, in the rate card's unit, descendants included. Bounds priced calls only; **approximate** (section 6.3). |
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
run is resumed. A resume asking for more than the ceiling is refused, and so
is a resume that changes none of the limits that stopped the run (section 7).

### 6.2 What is counted, and where

The rule: **usage rows are the ledger for billing and reporting; a run's
totals are the authority for budget enforcement, and they are never rebuilt
automatically.**

- **Usage rows** are the ledger of calls: one row per call, the record that
  prompt reports and billing read. They are pruned on their own schedule
  (section 8), even while a run that made them is still alive, so a budget is
  never checked against them.
- **Run totals** (own, inclusive, reserved) are what every budget check reads.
  They change only in the same transaction as a reservation, settlement,
  release or abandonment, together with the event that justifies the change.
  Nothing recomputes them on its own; recomputing them from usage rows is an
  explicit operator repair (section 6.6).

A call is charged **once**. It is added to the own totals of the run that made
it and to the **inclusive** totals of that run and of each ancestor. It is never
added to an ancestor's own totals. Each run's `maxCalls`, `maxTokens` and
`maxCost` are checked against that run's inclusive numbers, so a child's
spending counts against its own budget, its parent's and every ancestor's.
`maxSteps` and `maxDurationMs` are checked against the run's own numbers only.

Proposed: when an ancestor's limit is reached, or an ancestor is stopped, its
descendants stop as well, each at its own next reservation or step start. Each
one moves to `stopped` with the ancestor's reason and copies the ancestor's `stopped_by_run_id` (the ancestor itself,
unless something below it stopped it) and `stop_detail`. No stop writes a
whole subtree. A **cancel** is the one exception: it is written to every
descendant that is not final at the moment of the cancel (section 2). Because
both lock the descendant's row, a descendant's reservation either commits
before the cancel (its call is sent and settles normally) or after it, and
is then refused because the run is no longer `running` (section 6.4).

**A child's stop reaches its parent as a stop, never as a failed call.** When
an entry call is answered by a child run (a fusion inside a workflow step or a
chat turn) and that child stops or is cancelled, whether at a limit of its own
or of an ancestor, or because it or an ancestor was interrupted or cancelled,
the entry call returns neither an answer nor an ordinary failure. Proposed: it
raises a typed `AiRunStoppedError` carrying the child's `status`,
`stop_reason`, `stopped_by_run_id` and `stop_detail`.

**The framework writes the parent's stop, before it raises.** Proposed: the
tracked client first moves the run that made the entry call out of `running`
with the child's status, reason, `stopped_by_run_id` and `stop_detail` (a
guarded change, section 2; if the run has already left `running`, nothing is
written), and only then throws `AiRunStoppedError`. One exception: a child
that was cancelled on its own (its `stopped_by_run_id` is the child itself)
does not cancel its parent; the parent moves to `stopped` with `interrupted`,
so the host decides whether to resume it, which repeats the step with a new
child, or to cancel it. The stop is in the database, not only in the
exception, so catching the error does not revive the run: if host step code
catches it and returns a fallback answer, the run is still `stopped` (or
`cancelled`), its next reservation or step boundary is refused (section 6.4),
and the step is not recorded as completed.

Because it is a stop, the run that made the entry call does not count a
failed attempt, does not use a repair, and does not end `failed`: a workflow
step whose fusion stopped on the root's `maxTokens` leaves the workflow
`stopped` with `max_tokens`, resumable once the budget is raised, and never
`failed` with `repairs_exhausted` (section 6.9 walks through exactly this). The same holds up any depth of nesting.
Proposed: a fusion whose reservation is refused stops; it does not go on as
`degraded` with fewer seats, because a degraded answer would hide the stop.

**When the child's own limit stopped it.** If the limit was on the child's own
budget (for example a budget set on the fusion's definition),
`stopped_by_run_id` names the child, on the child and on every run the stop
reached. Raising the parent's or the root's budget does not help: the resumed
parent repeats the step with a new child under the same definition budget,
which stops at the same point. The definition's budget is the one that has to
change. Proposed: a resume that changes none of the limits that stopped the
run is refused with a typed error (section 7), so a host that resumes
automatically after a budget stop without changing a budget gets that error,
not a loop. A host must not resume a budget-stopped run automatically without
a budget change.

### 6.3 How much a call reserves

A reservation is a fair estimate of one call, not its worst case. This
section says how large it is, what it is checked against, and how far real
spending can go past it.

Before a call is sent, the tracked client works out what to hold for it:

- `E`: the estimated input tokens of the request.
- `O`: the request's own output-token limit, if it sets one.
- `M`: the smallest `maxCallTokens` on the run and its ancestors, if any.

| Case | Output limit sent to the provider | Tokens reserved `R` |
|---|---|---|
| `M` is set | `min(O, M - E)` (`M - E` when `O` is not set) | `E` + that output limit |
| `M` is not set, `O` is set | `O` | `E + O` |
| Neither is set | none | `E + D` |

Proposed: when `M` is set, the output limit sent to the provider is shrunk to
`M - E` if the request's own limit is larger or absent, so a call cannot exceed
`maxCallTokens` by answering at length. `maxCallTokens` already covers input
and output, so the input is counted once.

Proposed: `M - E` below 1 means the request's input alone does not fit: the
call fails before it is sent, and nothing is reserved.

`D` is a default output allowance. It only sizes the reservation; it is never
sent to the provider. Proposed: `D` is the output allowance the prompt
declares on its definition (`expectedOutputTokens`), else 4,096, and never more
than the model's maximum output where the model's capabilities record it.
`E` is the provider's token count when the client offers one, else the
request's characters divided by 4.

`D` is deliberately **not** the model's maximum output. Reserving that would
overstate every call: under a `maxTokens` of 100,000, three fusion seats on a
model with a 64,000-token maximum would have the first seat hold about 66,000,
and the second seat would be refused with about 2,000 actually spent. The cost
estimate is built from the same `R`, so `maxCost` would refuse early in the
same way. A call with no output limit can spend more than `R`; the difference
is overshoot, like a cost estimate's. Overshoot is charged in full when the
call settles, so it changes only how many calls are let in, never the totals.
A host that needs a hard bound on one call sets an output limit on the request
or the prompt, or sets `maxCallTokens`.

The cost reserved is `C = E × input price + (R - E) × output price`, per 1,000
tokens, from the rate card. The call reserves one call, `R` tokens and `C`
cost (no cost for an uncosted call, below).

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

**One call at a time, except a fusion.** Each call reserves its own `R`, never
"all the room left", so one call does not take the room the next one needs.
Proposed: the calls of a fusion, every panel seat **and the judge**, reserve
**together**, in one transaction, all or none. If the chain lacks room for the
whole fusion, no seat is sent and the fusion stops with the limit's reason,
before anything is spent; the panel can never spend and then find no room for
the judge. The judge's reservation is sized like any seat's: its output
allowance is its own output limit, else its prompt's `expectedOutputTokens`,
else `D`; its `E` is its prompt plus the panel seats' reserved output
allowances, because the panel's answers are its input. The judge is later
sent under that reservation and does not reserve again; just before it is
sent the fusion checks, in a short transaction, that it and its chain are
still `running`, and if not it releases the judge's reservation and stops with
the reason it found. If the judge is never sent (every panelist failed), its
reservation is released. A judge whose real input turns out larger than its
`E` is charged in full when it settles, like any overshoot (below).

A call whose reservation is refused does not run; calls already sent finish
and settle normally.

**Calls to models with no price.** A call whose model has no price on the
rate card is always allowed, whether or not the run or an ancestor has a cost
limit; it is never refused and never stops the run for want of a price. It
reserves no cost, adds nothing to `cost_used`, and adds one to
`uncosted_calls` on its run and to `inclusive_uncosted_calls` on its run and
every ancestor, so a reader knows the cost total is a lower bound. `maxCost`
applies only to priced calls. The token, step, call-count and time limits
apply to every call, priced or not. So a cost-capped run on a local model or a
CLI engine (which have no price) runs under its other limits.

**How far a run can go past a limit.** A call's real use is known only when
it ends, and settlement charges it **in full**, even beyond what was reserved.
So when a limit is reached, the calls already in flight in the run and its
descendants still settle, and the run can end above its `maxTokens` by up to
the sum, over those calls, of each call's excess. For one call the excess is:

- **output**: the model's maximum output minus the output allowance it
  reserved (`R - E`), when no output limit was sent to the provider (the
  "neither is set" row above); zero when one was sent, because the provider
  stops there;
- **input**: its real input minus `E`, when `E` was estimated from characters
  instead of counted by the provider.

The excess cost is those excess tokens at the rate card's prices, so
`maxCost` is bounded the same way. Where the model's maximum output is not
recorded, the output excess has no bound; a host that needs one sets an output
limit on the request or the prompt, or sets `maxCallTokens`. Once the excess is
charged, the next reservation sees it and is refused. Two other cases can go
past a limit, and each is bounded where it is described: a settlement waiting
on the pending list (section 6.4), and a call whose provider response was lost
(section 6.7).

**Steps.** A step is counted **once per run, by its `step_index`**. Starting a
step whose index the run has not counted before checks, in the transaction
that records the step boundary (with the checkpoint, for a durable run), that
the run is `running`, that `steps_used + 1 <= maxSteps` on the run's own row,
and `maxDurationMs`, and adds one to `steps_used`. Re-entering a step that was
already counted and not completed, because the run was resumed after a stop
or a crash, checks `running` and `maxDurationMs` but neither checks nor counts
`maxSteps` again. Proposed: the checkpoint records the highest step index
counted, and since a workflow is linear, a step is new exactly when its index
is greater. So a run stopped and resumed any number of times at the same step
can never reach `maxSteps` by doing so. A re-entered step still gets a new
`step_instance_id`, so reports tell the entries apart, and what it spends
again is counted by the token, cost and call limits. A repair is an attempt
of the same step instance, never a step. A run that is no longer `running`
starts nothing, completes nothing and writes nothing. If a limit fails, the
run stops with `max_steps` or `max_duration` and the step does not start.

**Duration.** `duration` accumulates closed active periods; `active_since`
marks the open one. The current active time is `duration + (now -
active_since)`. Every write of the run row (step boundaries, reservations,
settlements, status changes) folds the open period into `duration`; stopping or
waiting for approval closes it and sets `active_since` to NULL; resuming opens
a new one.

### 6.4 The reservation's life: reserve, settle, release

Each call's reservation is written on its `call` event, in the `reservation`
column, and moves from state to state as the call goes. Every move is a
conditional update that succeeds only from the expected state, so the same
move can never be applied twice. The worked example (section 6.9, points B,
C, E and F) shows a call reserved and settled, a fusion's joint reservation
refused, and the same reservation succeeding after a resume. The states are:

| State | What it means | Room still held | Call charged |
|---|---|---|---|
| `reserved` | Room is set aside; the call is about to be sent, or is in flight. | Yes | Not yet |
| `settled` | The call ended with usage; the estimate was swapped for what it used. | No | Yes |
| `released` | The call ended without usage (failed, timed out, cancelled). | No | No |
| `abandoned` | Recovery found the call's process gone and no usage row (section 6.7). | No | No |
| `settled_late` | Usage arrived after a release or an abandonment, and was charged. | No | Yes |
| `unreserved` | Usage arrived for a call of the run that never reserved. | No | Yes |

And the moves between them:

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
| **Abandon** (reconciliation, section 6.7; only when no usage row with `id = call_id` exists, else the call is settled) | `reserved_*` -= the event's amounts | `reserved` → `abandoned`; `status` = `abandoned`. |
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

The three moves a call makes in normal running, reserve, settle and release,
are each one short transaction. Step by step:

**Reserve**, in one transaction, before the call is sent:

1. When the calling run or any ancestor is durable, `assertJobClaim(tx,
   claim)` (claim fencing) for the nearest durable run in the chain, so a
   worker that lost its lease cannot start new calls, including in child runs
   it started.
2. Read the chain (each run's `parent_run_id`, which never changes after the
   run is created) and lock it, root first (section 6.5). For each run read
   `status`, its stop fields, `budget`, the inclusive and reserved totals,
   `duration` and `active_since`:

   ```sql
   SELECT id, parent_run_id, status,
          stop_reason, stopped_by_run_id, stop_detail, budget,
          inclusive_calls, inclusive_tokens, inclusive_cost,
          reserved_calls, reserved_tokens, reserved_cost,
          duration, active_since
     FROM _smrt_ai_runs
    WHERE id = $1
      FOR UPDATE;          -- PostgreSQL only; one statement per run
   ```

3. Check, in code, with the limits taken from each run's stored `budget`: the
   calling run **and** every ancestor is `running`, and every run has room
   (section 6.3). Limits are read inside the locked transaction, so they
   cannot change underneath it. Proposed: a budget is only ever changed when a
   stopped run is resumed.
4. If the calling run itself is not `running` (it was stopped, cancelled,
   failed or abandoned underneath its process), refuse the call, write
   nothing, and commit; the caller gets the run's own status and reason. If
   another check fails: set the calling run from `running` to `stopped` with
   the reason, `stopped_by_run_id` and `stop_detail` (a guarded change,
   section 2), insert nothing else, and commit. When a run lacked room,
   `stopped_by_run_id` is that run (the calling run or an ancestor) and
   `stop_detail` describes its limit (below). When an ancestor was no longer
   `running`, the calling run takes that ancestor's `stop_reason`,
   `stopped_by_run_id` and `stop_detail`, and moves to `cancelled` instead of
   `stopped` when that ancestor is `cancelled` (section 6.2). Only the
   calling run's row changes; the others find out at their own next
   reservation.
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

**What a refused reservation records.** Proposed: a run stopped at a budget
limit gets a `stop_detail`, JSON on the run row, saying what was asked for and
how much room was left, so a host that sees `max_tokens` with nothing yet
spent can tell whether one call's reservation was larger than the whole
budget, or other calls in flight held the room. Its keys:

| Key | Value |
|---|---|
| `limit` | The budget key that refused: `maxCalls`, `maxTokens`, `maxCost`, `maxSteps` or `maxDurationMs`. |
| `runId` | The run whose limit it was (the same as `stopped_by_run_id`). |
| `limitValue` | That run's limit. |
| `used` | That run's total the limit is checked against: inclusive for calls, tokens and cost; own for steps and active time. |
| `reserved` | Room that run held for other calls in flight (calls, tokens and cost only). |
| `requested` | What the refused call or step asked for: 1 call, `R` tokens, `C` cost or 1 step; for a fusion's joint reservation (section 6.3), the sum over all its seats, judge included. Absent for `maxDurationMs`. |
| `room` | `limitValue - used - reserved`; zero or below when there was no room at all. |

A step start refused by `maxSteps` or `maxDurationMs` records the same keys.
A run that stops because another run stopped (an ancestor, or a child through
`AiRunStoppedError`) copies that run's `stop_detail`. Stops for any other
reason leave it NULL.

**Settle**, in one transaction, when the call ends with usage:

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
`AiUsagePersistenceHandler`, one of possibly several pluggable handlers. The
recorder calls them together (`Promise.allSettled`), outside any transaction,
and logs and swallows their failures. For a call inside a run:

- The tracked client captures the call's usage event and writes the usage row
  **inside the settle transaction** (step 3), with the same insert the
  persistence handler uses.
- **The handlers run only after the settle has committed**, never before it
  and never when it failed. The persistence handler's insert then finds the
  row already there and does nothing; other handlers run as before, outside
  the transaction, and their failures are logged. So a usage row of a call in
  a run is written by its settlement, and every handler sees the call only
  once it is charged.
- If the settle transaction fails after the provider has answered, it is
  retried (section 6.5). The caller still gets the answer. Proposed: if every
  retry fails, the settlement, with its usage event, goes on a per-database
  pending list in the process, oldest first, and its handlers are not called
  yet. The list is written before that database's next reservation; a run's
  next reservation does not go ahead until its own pending settlements are
  written. Each pending settlement's handlers are called when it commits,
  in list order.

While a settlement waits on the pending list, its reservation is still held,
so other processes see the reserved `R`, but not any spend beyond it; once
reconciliation abandons the reservation (section 6.7), they see nothing for
that call until the pending settlement is written and takes the late-usage
path. In that window other processes can reserve against a shared ancestor as
if the call had not happened, and overspend it by up to the call's actual
amount. If the process ends with the settlement still on the list, the spend
is lost, and so is the usage row: the reservation is abandoned, the room is
returned, and no handler ever saw the call. That is the same documented limit
as a lost provider response.

A call outside any run has no reservation; its usage row is written by the
persistence handler, deduplicated on `id = call_id`.

### 6.5 Transactions and lock order

Every change to a run's totals happens in a short transaction. This section
says in what order those transactions lock rows, so that two of them never
deadlock, and how each database engine runs them. In the worked example
(section 6.9, point E) the fusion's joint reservation locks `W`, then `F2`.

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
this order. Stops are noticed lazily (section 6.2), so the one transaction
that locks a subtree is a **cancel** (section 2): it finds the descendants
through `parent_run_id` (which never changes) and locks the cancelled run and
then its descendants by increasing depth and, within a depth, increasing
`id`, the same order. The `ai-runs` sweep's repair of a descendant (section
6.7) locks its chain root first, like a reservation. Any future operation
that locks several runs must follow the same order. Two transactions that take
locks in one total order cannot deadlock.

| Engine | How the transaction runs |
|---|---|
| PostgreSQL | Default `READ COMMITTED`. Rows are locked with `SELECT ... FOR UPDATE` in the order above, one statement per row, because a multi-row `FOR UPDATE` does not lock in a guaranteed order. Conflicts on unique keys use `ON CONFLICT DO NOTHING`, which never aborts the transaction. Any other error aborts it: roll back and retry the whole transaction. Proposed: `SET LOCAL lock_timeout = '5s'`. |
| SQLite | `db.transaction()`. Every SQLite adapter in `@happyvertical/sql` begins it with `BEGIN IMMEDIATE`, so the write lock is taken at the start and two transactions never both try to upgrade to a writer. Within one process, `withEmbeddedWriteTransaction` queues writers. Another process holding the lock gives `SQLITE_BUSY` at `BEGIN`: the adapter discards that connection, and the whole transaction is retried on a new one. |
| DuckDB | Optimistic: a conflicting write is reported as a transaction conflict instead of waiting. The adapter runs one transaction at a time per database handle, and `withEmbeddedWriteTransaction` queues writers within the process, so conflicts are rare; when one is raised the transaction is rolled back and retried as a whole. DuckDB has no savepoint: an accounting step called inside a caller's transaction uses that transaction's handle, never a nested one. |

Proposed: a failed accounting transaction is retried up to 5 times, with a
jittered delay growing from 10 ms to 500 ms. A reservation that still fails
fails the call before it is sent.

### 6.6 Checking and repairing totals

Run totals are trusted, not recomputed. This section gives an operator two
tools: one that checks them against the usage rows, and one that fixes them
on request. The worked example (section 6.9, point F) ends with totals that
`checkAiRunTotals` agrees with.

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

When a process dies in the middle of a call, the room it reserved would stay
held for a call that will never settle. Recovery finds such reservations and
either charges them, when the call's usage row reached the table, or gives
the room back. A durable run, with the runs under it that are not durable, is
recovered by the worker that takes over its job; a run with no durable
ancestor, and anything left behind, by a periodic sweep. The worked example
(section 6.9, point E) shows what reconciliation on claim does when a
durable run is resumed after a stop.

A process can die between reserve and settle. The records that make recovery
possible are the `call` events still `reserved` and the usage rows. A
transaction that dies half-way rolls back as a whole, so nothing is ever
half-applied.

**Stale reservations.** A `call` event still `reserved` after its threshold is
reconciled in one chain transaction. The threshold is the smallest
`callTimeoutMs` on the chain plus a grace period. Proposed: the grace period is
one minute, and when no `callTimeoutMs` is set the threshold is one hour.

Reconciling a call first looks for its usage row (`id = call_id`). If one
exists, the call is **settled** from that row (`reserved` → `settled`, the row's
actual amounts charged as in settle step 4), not abandoned, so a usage row
that reached the table without its settlement still ends up counted and the
two records agree. Only when there is no usage row is the call **abandoned**
(the move in section 6.4). Abandoning a call whose process is in fact still
running is safe: when that process settles, the late usage is charged once
and the reservation is not returned twice.

Reconciliation runs when a stopped or crashed durable run is claimed for
resume, and from a periodic sweep. Proposed: the sweep is a task named
`ai-runs` in the retention sweep.

**Durable runs** are run by a background job with a lease. When the lease
expires the job is claimed by another worker, which reconciles the run and
resumes from the checkpoint. Reconciling on resume does **not** wait for the
threshold: the new worker reconciles at once every `call` event still
`reserved` in the run and in its **descendants that are not durable**, with
the usage-row check above.

**Reconciliation stops at a durable descendant.** The new worker finds
descendants through `parent_run_id`, and does not go into or below a durable
descendant. A durable descendant has its own job and lease, its reservations
assert its own claim (the nearest durable run in its chain, section 6.4), and
its own recovery reconciles it and the runs under it. The parent's resume
never changes a durable descendant's status, its reservations, or anything
below it; if that descendant's worker is alive, it carries on.

Reconciling the descendants that are not durable is safe because each of
their reservations asserted this run's claim (this run is the nearest durable
run in their chain): any reservation still held when the new claim is taken
was made under an earlier claim, by a worker that can make no further call.
Any such descendant still `running` (a fusion the old worker had started) is
set to `failed` with `abandoned`, a guarded change, so if the old worker is in
fact still alive it can neither spend more in that child nor finish it.
Without this, the dead worker's reservations would hold room for up to an
hour, and a tight budget would stop the resumed run at its first call with
`max_tokens`.

Proposed: if the job ends for good (failed or cancelled) while the run is
still `running`, the run is set from `running` to `failed` with `error`, or to
`cancelled` with `cancelled`, to match; the sweep catches any run left behind.

**Runs that are not durable** (a fusion, a chat turn) have no lease and cannot
resume. Proposed: the sweep sets such a run from `running` to `failed` with
`abandoned` when it has no `call` event still `reserved` and has had no event
or run-row write for 24 hours (configurable). If its process was only slow,
the guarded status change and the `running` check on every reservation stop
it from spending more or writing `done` over `failed` (section 2).

**Descendants left under a final ancestor.** A cancel moves the descendants
that are not final at once (section 2). The `ai-runs` sweep repairs any it
missed, and any left behind by an ancestor that ended some other way, so that
no run stays protected under an ancestor that can no longer resume it. It
moves to `cancelled`, with reason `cancelled`, in a guarded change with its
chain locked root first:

- any run that is not final and has a `cancelled` ancestor;
- any run that is `waiting-approval`, or durable and `stopped`, and has an
  ancestor that is final (`failed`, `done`, or a `stopped` run that is not
  durable) or an ancestor whose row is missing.

`stopped_by_run_id` is the nearest such ancestor, or the run itself when the
ancestor's row is missing; `stop_detail` is NULL and `finished_at` is set.

**Only durable runs wait for approval.** Waiting needs a checkpoint to resume
from, so only a durable run may move to `waiting-approval`; for a run that is
not durable the guarded change is refused. A chat turn that needs approval
does not wait: it records the requested `approval` event and ends `done` with
the approval pending, and the next turn carries on once the person decides
(section 3). So no run that is not durable is ever left `waiting-approval`.

A call that was running when its process died, whose provider response was
lost, is never charged. That is the documented limit of best-effort
accounting.

### 6.8 What a resumed run keeps

The budget limits stay as they were unless the resume raises them (up to the
app's ceiling). Spending already made stays counted. The run continues with the
remaining room; `maxDurationMs` counts active time across all resumes.

### 6.9 A worked example

One run followed from start to finish, showing every row this page
describes. The numbers are tokens; cost columns move the same way and are
left out.

**The setup.** A durable `workflow` run `W` with two steps and the budget
`{ "maxTokens": 20000 }`. Step 1 (`outline`) makes one call with an output
limit of 2,000. Step 2 (`draft`) makes one entry call whose tier is bound to a
fusion of two panelists and a judge. The fusion's definition has no budget of
its own. Each panelist's input is about 6,000 tokens and its prompt declares
`expectedOutputTokens` 3,000; the judge's own prompt is about 1,000 tokens
and declares 2,000.

**A. Start.** `openAiRun` writes `W`: `running`, `budget` as above, every total
0, `steps_used` 0, `active_since` set. Its checkpoint is revision 0 with no
step counted. No event yet.

**B. Step 1.** The step start checks `W` is `running` and has steps and time
left, adds one to `steps_used` (now 1), and writes checkpoint revision 1
(highest counted step 1) with step instance `s1`. Call `c1` has `E` 1,000 and
`O` 2,000, so `R` is 3,000 (section 6.3).

| When | `W` totals | Events of `W` |
|---|---|---|
| reserve `c1` | `reserved_tokens` 3,000, `reserved_calls` 1 | seq 1 `call`, `c1`, `reserved`, `reserved_tokens` 3,000 |
| settle `c1` (used 1,000 in + 1,400 out) | `tokens` 2,400, `calls` 1; inclusive 2,400 / 1; reserved 0 | seq 1 → `settled` |
| host check passes | unchanged | seq 2 `check`, `passed`, `parent_event_id` = seq 1 |

The settle writes usage row `c1` (`id` = `call_id` = `entry_call_id` = `c1`,
`run_id` `W`, `step_index` 1, `step_instance_id` `s1`, `attempt` 1,
`total_tokens` 2,400) in the same transaction. Checkpoint revision 2 stores
step 1's accepted output.

**C. Step 2 starts and reserves the fusion's seats.** The step start counts
step 2 (`steps_used` 2, checkpoint revision 3, highest counted step 2,
instance `s2`). The entry call `e2` opens a child `fusion` run `F` (not
durable, `parent_run_id` `W`), and `W` records seq 3, a `handoff` event with
`child_run_id` `F`, `call_id` `e2` and no reservation. `F` sizes its seats
together (section 6.3): each panelist `R` = 6,000 + 3,000 = 9,000; the judge's
`E` is its prompt plus the panelists' output allowances, 1,000 + 2 × 3,000 =
7,000, so its `R` is 7,000 + 2,000 = 9,000. The joint reservation asks for 3
calls and 27,000 tokens, checked on `F` (no limits) and `W`:
2,400 + 0 + 27,000 = 29,400 > 20,000.

**D. Stop.** The reservation is refused all or none: no seat is sent, `F` has
no `call` event and no usage row. In that transaction `F` moves from `running`
to `stopped` with `max_tokens`, `stopped_by_run_id` `W`, `finished_at` set
(it is not durable, so the stop is final for `F`), and:

```json
{ "limit": "maxTokens", "runId": "W", "limitValue": 20000, "used": 2400,
  "reserved": 0, "requested": 27000, "room": 17600 }
```

The tracked client then moves `W` from `running` to `stopped` with the same
`stop_reason`, `stopped_by_run_id` and `stop_detail` (section 6.2), closes its
active period (`active_since` NULL), sets the `handoff` event's `status` to
`stopped`, and only then throws `AiRunStoppedError`. Step 2 is not completed,
counts no failed attempt and uses no repair; `W` is `stopped`, not `failed`.
`W` is protected from retention (a durable stopped run), and `F` with it.

**E. Resume with a larger budget.** The host resumes `W` with
`{ "maxTokens": 40000 }`. The resume reads the chain (`W` is a root, so it
stands), and the change is to the limit named in `stop_detail.limit` on the
run named in `stopped_by_run_id`, so it is allowed (section 7). Reconciliation
on claim finds no `call` event still `reserved` in `W` or below it, and `F` is
already final, so nothing changes there (section 6.7). `W` returns to
`running` with the new budget and a new active period; its totals are as in
D. Step 2 is re-entered: its index is not above the highest counted, so
`steps_used` stays 2 (section 6.3), checkpoint revision 4 records a new
instance `s2b`, and the new entry call `e2b` opens a **new** fusion run `F2`,
seq 4 in `W` (`handoff`, `child_run_id` `F2`, `call_id` `e2b`).

The same joint reservation of 27,000 now fits: 2,400 + 0 + 27,000 = 29,400 <=
40,000. In one transaction, root first, `W` and `F2` each get
`reserved_tokens` 27,000 and `reserved_calls` 3, and `F2` records seq 1 to 3,
three `call` events `reserved` at 9,000 each.

**F. Finish.**

| Seat | Used | Event of `F2` | Note |
|---|---|---|---|
| panelist 1 | 6,000 in + 2,500 out = 8,500 | seq 1 → `settled` | |
| panelist 2 | 6,000 in + 3,400 out = 9,400 | seq 2 → `settled` | 400 over its `R`, charged in full |
| judge | 6,900 in + 1,800 out = 8,700 | seq 3 → `settled` | sent under its reservation after a `running` check on `F2` and `W` |

Each settle writes that seat's usage row (`run_id` `F2`, `entry_call_id`
`e2b`), returns 9,000 of reservation on `F2` and `W`, and adds the actual to
`F2`'s own and inclusive totals and to `W`'s inclusive totals only. `F2` ends
`done`. The host check passes: seq 5 in `W`, a `check` whose
`parent_event_id` is the `handoff` seq 4, so it is attributed to the prompt
the fusion answered (section 5). Checkpoint revision 5 stores step 2's
output, and `W` ends `done` with `finished_at` set.

| Run | Status | Own tokens / calls | Inclusive tokens / calls | Reserved | `steps_used` |
|---|---|---|---|---|---|
| `W` | `done` | 2,400 / 1 | 29,000 / 4 | 0 | 2 |
| `F` | `stopped` (`max_tokens`, by `W`) | 0 / 0 | 0 / 0 | 0 | 0 |
| `F2` | `done` | 26,600 / 3 | 26,600 / 3 | 0 | 0 |

`W`'s inclusive total is its own 2,400 plus `F2`'s 26,600; `F` spent nothing. The `handoff` seq 4 has `status` `done`.
There are four usage rows (`c1` and `F2`'s three seats), and
`checkAiRunTotals` agrees for each run (section 6.6). With the defaults, `W`'s trajectory is kept 30 days after
it finishes and its row 90 (section 8); `F` and `F2` go with it, never before
it, although `F` finished earlier.

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
  reservations assert the job claim. Proposed: settlements do not assert it,
  because spending that happened must be counted whoever reports it.
- **Versions.** A run resumes only under the `definition_version` that saved its
  checkpoint, unless a newer version declares that it accepts older checkpoints
  and validates or migrates them. Otherwise the run stops with reason
  `definition_changed`.
- **After a stop.** A `stopped` durable run resumes from its checkpoint with
  the same or a larger budget. A stopped run that is not durable is not
  resumed (section 2). A `cancelled` run is never resumed, and neither is a
  `failed` one; a failed workflow run may be retried instead (below).
- **The ancestor chain must still stand.** Resuming a run, from `stopped` or
  from `waiting-approval`, reads its whole chain. If an ancestor's row is
  missing, or an ancestor is final (`cancelled`, `failed`, `done`, or a
  `stopped` run that is not durable), the resume is refused with
  `AiRunResumeRefusedError`, reason `ancestor_missing` or `ancestor_final`,
  and nothing is written; the sweep later moves the run to `cancelled`
  (section 6.7).
- **Retrying a failed run.** A host may retry a `failed` durable workflow run
  from its last accepted step. The retry is a **new run**, never the failed
  run resumed in place: a durable `workflow` run of the same
  `definition_key`, with `retry_of_run_id` naming the failed run, opened like
  any other run (its own owner, parent and budget). It inherits only the
  **accepted outputs of the completed steps** in the failed run's checkpoint:
  its first checkpoint starts with them, and it starts at the step the failed
  run did not complete. The definition version must match under the same rule
  as a resume (see **Versions**); otherwise the retry is refused with
  `AiRunResumeRefusedError` and no run is opened. It does **not** inherit the
  failed run's budget used, events, repair counts or reservations: its totals
  start at zero, its own budget applies, its trajectory begins with its own
  first event, and the inherited steps are not counted against its
  `maxSteps` (its checkpoint's highest counted step index starts at the last
  inherited step). The failed run's spend stays where it was charged, on the
  failed run and its ancestors, and is never charged again to anyone. A retry
  needs the failed run's checkpoint, so it is possible for as long as the
  failed run's row is kept (section 8). Once that row (and with it the
  checkpoint) has been pruned, a retry is refused with
  `AiRunResumeRefusedError`, reason `retry_source_pruned`, and no run is
  opened; the same reason is given when the row exists but its checkpoint does
  not. A failed run may be retried more than once; each retry names it in
  `retry_of_run_id`.
- **A budget stop needs a budget change.** Proposed: a resume of a run that
  stopped at a budget limit is refused with a typed `AiRunResumeRefusedError`
  unless it changes a limit that stopped the run: the limit named in
  `stop_detail.limit`, on the run named in `stopped_by_run_id` (the stopping
  run's own limit). That run may be the run itself, an ancestor, or a child
  whose budget comes from its definition; for a child, the change is to the
  definition's budget (a new definition version, or the app's setting for it),
  which the resume compares with the budget stored on the stopped child.
  Raising any other run's limit does not count. One exception: when the
  stopping run is the run itself or an ancestor and it now has room for
  `stop_detail.requested` (the calls that held the room have since settled or
  been released), the resume is allowed without a change. A host must not
  resume a budget-stopped run automatically without a budget change. Stops
  for other reasons (`interrupted` and `definition_changed`) are not subject
  to this rule.

Proposed: one error, `AiRunResumeRefusedError`, refuses both resumes and
retries, and its `reason` is one typed code:

| Reason | Refused because |
|---|---|
| `not_resumable` | The run is not a durable run that is `stopped` or `waiting-approval`. |
| `ancestor_missing`, `ancestor_final` | An ancestor's row is gone, or an ancestor is final. |
| `budget_unchanged` | A budget stop, and the resume changes none of the limits that stopped it. |
| `budget_lowered`, `above_ceiling` | The resume lowers a limit, or raises one past the app's ceiling. |
| `definition_changed` | The definition version does not accept the checkpoint. |
| `not_retryable` | A retry of a run that is not a `failed` durable `workflow` run of the same `definition_key`. |
| `retry_source_pruned` | A retry whose failed run, or its checkpoint, has been pruned. |

## 8. Retention

- **Trajectory.** Every run keeps its whole trajectory for **30 days** after it
  finishes, by default. An app can change the period or turn on sampling. The
  decision is made **once per run**, never per call: a trajectory is kept whole
  or deleted whole.
- **Not pruned (protected).** A run that is `running` or `waiting-approval`, a
  durable run that is `stopped` (it can still be resumed), a run in an
  experiment, and a run with `retain` set. A `stopped` run that is not durable
  cannot be resumed, and a `cancelled` run is final, so each is pruned like a
  finished run, counting from its `finished_at`, unless an ancestor protects
  it (next item). A `failed` run is not protected either; its checkpoint is
  kept longer than its trajectory (below), but not its row. A run's own
  protection never outlives an ancestor that can no longer resume it: a
  cancel moves every descendant that is not final to `cancelled` (section 2),
  and the `ai-runs` sweep does the same for a `stopped` or `waiting-approval`
  descendant of any final or missing ancestor (section 6.7), so each is then
  pruned like a finished run.
- **Protection is inherited.** A run is protected while **any ancestor** is
  protected, and it is pruned only after the protecting ancestor is pruned.
  So a final child, such as a stopped fusion under a durable `stopped`
  workflow, is kept as long as its parent's trajectory is; otherwise the
  parent's kept `handoff` would point at a missing run, and the checks on that
  step would drop out of the check pass rate (section 5). The rule applies to
  trajectories and, where run rows are pruned (below), to run rows alike.
  More generally, a child is never pruned before its parent: it goes with it
  or after it.
- **When a trajectory is deleted**, the counts of checks passed and failed and
  of approval decisions given and refused (counted in the run that recorded
  each decision, section 2) are first saved on the run row and
  `trajectory_pruned` is set. The run
  row is kept until the run-row rule below removes it.
- **Run rows.** An unprotected run row is pruned **together with its usage
  rows**, by the usage age limit (90 days by default, adjustable by the app),
  counting from its `finished_at`; age only, never row count. A protected run
  row is never pruned, and protection is inherited as above, so a child's row
  goes with its parent's or after it. A run row is never pruned while its
  trajectory is still kept; pruning it deletes whatever events and checkpoint
  it still has.
- **How the two periods fit together.** With the defaults, a finished run
  keeps its whole trajectory for 30 days; then its events are deleted, its
  counts are saved and `trajectory_pruned` is set, and the row alone (with its
  totals, budget, stop fields and counts) stays until the usage age limit, 90
  days, when it is pruned with its usage rows. A protected run keeps both for
  as long as it is protected.
- **Usage rows** follow their existing retention policy (by age, and
  optionally by row count). They are not part of a trajectory, and they may be
  pruned while their run is still alive; budgets do not depend on them
  (section 6.2).
- **Evaluations** are never swept. An evaluation is a judgment someone made,
  often by hand, and it stays after the call or run it judged is gone: when
  that call's usage row or that run's row is pruned, the evaluation keeps its
  `call_id` or `run_id`, which then no longer resolves. Readers tolerate this:
  a reader that returns evaluations returns such an evaluation with its
  target empty (NULL), never an error, and per-prompt measures (section 5),
  which reach a prompt through the judged call's usage row or the judged run's
  row, leave it out. An app that wants evaluations removed deletes them
  itself.
- **Payloads by reference.** `payload_ref` points at content the host owns,
  such as a chat message or a file. The framework owns none of it, so pruning a
  trajectory deletes only the events, never what they point at.
- **Checkpoints of finished runs.** The checkpoint of a `done` or `cancelled`
  run is deleted with the trajectory. The checkpoint of a `failed` run is
  kept after its trajectory is pruned, for as long as the failed run's row is
  kept, so the run can still be retried (section 7); it is deleted with the
  row.
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
  `entry_call_id = call_id` and then `call_id = id`. No unique index on
  `call_id` is created (section 2). Fusion seat rows that shared one `call_id`
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

Also left out on purpose: resuming a `failed` or `cancelled` run in place (a
failed workflow is retried as a new run, section 7), a run opened without
usage persistence (section 3), and a run that is not durable waiting for
approval (section 6.7).
