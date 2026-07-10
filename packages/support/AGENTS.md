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
(the `smrt-chat` `ChatService` idiom). Configuration models expose full
generated CRUD.

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

## Permissions

Contributed to the runtime catalog on import (the
`personas.activate-directive` pattern): `support.reassign-case`,
`support.approve-time-entry`, `support.manage-plans`. Privileged service
operations take a `SupportPrincipal` (`can(slug)`), built from explicit slugs
or a `PermissionResolver`.

## Svelte UI

`@happyvertical/smrt-support/svelte` ships presentational Svelte 5 surfaces:
`CaseQueue` (priority/status/assignment/channel at a glance, `onselect`) and
`CaseDetail` (header, meta, linked work, merged timeline). Hosts adapt models
with `toSupportCaseView` / `toCaseTimelineItemView`. Components use
`smrt-ui` primitives (`smrtRawPrimitives: "strict"`).

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
