---
type: "Component"
title: "@happyvertical/smrt-projects"
description: "Provider-agnostic project management models (Issues, PRs, Repositories, Projects) for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:08:46Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:d72d930ea9d4fc7228776c63de45f43f6fa6b34d3ae4c16fcfa0d8f12019973d"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/projects/package.json"
    title: "@happyvertical/smrt-projects package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/projects/AGENTS.md"
    title: "@happyvertical/smrt-projects packages/projects/AGENTS.md"
---

# @happyvertical/smrt-projects

## Package

- Directory: `packages/projects`
- Private: no
- Object source: `manifest`
- Evidence level: `source-inspected`

## Documentation

- `packages/projects/AGENTS.md`

## Framework dependencies

- [smrt-cli](/components/smrt-cli.md)
- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-subscriptions](/components/smrt-subscriptions.md)
- [smrt-svelte](/components/smrt-svelte.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-timesheets](/components/smrt-timesheets.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/logger`
- `@happyvertical/projects`
- `@happyvertical/repos`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./playground`
- `./svelte`
- `./ui`

## Models

- `AssistanceRequest` (collection `assistancerequests`, extends `SmrtObject`)
- `AssistanceRequestCollection` (collection `assistancerequests`, extends `SmrtCollection`)
- `AssistanceRequestEvent` (collection `assistancerequestevents`, extends `SmrtObject`)
- `AssistanceRequestEventCollection` (collection `assistancerequestevents`, extends `SmrtCollection`)
- `Comment` (collection `comments`, extends `SmrtObject`)
- `CommentCollection` (collection `comments`, extends `SmrtCollection`)
- `DevelopmentRequest` (collection `developmentrequests`, extends `SmrtObject`)
- `DevelopmentRequestCollection` (collection `developmentrequests`, extends `SmrtCollection`)
- `DevelopmentRequestHistory` (collection `developmentrequesthistories`, extends `SmrtObject`)
- `DevelopmentRequestHistoryCollection` (collection `developmentrequesthistories`, extends `SmrtCollection`)
- `DevelopmentRequestWorkLink` (collection `developmentrequestworklinks`, extends `SmrtObject`)
- `DevelopmentRequestWorkLinkCollection` (collection `developmentrequestworklinks`, extends `SmrtCollection`)
- `Issue` (collection `issues`, extends `SmrtObject`, STI table)
- `IssueCollection` (collection `issues`, extends `SmrtCollection`)
- `Label` (collection `labels`, extends `SmrtObject`)
- `PreviewApproval` (collection `previewapprovals`, extends `SmrtObject`)
- `PreviewApprovalCollection` (collection `previewapprovals`, extends `SmrtCollection`)
- `Project` (collection `projects`, extends `SmrtObject`)
- `ProjectCollection` (collection `projects`, extends `SmrtCollection`)
- `ProjectDecision` (collection `projectdecisions`, extends `SmrtPolymorphicAssociation`)
- `ProjectDecisionCollection` (collection `projectdecisions`, extends `SmrtCollection`)
- `ProjectDeliveryEvent` (collection `projectdeliveryevents`, extends `SmrtObject`)
- `ProjectDeliveryEventCollection` (collection `projectdeliveryevents`, extends `SmrtCollection`)
- `ProjectGovernanceEvent` (collection `projectgovernanceevents`, extends `SmrtPolymorphicAssociation`)
- `ProjectGovernanceEventCollection` (collection `projectgovernanceevents`, extends `SmrtCollection`)
- `ProjectIntegration` (collection `projectintegrations`, extends `SmrtObject`)
- `ProjectIntegrationAudit` (collection `projectintegrationaudits`, extends `SmrtObject`)
- `ProjectIntegrationAuditCollection` (collection `projectintegrationaudits`, extends `SmrtCollection`)
- `ProjectIntegrationCollection` (collection `projectintegrations`, extends `SmrtCollection`)
- `ProjectQuestion` (collection `projectquestions`, extends `SmrtPolymorphicAssociation`)
- `ProjectQuestionCollection` (collection `projectquestions`, extends `SmrtCollection`)
- `ProjectSpecification` (collection `projectspecifications`, extends `SmrtPolymorphicAssociation`)
- `ProjectSpecificationCollection` (collection `projectspecifications`, extends `SmrtCollection`)
- `PullRequest` (collection `issues`, extends `Issue`, STI table)
- `PullRequestCollection` (collection `issues`, extends `SmrtCollection`)
- `Repository` (collection `repositories`, extends `SmrtObject`)
- `RepositoryCollection` (collection `repositories`, extends `SmrtCollection`)

## MCP tools

- `addItem_projects`: addItem on `@happyvertical/smrt-projects:Project`
- `create_labels`: create on `@happyvertical/smrt-projects:Label`
- `get_comments`: get on `@happyvertical/smrt-projects:Comment`
- `get_comments`: get on `@happyvertical/smrt-projects:CommentCollection`
- `get_issues`: get on `@happyvertical/smrt-projects:Issue`
- `get_issues`: get on `@happyvertical/smrt-projects:IssueCollection`
- `get_issues`: get on `@happyvertical/smrt-projects:PullRequest`
- `get_issues`: get on `@happyvertical/smrt-projects:PullRequestCollection`
- `get_labels`: get on `@happyvertical/smrt-projects:Label`
- `get_projectintegrations`: get on `@happyvertical/smrt-projects:ProjectIntegration`
- `get_projectintegrations`: get on `@happyvertical/smrt-projects:ProjectIntegrationCollection`
- `get_projects`: get on `@happyvertical/smrt-projects:Project`
- `get_projects`: get on `@happyvertical/smrt-projects:ProjectCollection`
- `get_repositories`: get on `@happyvertical/smrt-projects:Repository`
- `get_repositories`: get on `@happyvertical/smrt-projects:RepositoryCollection`
- `incorporateFeedback_issues`: incorporateFeedback on `@happyvertical/smrt-projects:Issue`
- `list_comments`: list on `@happyvertical/smrt-projects:Comment`
- `list_comments`: list on `@happyvertical/smrt-projects:CommentCollection`
- `list_issues`: list on `@happyvertical/smrt-projects:Issue`
- `list_issues`: list on `@happyvertical/smrt-projects:IssueCollection`
- `list_issues`: list on `@happyvertical/smrt-projects:PullRequest`
- `list_issues`: list on `@happyvertical/smrt-projects:PullRequestCollection`
- `list_labels`: list on `@happyvertical/smrt-projects:Label`
- `list_projectintegrations`: list on `@happyvertical/smrt-projects:ProjectIntegration`
- `list_projectintegrations`: list on `@happyvertical/smrt-projects:ProjectIntegrationCollection`
- `list_projects`: list on `@happyvertical/smrt-projects:Project`
- `list_projects`: list on `@happyvertical/smrt-projects:ProjectCollection`
- `list_repositories`: list on `@happyvertical/smrt-projects:Repository`
- `list_repositories`: list on `@happyvertical/smrt-projects:RepositoryCollection`
- `merge_issues`: merge on `@happyvertical/smrt-projects:PullRequest`
- `summarize_issues`: summarize on `@happyvertical/smrt-projects:PullRequest`
- `sync_issues`: sync on `@happyvertical/smrt-projects:Issue`
- `sync_issues`: sync on `@happyvertical/smrt-projects:PullRequest`
- `sync_projects`: sync on `@happyvertical/smrt-projects:Project`
- `sync_repositories`: sync on `@happyvertical/smrt-projects:Repository`
- `updateItemStatus_projects`: updateItemStatus on `@happyvertical/smrt-projects:Project`
