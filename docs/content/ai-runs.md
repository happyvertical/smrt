---
title: AI runs, calls and trajectories
---

# AI runs, calls and trajectories

This page defines the words s-m-r-t uses for AI work, shows how each kind of
work is recorded, and states the rules for budgets, resuming and retention. It
is written for someone who has not seen the code. The [inference
guide](./inference.md) covers which model answers a call; this page covers
what is written down about the work afterwards, and what a long piece of work
may spend.

Everything here follows one idea: **every model call is recorded once, in one
place, and anything that groups calls (a fusion, a chat turn, a workflow) is a
run laid over those records.** There is no second record of cost or tokens.

## 1. Terms

| Term | Definition |
|---|---|
| **Prompt** | A registered prompt template, identified by its **prompt key**. Its version is its `templateHash`. |
| **Call** | One model call: one request and its response. One row in `_smrt_ai_usage`. A transport retry inside the client is not a second call. |
| **Tier** | The quality a prompt asks for: `cheap`, `good`, `great`, `best` or `auto`. The app binds each tier to a model, an alias chain or a fusion. |
| **Latency** | Whether a caller waits for the answer: `interactive` or `background`. |
| **Run** | One piece of AI work that has its own record: a status, a budget and a trajectory. It may contain any number of calls, including none yet. A single call made on its own is **not** a run; its usage row has no `run_id`. |
| **Run type** | The shape of the work. An open string. The framework's own types are `fusion`, `turn` and `workflow`. A type defined by an app or package carries its owner's namespace (`@scope/pkg:type`). A reader must cope with a type whose code is not loaded: it shows the row and does not interpret the type's state. |
| **Definition** | One specific task of a run type, with a `definition_key` and a `definition_version`; for example one workflow definition. Apps add definitions often and run types rarely. |
| **Workflow run** | A run of type `workflow`. The host fixes the order: a list of **steps**, each with a schema-checked output and a host check. It is linear, with repair and an approval pause; there is no branching and no parallel step. It replaces "design run". |
| **Step** | One host-defined stage of a workflow. It replaces "pass". In a model-driven loop the equivalent round is an **iteration**. |
| **Attempt** | One try at a step's call. A repair is attempt 2 of the same step. |
| **Durable** | A property of a run, not a run type: a durable run keeps a checkpoint and can be resumed after a restart. Any run type can be durable. |
| **Checkpoint** | The saved state a durable run resumes from. |
| **Event** | One ordered entry in a run: a call, an action, an observation, a check, an approval or a hand-off. |
| **Trajectory** | The ordered events of one run, read with `getRunTrajectory(runId)`. A trajectory is a way of reading, not a table. |
| **Evaluation** | A judgment on one call or one run, made by a person, the app or an automated grader. It replaces "outcome". A check or an approval inside a run is an event, not an evaluation. |
| **Budget** | The limits a run must stay within. |
| **Experiment, dataset item** | An experiment is a set of runs meant to be compared; a dataset item is what each run attempted. Both are plain references on the run; there are no experiment or dataset tables. |
| **Fusion, seat** | A fusion answers one logical call with several models (elsewhere called a model ensemble). A seat is one named call inside it: a panelist or the judge. |

A "work profile" is not a concept any more. What it bundled is expressed
through the tier, latency, reasoning effort and the budget.

## 2. The model

```
 prompt (key + templateHash)
        |
        |  asked for by
        v
 +---------------------------------------------------------------+
 | run  (_smrt_ai_runs)        type, definition, status, budget, |
 |  |                          own totals, inclusive totals      |
 |  |  parent_run_id --------> another run (a child run)         |
 |  |                                                            |
 |  +-- checkpoint (_smrt_ai_run_checkpoints)   durable only     |
 |  |                                                            |
 |  +-- events (_smrt_ai_run_events), ordered by seq             |
 |        call ----------------+ points at                       |
 |        action, observation   |                                |
 |        check, approval       |                                |
 |        handoff               |                                |
 +------------------------------|--------------------------------+
                                v
        usage row (_smrt_ai_usage)  <- the cost ledger: one per call
                |  call_id, run_id (or none), prompt_key,
                |  template_hash, tier, step, attempt, tokens, cost
                v
        evaluation (_smrt_ai_evaluations)   on one call or one run
        transcript (_smrt_ai_transcripts)   opt-in text of one call
```

Reading the picture:

- The **usage row is the ledger**. One row per call, written when the call
  ends. Cost and tokens are recorded there and nowhere else. An event of type
  `call` is only a pointer to its usage row, so cost is never recorded twice.
- The **run row** is written when the run starts, updated at step boundaries
  (not on every event) and closed at the end. Its totals are a cache; the usage
  rows are the truth, and the totals can be rebuilt from them (see
  [section 6](#6-budgets-and-how-they-are-accounted)).
- **Events** are the ordered record of what happened. `seq` is append order,
  not causal order; `parent_event_id` carries cause.
- A **checkpoint** exists only for a durable run and holds what resuming needs.

### Run row

`_smrt_ai_runs` has one row for every run: `id`, `tenant_id`, `class_name`,
`type`, `definition_key`, `definition_version`, `owner_id`, `parent_run_id`,
`experiment_id`, `dataset_item`, `tags`, `status`, `degraded`, `stop_reason`,
`budget`, own totals (`tokens`, `cost_used`, `calls`, `steps_used`,
`duration_ms`), inclusive totals covering child runs (`tokens_total`,
`cost_total`, `calls_total`), the reserved amounts of calls in flight
(`reserved_tokens`, `reserved_cost`, `reserved_calls`), counts of checks and
approvals passed and failed, `retain`, `trajectory_pruned`, `started_at` and
`finished_at`.

`status` is one of:

| Status | Meaning |
|---|---|
| `running` | Work is in progress (or was, and nothing has said otherwise yet). |
| `waiting-approval` | Paused at an approval event until a person decides. Resumable. |
| `stopped` | Stopped with a typed `stop_reason` and **resumable**: a budget limit was reached, the host stopped it, or its definition changed. |
| `failed` | Something went wrong: for example repairs were exhausted. Not resumable without an explicit restart. |
| `done` | Finished. |

`stop_reason` is a typed code, never free text: `max_steps`, `max_calls`,
`max_cost`, `max_tokens`, `max_duration`, `cancelled`, `host_stopped`,
`definition_changed`, `lease_lost`. A failed run carries a `failure` code
(`repairs_exhausted`, `check_failed`, `error`) in the same column family.

### Event row

`_smrt_ai_run_events` has: `id` (stable), `run_id`, `seq`, `parent_event_id`,
`type`, `call_id`, `step_index`, `name`, `status`, `duration`, `payload`,
`payload_ref`, `truncated`, `created_at`.

| Event type | What it records |
|---|---|
| `call` | A model call. Points at its usage row through `call_id`. |
| `action` | Something the run did: a tool call, a write, a command. |
| `observation` | What came back from an action. |
| `check` | A host check of a step's output, passed or failed. |
| `approval` | A person's decision, requested or given. |
| `handoff` | Work passed to another run, a person or an outside tool. |

`seq` is allocated in the same transaction as the insert; `(run_id, seq)` is
unique; a conflict is retried a bounded number of times. No transaction is held
open across a model call. Each event's `payload` is capped; when it is cut the
head and the tail are kept and `truncated` is set. For a chat turn an event may
point at the chat message (`payload_ref`) instead of copying its content.

## 3. How each case is recorded

| Case | Records |
|---|---|
| `do()`, `is()`, `describe()` on its own | One usage row. No run. |
| A fusion | One `fusion` run, one usage row and one `call` event per seat. The run row is written when the fusion starts, not when it ends. |
| A chat turn | One `turn` run, one usage row per model call in the tool loop, `action` and `observation` events for tool use. |
| A workflow run | One `workflow` run, a checkpoint, usage rows that carry the step and attempt, `check` and `approval` events. |
| A fusion inside a workflow step | A child `fusion` run whose `parent_run_id` is the workflow run. |

A caller that wants a status, a budget or a trajectory opens a run. A caller that
wants only the answer makes a call.

The run a call belongs to is **passed explicitly**, as a run context on the
call, never read from a process-wide variable. A background job carries the run
id in its payload and rebuilds the context when it runs. Tracking is scoped to
the tenant and database the work belongs to.

Every tracked call carries a **call id minted before the call is made**.
Persistence deduplicates on it, so a call that finished but failed to save, or
a retried save, never produces a second row and is never counted twice.

## 4. Reading it: trajectories

`getRunTrajectory(runId)` returns the run row and its events in `seq` order,
with each `call` event joined to its usage row (tokens, cost, model, tier,
latency) and each event's evaluation, if any. It works for a call inside a run
and, through the same reader, for a call on its own (a one-entry trajectory
with no run). A run whose `trajectory_pruned` is set returns the row, its saved
counts and no events.

## 5. Asking how a prompt performs

Prompt performance is a query over usage rows grouped by `(prompt_key,
template_hash)`; evaluations add labels and scores. `compareAiPromptRuns` and
`smrt ai:compare` report these side by side for two template versions, two
models or two tiers.

| Measure | How it is computed |
|---|---|
| Cost, tokens | Sum of `cost` and tokens over the group's usage rows (rows without a rate are counted as uncosted, never as zero). |
| Latency p50, p95 | Nearest-rank percentiles of `duration` over the group's rows. |
| Repair rate | Workflow steps in the group with at least one usage row where `attempt > 1`, divided by steps in the group. |
| Check pass rate | `check` events passed divided by `check` events, for runs whose steps used the prompt. |
| Approval rate | `approval` events approved divided by decided, likewise. |
| Labels, scores | Evaluations on the group's calls or runs, counted once per group. |

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

Check pass rate for the runs that used a prompt:

```sql
SELECT e.status, COUNT(*)
FROM _smrt_ai_run_events e
WHERE e.type = 'check'
  AND e.run_id IN (SELECT run_id FROM _smrt_ai_usage
                   WHERE prompt_key = :promptKey AND run_id IS NOT NULL)
GROUP BY e.status;
```

A run whose trajectory has been pruned still counts in these measures through
its saved check and approval counts (section 8); only the per-event detail is
gone.

## 6. Budgets and how they are accounted

### 6.1 The limits

A budget is a set of optional keys on the run:

| Key | Limit |
|---|---|
| `maxSteps` | Steps the run may start. |
| `maxCalls` | Calls the run may make. |
| `maxCost` | Cost, in the usage cost unit. **Approximate** (see below). |
| `maxTokens` | Input plus output tokens. Best effort when a call is cancelled before it reports usage. |
| `maxDurationMs` | Active running time. Time spent stopped or waiting for approval does not count. |
| `maxCallTokens` | Largest single call, input plus output. |
| `callTimeoutMs` | Wall-clock limit for one call. |
| `actionTimeoutMs` | Wall-clock limit for one action. |
| `repairRetries` | Repairs allowed per step. |

When a limit in the first five rows is reached the run **stops with the typed
reason and stays resumable**. It does not fail. Failing is for things that went
wrong, such as repairs exhausted. `maxCallTokens`, `callTimeoutMs` and
`actionTimeoutMs` bound one call or action; reaching them fails that call or
action (and the run's repair or stop rules decide what happens next), they do
not stop the run by themselves.

The app may set a ceiling on how far a budget can be raised when a stopped
run is resumed. A resume asking for more than the ceiling is refused.

### 6.2 What is counted, and where

Three kinds of number, each with a single owner:

- **Ledger**: usage rows. One row per call. The only place cost and tokens are
  recorded.
- **Own totals** on a run row: `tokens`, `cost_used`, `calls`, `steps_used`,
  `duration_ms` of calls whose usage row has this run's id in `run_id`.
- **Inclusive totals** on a run row: own totals plus those of every
  descendant run (`tokens_total`, `cost_total`, `calls_total`).
- **Reserved amounts** on a run row (`reserved_tokens`, `reserved_cost`,
  `reserved_calls`): room held for calls that have started and not yet ended,
  inclusive of descendants, like the totals.

A call is charged **once**. It is added to the own totals of the run that made
it and to the **inclusive** totals of that run and of each ancestor. It is never
added to an ancestor's own totals. A parent's limits are checked against its
inclusive numbers; a child's limits against the child's inclusive numbers (a
child's own descendants count against the child).

A child run's spending therefore counts against its parent's budget and against
every ancestor above it. Reaching an ancestor's limit stops that ancestor and
every run beneath it, because no descendant can reserve room any more.

### 6.3 Reserve, settle, release

For each call the run goes through three steps.

**Reserve (before the call).** The run asks for room for one call:
`calls = 1`, `tokens = min(estimated input tokens + maxCallTokens, room left)`,
`cost` = that many tokens at the rate card (zero when the model has no rate;
the call is then uncosted, and a cost limit cannot be enforced on it). In one
short transaction the run walks its ancestor chain, **root first**, and for
each run in the chain (itself last) does a conditional update of the form:

```
UPDATE _smrt_ai_runs
   SET reserved_calls  = reserved_calls  + :calls,
       reserved_tokens = reserved_tokens + :tokens,
       reserved_cost   = reserved_cost   + :cost
 WHERE id = :id
   AND (max_calls  IS NULL OR calls_total  + reserved_calls  + :calls  <= max_calls)
   AND (max_tokens IS NULL OR tokens_total + reserved_tokens + :tokens <= max_tokens)
   AND (max_cost   IS NULL OR cost_total   + reserved_cost   + :cost   <= max_cost)
```

If any update changes no row, the whole transaction rolls back and the run
stops with the reason of the limit that failed, naming which run's budget it was
(its own or an ancestor's). In the same transaction the run writes a `call`
event with status `started` carrying the call id and the amounts reserved. That
event is the durable record of the reservation. The transaction ends **before**
the model is called; nothing is held open across it.

**Settle (when the call ends).** In one transaction, again root first: insert
the usage row (deduplicated on the call id); **only if that insert created a
new row**, for each run in the chain subtract the reservation from
`reserved_*`, add the actual calls, tokens and cost to `calls_total`,
`tokens_total`, `cost_total`, and (for the run that made the call only) to the
own totals; then set the `call` event to its final status. If the insert found
the row already there, the call was settled earlier: nothing is added again.
This is what makes a retried save safe and prevents double-charging.

**Release (when the call ends without usage).** If the call fails, times out or
is cancelled and no usage is reported, the same transaction subtracts the
reservation from every run in the chain, adds nothing to the totals and sets the
event to `failed`, `timed_out` or `cancelled`. If the provider still reports
usage later, that usage is written as a normal row and settled as above; if it
never does, the call is uncounted. This is why token limits are best effort.

Because the actual cost of a call is only known at settlement, a call can
overshoot `maxCost` by the difference between the estimate and the actual.
The next reservation then fails and the run stops. Cost limits are therefore
approximate: they bound spending to the limit plus the overshoot of calls that
were in flight.

### 6.4 Lock order

Every transaction that touches more than one run row touches them **root first,
then down the chain to the run that made the call**. A chain is a path in a
tree, so two transactions that share any rows take them in the same order and
cannot deadlock each other. On PostgreSQL the reservation also takes the rows
with `SELECT ... FOR UPDATE` in that order before the conditional update; on
SQLite and DuckDB a write transaction is already exclusive. A reservation or
settlement that cannot get its locks within a short timeout rolls back and is
retried a bounded number of times; it is never retried while a model call is in
flight, because it never overlaps one.

### 6.5 Crash reconciliation

A process can die between reserve and settle, or between the usage insert and
the end of its transaction (which rolls back as a whole). The records that make
recovery possible are the `call` events with status `started` and the usage
rows. Reconciliation runs when a stopped or crashed durable run is claimed for
resume, when a run's lease has expired, and from a periodic sweep for runs that
are not durable. For each `call` event still `started` after the run's
`callTimeoutMs` (or its lease expiry) it does the following in one
transaction, root first:

1. If a usage row with that call id exists, the call settled. Set the event to
   its final status. Nothing else changes.
2. If not, release the reservation from every run in the chain, set the event
   to `abandoned`, and add nothing to the totals.

Then, for the run being recovered, it **recomputes** its own and inclusive
totals from the usage rows (own: rows with its `run_id`; inclusive: its own plus
its descendants') and overwrites the cached columns, so any drift is repaired
and the usage rows stay the single source of truth. Reservations of calls that
are genuinely still running (a live holder within its lease) are left alone.

A call that was running when the process died, whose provider response was
lost, is unbilled in the ledger. That is the documented limit of best-effort
accounting.

### 6.6 What a resumed run keeps

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
  a lost lease the new runner may repeat the last action.
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
- **Usage rows** follow their existing retention policy. They are not part of a
  trajectory.
- **Payloads by reference** (`payload_ref`) belong to the run: pruning a
  trajectory deletes the payloads its events own. A reference to a chat message
  is not deleted, because the message belongs to the conversation.
- **Checkpoints of finished runs** are deleted with the trajectory.
- **Payload size.** Each event payload is capped (head and tail kept, `truncated`
  set). Full request and response text of a call is stored only when
  transcripts are enabled.
- **Privacy.** Trajectories hold user data. The tracking supports redaction
  before an event is stored, with the same redactor transcripts use.

## 9. What is deliberately not here

A model-driven loop driver, workspace tools, a sandbox, dataset and grader
tables and an eval runner are not part of this model. The model is shaped so
that adding them later adds rows and event types rather than renames: a coding
agent would be a run type owned by the agents package, one run per task, one
event per action and observation, a grader writing an evaluation, and many runs
compared as one experiment.
