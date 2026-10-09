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
