---
type: "Component"
title: "@happyvertical/smrt-projects"
description: "Provider-agnostic project management models (Issues, PRs, Repositories, Projects) for SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T23:37:37Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:45cda087530f33b674181e8fb95d6811325859b6d11e54b12f1fa754ee774306"
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
- Object source: `domain-artifact`
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

- `comment_get`: get on `@happyvertical/smrt-projects:Comment`
- `comment_list`: list on `@happyvertical/smrt-projects:Comment`
- `issue_get`: get on `@happyvertical/smrt-projects:Issue`
- `issue_incorporatefeedback`: incorporateFeedback on `@happyvertical/smrt-projects:Issue`
- `issue_list`: list on `@happyvertical/smrt-projects:Issue`
- `issue_sync`: sync on `@happyvertical/smrt-projects:Issue`
- `label_create`: create on `@happyvertical/smrt-projects:Label`
- `label_get`: get on `@happyvertical/smrt-projects:Label`
- `label_list`: list on `@happyvertical/smrt-projects:Label`
- `project_additem`: addItem on `@happyvertical/smrt-projects:Project`
- `project_get`: get on `@happyvertical/smrt-projects:Project`
- `project_list`: list on `@happyvertical/smrt-projects:Project`
- `project_sync`: sync on `@happyvertical/smrt-projects:Project`
- `project_updateitemstatus`: updateItemStatus on `@happyvertical/smrt-projects:Project`
- `projectintegration_get`: get on `@happyvertical/smrt-projects:ProjectIntegration`
- `projectintegration_list`: list on `@happyvertical/smrt-projects:ProjectIntegration`
- `pullrequest_get`: get on `@happyvertical/smrt-projects:PullRequest`
- `pullrequest_list`: list on `@happyvertical/smrt-projects:PullRequest`
- `pullrequest_merge`: merge on `@happyvertical/smrt-projects:PullRequest`
- `pullrequest_summarize`: summarize on `@happyvertical/smrt-projects:PullRequest`
- `pullrequest_sync`: sync on `@happyvertical/smrt-projects:PullRequest`
- `repository_get`: get on `@happyvertical/smrt-projects:Repository`
- `repository_list`: list on `@happyvertical/smrt-projects:Repository`
- `repository_sync`: sync on `@happyvertical/smrt-projects:Repository`
