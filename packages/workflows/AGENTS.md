# smrt-workflows

Durable `workflow` runs (#5005; spec: [AI runs](../../docs/content/ai-runs.md)).
Replaces inference's design runs. `src/driver.ts` (`createWorkflowRunDriver`),
`src/checkpoint-store.ts` (`createRunCheckpointStore`, `RunConflictError`),
`src/claim-fence.ts` (`workflowClaimFence`), `src/types.ts` (`WorkflowStep`,
`WorkflowDefinition`, `WorkflowRunState`, `RunProgress`). Details:
[workflow runs](agents/workflow-runs.md).

- No models, no tables, no `CREATE TABLE`: runs, events and checkpoints are
  core system DDL. Use core's run API (`openAiRun`, `startAiRunStep`,
  `saveAiRunCheckpoint`, `resumeAiRun`, ...), never SQL on `_smrt_ai_*`.
- Every step call goes through `resolvePrompt` and core's tracked client
  with the run context; a step's own `execute` must pass `runContext` too.
- The checkpoint state is the run type's: step index, phase, repair and
  repeat counts, inline input or `inputRef`, accepted outputs. Never tokens,
  attempts or totals (usage rows and events are the record).
- A stop (budget, child, stop, cancel) is written by core and is never a
  repair; `AiRunClaimLostError` and `RunConflictError` propagate.
- Depends on core, prompts and jobs only; no smrt peer dependencies, no
  cycle. The root loads under plain Node.
- Job-running glue (the design-run bridge of #4999 under new names) is not
  here yet: a job target needs a registered `SmrtObject` with its own table,
  which `_smrt_ai_run_checkpoints` cannot be (see the notes).
- A pending job row with no worker stays pending until a worker runs
  (unclaimed-row gap): admitting a run's job does not run it.

Validate with package `build`, `typecheck`, `test`; no containers.
