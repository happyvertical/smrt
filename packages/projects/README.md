# @happyvertical/smrt-projects

Provider-agnostic project management models for the s-m-r-t framework. Manages repositories, issues, pull requests, and project boards with sync support for external providers (GitHub, GitLab, etc.).

## Installation

```bash
pnpm add @happyvertical/smrt-projects @happyvertical/smrt-timesheets
```

Time entries and their commercial snapshots live in
[`smrt-timesheets`](../timesheets/README.md) (#3288); smrt-projects re-exports
them. Under pnpm, declare `@happyvertical/smrt-timesheets` directly: the CLI's
manifest discovery reads only top-level packages, so without it `smrt
db:migrate` / `db:status` stop planning `service_time_entries`,
`service_charge_snapshots`, and `service_compensation_snapshots`. Their old
`@happyvertical/smrt-projects:*` class names keep resolving as deprecated
aliases; move source references to `@happyvertical/smrt-timesheets:*` (for
`ServiceTimeEntry` in an app with smrt-support installed, to
`@happyvertical/smrt-support:ServiceTimeEntry`). See
[SERVICE_TIME_MIGRATION.md](./SERVICE_TIME_MIGRATION.md).

## Usage

```typescript
import {
  Repository, RepositoryCollection,
  Issue, IssueCollection,
  PullRequest, PullRequestCollection,
  Project, ProjectCollection
} from '@happyvertical/smrt-projects';

// Track a repository (token resolved from env var at runtime)
const repos = await RepositoryCollection.create({ db });
const repo = await repos.create({
  owner: 'org',
  name: 'my-app',
  providerType: 'github',
  tokenConfigKey: 'GITHUB_TOKEN',
});
await repo.save();

// Sync repository metadata from GitHub
await repo.sync();

// Discover and sync issues
const issues = await repo.getIssues({ state: 'open' });

// Living Spec: AI-synthesize comments into updated issue body
const result = await issue.incorporateFeedback({ apply: true });

// Rollback to original body
await issue.rollback();
```

## API

### Models

| Export | Description |
|--------|------------|
| `Repository` | Git repository with provider integration. Methods: `sync()`, `getIssues()`, `getPullRequests()`, `createIssue()`, `createPullRequest()`, `summarizeActivity()` |
| `Issue` | Issue/ticket (STI base). Methods: `sync()`, `incorporateFeedback()`, `rollback()`, `suggestLabels()`, `close()`, `addLabels()`, `addComment()` |
| `PullRequest` | Pull request (STI subclass of Issue). Methods: `sync()`, `summarize()`, `merge()`, `markReady()`, `convertToDraft()`, `requestReviewers()`, `findLinkedIssue()` |
| `Project` | Project board (GitHub Projects V2). Methods: `sync()`, `addItem()`, `moveItem()`, `listItems()`, `updateItemStatus()`, `analyzeHealth()` |
| `ProjectQuestion` | A requested fact whose lifecycle is `open`, `answered`, `deferred`, or `superseded`. |
| `ProjectDecision` | An owner choice with options, outcome, and rationale whose lifecycle is `open`, `decided`, `deferred`, or `superseded`. |
| `ProjectGovernanceEvent` | Immutable question/decision history with actor, action, status transition, and revision. |
| `Comment` | Comment on an issue or PR. AI methods: `isQuestion()`, `isApproval()`, `requestsChanges()`, `extractActionItems()`, `summarize()`, `getSentiment()` |
| `Label` | Label/tag for issues; optionally scoped to a repository or a `Project`. Methods: `isTypeLabel()`, `isPriorityLabel()`, `getCategory()`, `createInRepository()` |

### Collections

| Export | Key Methods |
|--------|------------|
| `RepositoryCollection` | Standard CRUD |
| `CommentCollection` | Standard CRUD (project-native issue comments) |
| `IssueCollection` | `discover()`, `findByProject()`, `findByRepository()`, `findOpen()`, `findByLabel()`, `findByAssignee()`, `findNeedingReview()`, `findWithUnincorporatedFeedback()`, `batchSync()` |
| `PullRequestCollection` | `discover()`, `findByRepository()`, `findOpen()`, `batchSync()` |
| `ProjectCollection` | Standard CRUD, `findByTitle()` |
| `ProjectQuestionCollection` | Tenant-safe project listing and lookup. |
| `ProjectDecisionCollection` | Tenant-safe project listing and lookup. |
| `ProjectGovernanceEventCollection` | Ordered history for a question or decision. |

### Project questions and decisions

`ProjectGovernanceService` is the write boundary for owner questions and
decisions. Host applications pass a qualified project record type and id, so
the same contract can attach to the provider-backed `Project` in this package
or to an application-owned project model. The service requires a tenant scope,
a trusted actor projection, and an `expectedRevision` for every mutation. Only
the assigned owner or a host-authorized manager may answer or decide;
assignment, deferral, reopening, and supersession require manager authority.

Records default to `visibility: 'internal'`; explicitly choose `client` for
client-facing records and pass `{ visibility: 'client' }` to `listForProject`.
Hosts authorize project access and strip private context references before
projecting client views. Lifecycle history rejects updates and deletion. Assignment events retain the
previous and next owner identities, including explicit owner clearing.

Questions and decisions retain typed references to the spec, cookbook,
conversation, asset, or URL that raised them. They do not replace facts: an
extracted `open_question` fact may seed a `ProjectQuestion`, but fact provenance
and question answer state remain separate lifecycles.

`ProjectQuestionsAndDecisions` from `@happyvertical/smrt-projects/svelte`
renders authorized projections and emits typed answer/decision callbacks. It
does not fetch records or decide application permissions.

### Canonical project specification

`ProjectSpecificationService` persists one canonical specification per tenant
and qualified project target. Its `cookbook` is validated and canonicalized by
`@happyvertical/smrt-core/cookbook`; `getCookbook()` returns the portable
`Cookbook` from `@happyvertical/smrt-types`, including its `specs` requirements.
`saveForProject({ ...scope, title, summary, cookbook, expectedRevision, actor })`
requires a trusted manager actor. `expectedRevision: null` means create-only;
updates require the currently observed revision. Validation rejects with
`ProjectSpecificationValidationError` (`status: 400`); stale revisions reject
with `ProjectGovernanceConflictError`.

When project creation already owns a transaction, use
`ProjectSpecificationService.create({ db: tx, transaction: 'caller' })` so the
specification rolls back with the project. The default mode owns its transaction.
An active caller tenant must match the target; hosts creating a child project
enter that authorized child tenant context before saving.

### Participant development requests

`ParticipantDevelopmentRequestService.create({ db }).submit()` accepts a trusted
server-authorized participant identity, tenant/project, `requestKey`, type and
description. It records participant provenance with a nullable `integrationId`;
managed integration intake still requires a nonempty integration ID. Repeating
the same actor/project/key returns the accepted request; changed payloads reject
with `ParticipantDevelopmentRequestConflictError`. Request and initial history
share one transaction. Hosts enforce project participation before calling this
service and expose their own safe DTOs, never the collection mutation API.

Existing databases must apply the generated migration that relaxes
`development_requests.integration_id` to nullable and adds the specification,
question, decision and history tables before enabling these surfaces. Run the
normal manifest-based `db:migrate` and verify schema parity; existing managed
request provenance is unchanged. `pnpm --filter @happyvertical/smrt-projects
test:postgres` exercises all three workflows with the repository disposable
PostgreSQL database wrapper.

### STI Hierarchy

`PullRequest` extends `Issue` via single-table inheritance. Both share the same table, discriminated by `_meta_type`. PullRequest adds `headRef`, `baseRef`, `merged`, `draft`, `additions`, `deletions`, `changedFiles`.

### Constants

`PROJECTS_MODULE_META`, `PROJECTS_UI_SLOTS`

### Key Types

`RepositoryProviderType` (`github | gitlab | bitbucket | azure`), `ProjectProviderType` (`github | jira | linear | zenhub`), `ProjectStatus`, `SyncStatus`, `SyncOptions`, `SearchFilters`, `CreateIssueInput`, `CreatePRInput`, `MergeMethod`, `IncorporateFeedbackOptions`, `IncorporateFeedbackResult`, `ProjectItem`, `ItemFilters`

### Options Types

`RepositoryOptions`, `IssueOptions`, `PullRequestOptions`, `ProjectOptions`, `CommentOptions`, `LabelOptions`

### Request-scoped repository clients

`withRepositoryClient(scope, client, callback)` binds an `IRepository` SDK
client to one async request. Its `RepositoryClientScope` must exactly match the
repository's provider, owner, name, tenant, and self-hosted `baseUrl`; a
mismatch throws before environment token resolution. The client is not stored
on models or persisted, and the previous scope is restored when the callback
settles. In an active `TenantContext`, its tenant must also match the scoped
repository; only an explicit `withSystemContext()` authorization bypasses that
request-tenant check.

```typescript
await withRepositoryClient(
  { provider: 'github', owner: 'org', repo: 'my-app', tenantId },
  installationClient,
  () => repository.sync(),
);
```

## Key Patterns

- **Token config reference**: stores env var name (`tokenConfigKey: 'GITHUB_TOKEN'`), not the token itself. Resolved at runtime from `process.env` or `getModuleConfig()`
- **Living Spec** (`incorporateFeedback()`): AI synthesizes issue comments into updated body. Supports preview mode and `rollback()`
- **Sync throttle**: sync operations skip if called within 5 minutes (override with `{ force: true }`)
- **Provider-agnostic**: GitHub primary, GitLab/Bitbucket/Azure types defined. Uses `@happyvertical/repos` and `@happyvertical/projects` SDK packages
- **Optional label vocabulary**: `issue.suggestLabels(vocabulary)` keeps its free-label generation when no vocabulary or typed decision client is configured. With both, provide a readonly array of `{ name, description? }` or a resolver; each offered label is independently evaluated and only offered labels above 0.5 are returned. An explicit empty vocabulary returns `[]` without a provider call. Names are exact and case-sensitive; vocabulary entries are limited to 64 labels, 128-character names, and 512-character descriptions. Resolver and configured-provider errors propagate.
- **Optional sentiment decisions**: `Comment.getSentiment()` keeps its existing generative behavior until typed decisions are configured. With no registered tools, it sends a bounded comment value to a three-choice decision request. A selected choice must be a unique probability maximum above 0.5; tied or low-probability responses, invalid configured responses, and provider failures reject instead of being silently treated as neutral. This is a routing certainty rule, not a calibrated quality claim.

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-config` -- configuration loading
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
- `@happyvertical/smrt-types` -- shared type definitions
- `@happyvertical/repos` -- repository provider SDK
- `@happyvertical/projects` -- project board provider SDK
- Peer: `@happyvertical/smrt-svelte`

## Contributor guide

See [`AGENTS.md`](./AGENTS.md) for package architecture, invariants, validation,
and contributor guidance.

### Structured project questions

`ProjectGovernanceService.createQuestion({ ..., options })` accepts optional
single-choice suggestions (`ProjectQuestionOption`: stable `id`, `label`, optional
`description`, optional boolean `recommended`). Recommendations are presentation
only: creation leaves the question open, with no answer or selection. IDs must be
unique and nonempty; `other` (case insensitive) is reserved and cannot be authored.
`question.getOptions()` appends `{ id: 'other', label: 'Other' }` to structured
questions. Omitting options, or supplying an empty array, keeps the existing
free-text question flow.

`answerQuestion` continues to require a nonempty string `answer`. It additionally
accepts optional `selectedOptionId` and `idempotencyKey`. An explicit selection
must match an offered ID, including `other`; an Other answer requires text. Hosts
should send the chosen label as `answer` for ordinary choices and the person's
text for Other. The generic `ProjectQuestionsAndDecisions` component supplies
these values, uses an unselected radio group, marks recommendations, and always
shows the Other text box. Only explicit form submission invokes `onanswer`.

Existing free-text API clients remain compatible, including when answering a
structured question without a selection: the service stores their answer and
leaves `selectedOptionId` empty. It never guesses an option from text. Existing
questions and immutable history are not rewritten or backfilled. New answer
history has a `getAnswerSelection()` snapshot with answer text, observed revision,
and explicit option ID/label when supplied; older events return `null`.

The optional idempotency key is scoped to a question. After tenant/project and
current owner/manager authorization, an identical actor, answer, selection,
expected revision, and note replays without a new revision or history event.
Reusing the key with different input conflicts. Without a key, the existing
expected-revision conflict behavior applies. Transaction rollback covers both
question and history writes. Hosts retain responsibility for affected-task
reconciliation after persistence and replay.

This additive contract adds `question_options` and `selected_option_id` columns
to `project_questions`, and `answer_selection` to `project_governance_events`.
Consumers must run their normal manifest-driven database migration before using
the new released surface. It introduces no new model or table.
