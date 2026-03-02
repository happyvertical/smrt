# @happyvertical/smrt-projects

Provider-agnostic project management models for the SMRT framework. Manages repositories, issues, pull requests, and project boards with sync support for external providers (GitHub, GitLab, etc.).

## Installation

```bash
pnpm add @happyvertical/smrt-projects
```

## Usage

```typescript
import {
  Repository, RepositoryCollection,
  Issue, IssueCollection,
  PullRequest, PullRequestCollection,
  Project, ProjectCollection
} from '@happyvertical/smrt-projects';

// Track a repository (token resolved from env var at runtime)
const repos = new RepositoryCollection(db);
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
| `Comment` | Comment on an issue or PR. AI methods: `isQuestion()`, `isApproval()`, `requestsChanges()`, `extractActionItems()`, `summarize()` |
| `Label` | Label/tag for issues. Methods: `isTypeLabel()`, `isPriorityLabel()`, `getCategory()`, `createInRepository()` |

### Collections

| Export | Key Methods |
|--------|------------|
| `RepositoryCollection` | Standard CRUD |
| `IssueCollection` | `discover()`, `findByRepository()`, `findOpen()`, `findByLabel()`, `findByAssignee()`, `findNeedingReview()`, `findWithUnincorporatedFeedback()`, `batchSync()` |
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

## Key Patterns

- **Token config reference**: stores env var name (`tokenConfigKey: 'GITHUB_TOKEN'`), not the token itself. Resolved at runtime from `process.env` or `getModuleConfig()`
- **Living Spec** (`incorporateFeedback()`): AI synthesizes issue comments into updated body. Supports preview mode and `rollback()`
- **Sync throttle**: sync operations skip if called within 5 minutes (override with `{ force: true }`)
- **Provider-agnostic**: GitHub primary, GitLab/Bitbucket/Azure types defined. Uses `@happyvertical/repos` and `@happyvertical/projects` SDK packages

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-config` -- configuration loading
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
- `@happyvertical/smrt-types` -- shared type definitions
- `@happyvertical/repos` -- repository provider SDK
- `@happyvertical/projects` -- project board provider SDK
- Peer: `@happyvertical/smrt-svelte`
