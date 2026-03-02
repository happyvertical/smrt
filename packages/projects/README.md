# @happyvertical/smrt-projects

Provider-agnostic project management models for the SMRT framework. Manages repositories, issues, pull requests, and projects with sync support for external providers (GitHub, GitLab, etc.).

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

// Create a repository
const repos = new RepositoryCollection(db);
const repo = await repos.create({
  name: 'my-app',
  fullName: 'org/my-app',
  provider: 'github',
  url: 'https://github.com/org/my-app',
});
await repo.save();

// Track an issue
const issues = new IssueCollection(db);
const issue = await issues.create({
  repositoryId: repo.id,
  title: 'Fix login bug',
  number: 42,
  state: 'open',
});
await issue.save();

// Track a pull request (STI subclass of Issue)
const prs = new PullRequestCollection(db);
await prs.create({
  repositoryId: repo.id,
  title: 'Fix login flow',
  number: 43,
  state: 'open',
  sourceBranch: 'fix/login',
  targetBranch: 'main',
});
```

## API

### Models

| Export | Description |
|--------|------------|
| `Repository` | Git repository with provider integration |
| `Project` | Project board for organizing issues |
| `Issue` | Issue/ticket (STI base) |
| `PullRequest` | Pull request (STI subclass of Issue) |
| `Comment` | Comment on an issue or PR |
| `Label` | Label/tag for issues |

### Collections

`RepositoryCollection`, `ProjectCollection`, `IssueCollection`, `PullRequestCollection`

### Constants

`PROJECTS_MODULE_META`, `PROJECTS_UI_SLOTS`

### Key Types

`RepositoryProviderType`, `ProjectProviderType`, `ProjectStatus`, `SyncStatus`, `SearchFilters`, `CreateIssueInput`, `CreatePRInput`, `MergeMethod`, `IncorporateFeedbackOptions`

## Dependencies

- `@happyvertical/smrt-core` — ORM and code generation
- `@happyvertical/smrt-config` — configuration loading
- `@happyvertical/smrt-tenancy` — multi-tenant scoping
- `@happyvertical/smrt-types` — shared type definitions
- Peer: `@happyvertical/smrt-svelte`
