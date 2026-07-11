# @happyvertical/smrt-support

AI-first Support Cases for the SMRT framework (epic #1934). Every inbound
support interaction — chat message or email — creates or joins one canonical,
tenant-scoped **Support Case**; channels stay transports, never separate
systems of record. The package owns the case lifecycle, channel intake, the
Automated Support Response workflow with lossless **Human Handoff**,
Project-qualified routing, **Service Target** clocks with timed escalation,
and auditable **Service Time Entries** whose client charges and provider
compensation stay separate.

**Boundary (FR-29a):** Support owns tickets, interactions, routing, and
service targets. Delivery Operations owns repository work — a **Delivery
Handoff** links a case to a Development Work Item (e.g.
`@happyvertical/smrt-projects:Issue`) via a `SupportWorkLink` without ever
driving its execution; the delivery side reports status echoes back.

## Models

Case-side models are **internal**: generated API/CLI/MCP surfaces are
read-only (`list`/`get`) and every write goes through the service facades
(the `smrt-chat` `ChatService` idiom). Operational configuration models
(bindings, policies, specialists, qualifications, availability) expose full
generated CRUD; **commercial terms** (`SupportPlan`,
`SupportCompensationPlan`) are read-only too — their writes flow through the
`support.manage-plans`-gated `SupportPlanAdminService`.

### Case core (#1926)

- **SupportCase** (`support_cases`) — canonical ticket: `caseNumber`,
  `subject`, `status` (`new → triaged → assigned → in_progress →
  waiting_on_client|escalated → resolved → closed`, guarded at save time via
  the WeakMap + authoritative-DB-read idiom from S5 #1390), `priority`,
  `severity` (plan-defined key), `category`, `sensitive`, `channelKind`,
  `clientProfileId`/`openedByProfileId` (crossPackageRef → Profile),
  `projectId` (app-defined string — deliberately not an FK), `bindingId`,
  `threadKey` (create-or-join dedup key), `planId` + `planSnapshot` (terms
  frozen at apply time), assignment fields, response stamps
  (`acknowledgedAt`, `firstRespondedAt`), `humanRequestedAt`, resolution
  fields, `reopenCount`/`lastReopenedAt`, `aiEnabled`.
- **SupportInteraction** (`support_interactions`,
  `conflictColumns: ['source_key']`) — channel-neutral transport record:
  `direction` (`inbound`/`outbound`/`internal`), `channelKind`, `actorKind`
  (`client`/`specialist`/`agent`/`system`), denormalized `body`, and the
  qualified `sourceType`/`sourceId` + globally unique `sourceKey`
  (`chat:<messageId>`, `email:<emailId>`, `manual:<uuid>`) that makes
  re-ingestion idempotent.
- **SupportCaseEvent** (`support_case_events`) — append-only audit trail
  (transitions, assignments, AI runs, handoffs, escalations, target state,
  work links, reopens). Together with interactions this is the complete
  context a Human Handoff transfers.
- **SupportChannelBinding** (`support_channel_bindings`,
  `conflictColumns: ['target_type','target_id']`) — marks a container as a
  support intake channel: `bindingKind` (`chat_room`/`email_account`),
  qualified `targetType` + `targetId`, default client/project/plan,
  `selfAddresses` (email direction heuristic). Unbound containers are never
  touched.
- **SupportWorkLink** (`support_work_links`) — Support/Development Work Item
  links with a read-only `status` echo.

### AI workflow (#1928)

- **SupportPolicy** (`support_policies`) — what the AI may do without a
  human: `autoAcknowledge`/`autoClassify`/`autoAnswer` (on by default),
  `autoTroubleshoot`/`autoResolve` (off by default),
  `autoResolveMaxSeverity`, `confidenceThreshold`, `maxAutoAttempts`,
  `sensitiveCategories`, `allowedTools`, `autoSendEmailReplies` (off —
  email replies are drafted, not sent). Resolution is most-specific-wins on
  `(planId, projectId)`; no row → `DEFAULT_SUPPORT_POLICY` (conservative).
- **SupportAiRun** (`support_ai_runs`) — append-only audit of each phase
  (`acknowledge`/`classify`/`answer`/`troubleshoot`/`resolve`) with
  `confidence`, classification output, knowledge refs, tool calls, outcome
  (`completed`/`skipped`/`failed`/`handed_off`), and `correlationId`.

### Routing, targets, escalation (#1929)

- **SupportSpecialist** (`support_specialists`) — specialist role record on a
  Profile (the commerce `Customer` role-record idiom): `languages`,
  `timezone`, `maxConcurrentCases`, `onCallPriority`, status.
- **SupportQualification** (`support_qualifications`) — effective-dated
  Project Support Qualification (`trainee`/`qualified`/`expert`).
- **SupportAvailability** (`support_availability_windows`) — weekly windows
  plus `on_call`/`time_off` spans.
- **SupportPlan** (`support_plans`, `conflictColumns:
  ['tenant_id','plan_key']`) — the Managed Support Plan: coverage calendar +
  holidays + timezone, channels, severity definitions, per-severity
  acknowledgement/response/update/resolution target minutes, `pauseStatuses`
  (clocks pause only when the plan says so), escalation policy steps,
  availability fee, `includedMinutes`, `overageHourlyRate`,
  `onCallHourlyRate`, time-approval policy, optional
  `subscriptionPlanKey` binding (string, not a dependency).
  `snapshotTerms()` feeds `SupportCase.planSnapshot`.
- **SupportServiceTarget** (`support_service_targets`,
  `conflictColumns: ['case_id','target_type','cycle']`) — one clock per
  target type (update clocks recur via `cycle`), with pause accounting and
  `escalationJobId` (the one-shot `_smrt_jobs` row scheduled at `dueAt`,
  cancelled on satisfy).
- **SupportEscalation** (`support_escalations`) — the audit record of one
  escalation firing.
- **SupportCompensationPlan** (`support_compensation_plans`) —
  effective-dated Support Specialist earning terms; specialist-specific plan
  wins over the tenant default at the work instant. Deliberately separate
  from `SupportPlan` (client pricing) so margin stays measurable.

### Service time (#1930)

- **ServiceTimeEntry** (`service_time_entries`) — auditable Professional
  Service duration: work-context-generic (`caseId` and/or polymorphic
  `workRefType`/`workRefId`), delivering Participant (`participantKind`
  `human`/`agent` + `participantProfileId`/`agentRef`), `source`
  (`timer`/`manual`/`import`/`agent` — one shared validation/audit
  contract), evidence JSON, and lifecycle `draft → submitted →
  approved|rejected`, `approved → corrected` only. **Approved entries are
  immutable**: the work-defining fields are frozen at save time (the
  `LicenseSale` WeakMap-freeze idiom, backed by an authoritative DB-row
  comparison); disputes create explicit corrections via `correctionOfId`.
- **SupportCharge** / **SupportCompensation** (`support_charges` /
  `support_compensations`, one per time entry) — derived commercial
  snapshots: client amount from the Managed Support Plan (included-time
  consumption then metered overage) vs provider amount from the Support
  Compensation Plan, each with a frozen `rateSnapshot`. Margin = charge −
  compensation, computed by readers; settlement/invoicing composes at the
  app/accounting boundary (#1925) and is out of scope here.

## Services

- **SupportCaseService** — the closed write facade: `openCase`,
  `recordInteraction` (idempotent on `sourceKey`; stamps
  `acknowledgedAt`/`firstRespondedAt`; inbound un-parks
  `waiting_on_client`), `transition`, `assign`, `resolve`, `close`,
  `reopen` (preserves prior resolution in the reopen event), `requestHuman`,
  `linkWork`/`recordWorkStatus` (Delivery Handoff), `recordEvent`,
  `getTimeline` (merged interactions + events).
- **SupportIntakeService** — create-or-join intake for both channels:
  `ingestChatMessage` (bound `ChatRoom`; `chat:<roomId>[:<threadId>]` thread
  keys; only `role: 'user'` messages), `ingestEmail` (bound `EmailAccount`;
  RFC-thread joins via `inReplyTo`; `selfAddresses` skip; unresolved senders
  park the case with `metadata.unresolvedClient`), plus
  `registerSupportIntake()` — an opt-in `GlobalInterceptors.afterSave`
  observer keyed on the `ChatMessage`/`Email` class names that never throws
  into the source package's save path. Join semantics: open case → join;
  resolved → reopen; closed → new case.
- **SupportAiWorkflow** — the Automated Support Response (FR-28a):
  `processIntake`/`processCase` run acknowledge → classify → answer →
  resolve under the resolved `SupportPolicy` (conservative defaults), each
  phase writing a `SupportAiRun` + `ai_run` case event. AI calls go through
  the injected `SupportAiBoundary` (default uses `supportCase.do()` with
  defensive JSON parsing that fails toward the human); knowledge comes from
  the pluggable `SupportKnowledgeProvider` (default no-op). Classification
  never overwrites human triage; email answers are drafted
  (`metadata.draft`) unless the policy allows sending. Handoff triggers —
  `client_request`, `low_confidence`, `high_severity`, `sensitive`,
  `failed_resolution`, `policy` (attempt budget) — are always active.
- **HumanHandoffService** — the lossless Human Handoff (FR-28b):
  `handoff` assembles the full context package (case state + compact
  timeline + AI runs) into the `handoff` event, stamps
  `metadata.activeHandoff` for the no-repeat guarantee (repeat triggers are
  deduped events), routes through the injected `assignSpecialist` seam
  (#1929's routing service plugs in; default queues `new` cases to
  `triaged`), and `releaseHandoff` clears the flag.
- **ServiceTargetEngine** — Service Target clocks (FR-30/31):
  `startTargetsForCase` derives per-severity clocks from the case's
  `planSnapshot` (live plan fallback) with due times computed in covered
  time (`coverage-calendar.ts`: timezone-aware weekly windows + holidays;
  empty coverage = 24×7) and schedules one-shot `_smrt_jobs` escalation jobs
  at `dueAt`; `onInteractionRecorded` satisfies acknowledgement/response and
  recurs `update` cycles; `onCaseTransition` pauses/resumes clocks only when
  the plan's `pauseStatuses` say so (recomputing remaining covered minutes)
  and settles targets on resolve. Breach → `SupportServiceTarget.
  checkAndEscalate` (background-eligible, at-least-once-safe) marks the
  breach and escalates through the plan's policy steps (notify/reassign,
  delayed follow-up levels), transitioning the case to `escalated`.
- **SupportPlanAdminService** — the permission-gated write surface for
  commercial terms: create/update/archive for Managed Support Plans and
  Support Compensation Plans, every act behind `support.manage-plans` with
  cross-tenant writes refused (generated CRUD on both models is read-only).
- **SupportRoutingService** — explainable ranked routing (FR-30):
  `rankSpecialists` hard-filters on active status, effective Project
  Support Qualification, workload cap, and availability windows (specialist
  timezone), then scores preferred-specialist, qualification level, on-call,
  workload headroom, and language (weights in `ROUTING_WEIGHTS`; every
  factor recorded so ineligible specialists show why); `autoAssign` writes
  the assignment with its rationale; `reassign` is gated by
  `support.reassign-case` and refuses cross-tenant principals.
- **ServiceTimeEntryService** — the ONE recording contract for all four
  entry sources (FR-40): `record` validates duration (explicit or derived
  from the period; `timer` needs both bounds), participant coherence
  (`human` → `participantProfileId`, `agent` → `agentRef`), and the work
  context (case and/or work ref; case entries copy the tenant and append a
  `time_recorded` event); `submit` stamps the submitter.
- **TimeEntryApprovalService** — the approval gate and only writer of the
  commercial snapshots (FR-36): `approve` resolves the governing terms (case
  `planSnapshot` first, live plan fallback, zero-rate default), gates by
  policy path (`automatic`/`threshold`/`operator`/`client`; operator paths
  behind `support.approve-time-entry`; cross-tenant principals refused), then
  derives the `SupportCharge` (included time first, then overage/on-call) and
  `SupportCompensation` (effective-dated plan) rows; `reject` and `correct`
  (supersede + linked fresh draft via `correctionOfId`) round out the
  lifecycle. Case events carry the charge amount only — compensation never
  leaks case-side.

## Permissions

Contributed to the runtime catalog on import (the
`personas.activate-directive` pattern): `support.reassign-case`,
`support.approve-time-entry`, `support.manage-plans`. Privileged service
operations take a `SupportPrincipal` (`can(slug)`), built from explicit slugs
or a `PermissionResolver`.

## Svelte UI

`@happyvertical/smrt-support/svelte` ships presentational Svelte 5 surfaces:
`CaseQueue` (priority/status/assignment/channel at a glance, `onselect`),
`CaseDetail` (header, meta, linked work, merged timeline), `TargetList`
(Service Target clocks with due/paused/satisfied/breached badges),
`RoutingRationale` (ranked specialists with eligibility + factor chips and
an optional reassign action), and `TimeEntryApprovalQueue`
(date/hours/description/worker/status/amount with
approve/reject-with-reason actions on submitted rows). Hosts adapt models
with `toSupportCaseView` / `toCaseTimelineItemView` / `toServiceTargetView`
/ `toSupportTimeEntryView` — the time-entry view's first eight fields
deliberately match `smrt-projects`' presentation `TimeEntry` contract.
Components use `smrt-ui` primitives (`smrtRawPrimitives: "strict"`).

## Dependencies

Leaf package (nothing depends back on it): `smrt-core`, `smrt-tenancy`,
`smrt-chat`, `smrt-messages`, `smrt-jobs`, `smrt-users`, `smrt-ui`,
`@happyvertical/logger`, `@happyvertical/sql`. Profile / smrt-projects /
subscriptions references are `@crossPackageRef` string ids or plain string
keys only — no package edge. No inter-`smrt-*` `peerDependencies`.

## Validation

```sh
pnpm --filter @happyvertical/smrt-support test
pnpm --filter @happyvertical/smrt-support typecheck
pnpm --filter @happyvertical/smrt-support build
```

## Gotchas

- **Writes go through the facades** — the case-side generated routes are
  read-only on purpose; `create`/`update` on them is not a bug to "fix".
- **`projectId` is an app-defined string** — the consuming app owns the
  Project concept; don't turn it into an FK or a crossPackageRef to
  `smrt-projects:Project` (that class is a provider board, not a client
  initiative).
- **`SupportCase.threadKey` + `SupportInteraction.sourceKey` carry intake
  correctness** — `sourceKey` is globally unique (`conflictColumns`), so
  replayed transport rows are no-ops; new manual interactions must use a
  fresh `manual:<uuid>` key.
- **High-volume models avoid the inherited `name` field** (`subject`,
  `displayName`, …) so the default `(slug, context, _meta_type)` unique index
  falls back to id-derived slugs; named config models carry
  `conflictColumns` instead (which replaces that index).
- **Approved time entries never change** — corrections are new rows linked
  by `correctionOfId`; the original flips to `corrected` with its snapshot
  intact.
- **Plan edits never rewrite history** — cases keep `planSnapshot`, charges
  and compensation keep `rateSnapshot`.
- **Create-or-join and included-time consumption serialize in-process** —
  `SupportIntakeService` (per conversation key) and
  `TimeEntryApprovalService` (per case) use a `KeyedMutex`, which covers the
  single-app-process deployment these paths run in. Multi-replica
  deployments must serialize at the app layer (route a conversation's
  intake / a case's approvals through one worker, or add an app-level
  claim) — the framework exposes no cross-adapter transaction primitive at
  this seam. Escalation is additionally idempotent per `(target, level)`,
  so at-least-once job redelivery never stacks duplicate escalations.
