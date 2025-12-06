# @happyvertical/smrt-projects

Provider-agnostic project management models for the SMRT framework.

## Purpose

This package provides SMRT-wrapped models for GitHub-style project management:

- **Repository**: Repository tracking with provider-agnostic operations
- **Issue**: Issue tracking with AI-powered feedback incorporation
- **PullRequest**: PR tracking extending Issue with merge capabilities
- **Project**: Project board management (GitHub Projects V2, etc.)
- **Comment**: Issue/PR comments with AI analysis
- **Label**: Repository label management

## Architecture

```
@happyvertical/repos (SDK)         @happyvertical/projects (SDK)
        │                                    │
        │ getRepository()                    │ getProject()
        │                                    │
        └──────────────┬─────────────────────┘
                       │
                       ▼
        ┌──────────────────────────────┐
        │  @happyvertical/smrt-projects │
        │  (This Package)               │
        │                               │
        │  Issue extends SmrtObject     │
        │  PullRequest extends Issue    │
        │  Repository extends SmrtObject│
        │  Project extends SmrtObject   │
        └───────────────────────────────┘
```

## Key Concepts

### Provider Agnostic

All models use SDK packages that support multiple providers:
- GitHub (primary)
- GitLab (planned)
- Bitbucket (planned)
- Azure DevOps (planned)

### Token Config Reference

Models store token configuration keys, not tokens themselves:

```typescript
const repo = new Repository({
  owner: 'happyvertical',
  name: 'smrt',
  providerType: 'github',
  tokenConfigKey: 'GITHUB_TOKEN'  // Env var name, NOT the token
});

// Token is resolved at runtime:
// 1. process.env['GITHUB_TOKEN']
// 2. getModuleConfig('smrt-projects', {})['GITHUB_TOKEN']
```

### Living Spec (incorporateFeedback)

The `Issue.incorporateFeedback()` method implements the "Living Spec" pattern:

```typescript
// Preview synthesized content
const preview = await issue.incorporateFeedback({
  prompt: 'Focus on technical requirements'
});
console.log(preview.synthesized);

// Apply changes
const result = await issue.incorporateFeedback({
  apply: true
});

// Rollback if needed
await issue.rollback();
```

## Usage

### Basic Setup

```typescript
import {
  Repository,
  RepositoryCollection,
  Issue,
  IssueCollection
} from '@happyvertical/smrt-projects';

// Create collection with database
const repos = await RepositoryCollection.create({
  persistence: { type: 'sql', url: 'projects.db' },
  ai: { provider: 'openai', apiKey: process.env.OPENAI_API_KEY }
});

// Get or create repository
const repo = await repos.getOrCreate('happyvertical', 'smrt', {
  providerType: 'github',
  tokenConfigKey: 'GITHUB_TOKEN'
});
```

### Discovering Issues

```typescript
// Discover issues from GitHub and sync to database
const issues = await repo.getIssues({ state: 'open', limit: 10 });

// Or use collection directly
const issueCollection = await IssueCollection.create(options);
const discovered = await issueCollection.discover({
  repository: repo,
  filters: { state: 'open', labels: ['bug'] }
});
```

### AI-Powered Operations

```typescript
// Check if issue needs review
if (await issue.needsReview()) {
  console.log('Issue needs attention');
}

// Suggest labels
const suggestedLabels = await issue.suggestLabels();
await issue.addLabels(suggestedLabels);

// Summarize a PR
const summary = await pullRequest.summarize();
```

### Project Board Integration

```typescript
import { Project, ProjectCollection } from '@happyvertical/smrt-projects';

const projects = await ProjectCollection.create(options);
const project = await projects.getOrCreate('PVT_xxx', {
  providerType: 'github',
  tokenConfigKey: 'GITHUB_TOKEN'
});

// Add issue to project
await project.addItem(issue);

// Update status
await project.moveItem(issue, 'In Progress');
```

## Models Reference

### Repository

| Field | Type | Description |
|-------|------|-------------|
| owner | string | Repository owner |
| name | string | Repository name |
| fullName | string | owner/name |
| providerType | 'github'\|'gitlab'\|etc. | Provider type |
| tokenConfigKey | string | Env var for token |
| lastSyncedAt | Date | Last sync timestamp |

**Methods:**
- `sync()`: Sync from provider
- `getClient()`: Get SDK client
- `getIssues(filters?)`: Get issues
- `getPullRequests(filters?)`: Get PRs
- `createIssue(data)`: Create issue
- `createPullRequest(data)`: Create PR

### Issue

| Field | Type | Description |
|-------|------|-------------|
| repositoryId | foreignKey | Parent repository |
| number | number | Issue number |
| nodeId | string | GraphQL node ID |
| title | string | Issue title |
| body | string | Issue body |
| state | 'open'\|'closed' | Issue state |
| labels | string[] | Label names |
| synthesisCount | number | Times feedback incorporated |

**Methods:**
- `sync()`: Sync from provider
- `getComments()`: Get comments
- `addComment(body)`: Add comment
- `incorporateFeedback(options?)`: AI synthesis
- `rollback()`: Revert to original
- `needsReview()`: AI check
- `suggestLabels()`: AI label suggestions

### PullRequest (extends Issue)

| Field | Type | Description |
|-------|------|-------------|
| headRef | string | Source branch |
| baseRef | string | Target branch |
| merged | boolean | Is merged |
| draft | boolean | Is draft |
| additions | number | Lines added |
| deletions | number | Lines deleted |

**Methods:**
- `summarize()`: AI summary
- `merge(method?)`: Merge PR
- `markReady()`: Mark as ready
- `isReadyToMerge()`: AI check

### Project

| Field | Type | Description |
|-------|------|-------------|
| projectId | string | Provider project ID |
| title | string | Project title |
| statuses | Status[] | Available columns |
| statusFieldId | string | GitHub V2 field ID |
| statusOptions | Record | Status name → ID map |

**Methods:**
- `sync()`: Sync from provider
- `addItem(issue)`: Add to project
- `removeItem(itemId)`: Remove item
- `updateItemStatus(itemId, status)`: Move item
- `listItems(filters?)`: List items
- `analyzeHealth()`: AI analysis

## Collections

All collections extend `SmrtCollection` and provide:

- `discover({ repository, filters })`: Sync from provider
- `findByRepository(repoId)`: Query by repository
- `findOpen(repoId?)`: Query open items
- `batchSync(repository)`: Sync all items

## Testing

```bash
# Generate manifest and run tests
smrt test

# Or run manually
smrt test --manifest-only
npx vitest run
```

## Dependencies

- `@happyvertical/smrt-core`: SMRT framework
- `@happyvertical/repos`: Repository SDK
- `@happyvertical/projects`: Projects SDK

## Environment Variables

| Variable | Description |
|----------|-------------|
| GITHUB_TOKEN | Default GitHub token |
| GITLAB_TOKEN | GitLab token (if using GitLab) |

Or configure via smrt.config:

```javascript
// smrt.config.js
export default {
  modules: {
    'smrt-projects': {
      GITHUB_TOKEN: 'ghp_xxx'
    }
  }
}
```
