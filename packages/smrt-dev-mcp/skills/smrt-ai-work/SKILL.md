---
name: smrt-ai-work
description: Use when asked to add AI work to a project that depends on @happyvertical smrt packages ("summarize each ticket", "classify incoming mail", "draft a reply", "add a multi-step AI workflow", "call a model") or to explain how AI work is recorded and limited (runs, events, trajectories, evaluations, tiers, latency, reasoning effort, budgets, fusions, seats, usage rows, ai:usage). Produces a registered prompt, a tracked call carrying its prompt key, and for multi-step work a smrt-workflows definition, never a direct provider SDK call. Stay silent for editing an existing prompt's wording only.
---

# SMRT AI work

Every model call in an smrt app is a registered prompt, sent on the tracked
client, recorded once as a usage row. Several calls that belong together are a
run. Never import a provider SDK, call `getAI()`, or inline a prompt string.

## Adding AI work

1. **Register the prompt.** `definePrompt({ key, template, ai })` from
   `@happyvertical/smrt-prompts`, key namespaced by package (`tickets.summarize`).
   Declare the quality it needs as a tier: `ai: { profile: 'cheap' | 'good' |
   'great' | 'best' }` (classification `cheap`, summaries `good`, synthesis
   `great`; never a model name). Add `ai: { latency: 'interactive' |
   'background', effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max',
   minimumTier }` only when the work needs them. Keys are persisted
   identifiers: never rename one.
2. **Make a tracked call.** On a `SmrtObject`, `is()`, `do()` and `describe()`
   already record and route by tier. Elsewhere (a job, a route, a service):
   `createTrackedAiClient({ db, tenantId })`, then
   `const resolved = await resolvePrompt(key, ...)` and
   `await tracked.client(trackedPromptCall(resolved), { runContext })`. A call
   without a prompt key is refused (`AiPromptKeyRequiredError`).
3. **Multi-step work is a workflow.** Several dependent steps, schema-checked
   output, repair, approval, or a budget: write a definition for
   `@happyvertical/smrt-workflows` (`createWorkflowRunDriver`, or
   `createWorkflowRunJobs` to run it on background jobs). Each step names a
   prompt key, a JSON Schema for its output, and an optional host `check`.
   Give the run a budget: `{ maxTokens, maxCost, maxCalls, maxSteps,
   maxDurationMs, repairRetries }`. Steps and checks must be safe to repeat.
4. **Background work uses the handler job contract.** A job targets a model
   method or a named handler `<package>:<name>`
   (`registerJobHandler(name, handler)`; enqueue with
   `SmrtJobCollection.enqueueHandlerJob({ handler, payload })`). Register every
   handler at process startup before `TaskRunner.start()` (registering later
   throws `JobHandlerRegistrationClosedError`); a runner only claims handler
   jobs it registered; a handler job nobody claims fails after
   `handlerUnclaimedDeadlineMs` (default 24 h). The handler gets
   `(payload, context)`; pass the run context explicitly through the payload
   (`serializeAiRunContext` / `restoreAiRunContext`), never a global.
5. **Tell the user** the prompt key, its tier, and the run type before coding.

## Explaining it

Read `docs/content/ai-runs.md` and the package notes before answering; do not
answer from memory.

- **Call**: one model request, one `_smrt_ai_usage` row (the cost ledger).
- **Run**: a piece of work with its own row, status and budget (`fusion`,
  `turn`, `workflow`, or `@scope/pkg:type`); a lone call is not a run.
  A budget limit **stops** a run with a typed reason and a durable run can be
  **resumed**; a **cancel** is final; a failed run is **retried** as a new run.
- **Event / trajectory**: ordered entries of a run (call, action, check,
  approval, handoff); `getRunTrajectory(runId)` reads them.
- **Evaluation**: a later judgment on a call or run (`recordAiEvaluation`,
  label or score, by `human`, `app` or `grader:<name>@<version>`). It replaced
  "outcome". A check or approval inside a run is an event.
- **Tier, latency, effort**: tier is quality bound to a model, alias chain or
  fusion; latency is `interactive` or `background`; effort is reasoning effort
  from the caller, then the prompt, then the tier binding. None of them names
  a model.
- **Fusion, seat**: a tier bound to several calls (`single`, `pair`,
  `handoff`) run as one `fusion` run; a seat is one prompt plus target.
- **Reading results**: `smrt ai:usage --by prompt,model,tier`, `--runs`,
  `smrt ai:compare`, `smrt ai:transcript`.

Sources: `docs/content/ai-runs.md`, `docs/content/inference.md`,
`packages/core/agents/ai-usage.md`, `packages/prompts/AGENTS.md`,
`packages/workflows/README.md`, `packages/jobs/agents/job-handlers.md`.
