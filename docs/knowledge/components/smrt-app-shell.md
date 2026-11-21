---
type: "Component"
title: "@happyvertical/smrt-app-shell"
description: "A smrt app that builds and runs a person's own smrt app from definitions"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-21T22:32:40Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:48f265ccea922dd801798b42c6b4d228d2a0a90983ca203b962f4d925104a362"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/package.json"
    title: "@happyvertical/smrt-app-shell package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/AGENTS.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/agents/cloud-profile.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/agents/cloud-profile.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/agents/deploy.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/agents/deploy.md"
  - id: "agents-4"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/agents/draft-ui.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/agents/draft-ui.md"
  - id: "agents-5"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/agents/engine.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/agents/engine.md"
  - id: "agents-6"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/agents/hosted-inference.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/agents/hosted-inference.md"
  - id: "agents-7"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/agents/imports.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/agents/imports.md"
  - id: "agents-8"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/agents/shared-pieces.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/agents/shared-pieces.md"
  - id: "agents-9"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/agents/storage-metering.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/agents/storage-metering.md"
---

# @happyvertical/smrt-app-shell

## Package

- Directory: `packages/app-shell`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/app-shell/AGENTS.md`
- `packages/app-shell/agents/cloud-profile.md`
- `packages/app-shell/agents/deploy.md`
- `packages/app-shell/agents/draft-ui.md`
- `packages/app-shell/agents/engine.md`
- `packages/app-shell/agents/hosted-inference.md`
- `packages/app-shell/agents/imports.md`
- `packages/app-shell/agents/shared-pieces.md`
- `packages/app-shell/agents/storage-metering.md`

## Framework dependencies

- [smrt-app-mcp](/components/smrt-app-mcp.md)
- [smrt-app-runtime](/components/smrt-app-runtime.md)
- [smrt-chat](/components/smrt-chat.md)
- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-features](/components/smrt-features.md)
- [smrt-inference](/components/smrt-inference.md)
- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-preferences](/components/smrt-preferences.md)
- [smrt-profiles](/components/smrt-profiles.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-reports](/components/smrt-reports.md)
- [smrt-secrets](/components/smrt-secrets.md)
- [smrt-spreadsheets](/components/smrt-spreadsheets.md)
- [smrt-subscriptions](/components/smrt-subscriptions.md)
- [smrt-svelte](/components/smrt-svelte.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)
- [smrt-web](/components/smrt-web.md)
- [smrt-workflows](/components/smrt-workflows.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/sql`

## Exports

- `.`
- `./engine`
- `./engine/worker`
- `./manifest`
- `./shutdown`
- `./start`

## Models

- `App` (collection `apps`, extends `SmrtObject`)
- `AppDraft` (collection `appdrafts`, extends `SmrtObject`)
- `AppDraftVersion` (collection `appdraftversions`, extends `SmrtObject`)
- `AppImport` (collection `appimports`, extends `SmrtObject`)
- `AppVersion` (collection `appversions`, extends `SmrtObject`)
- `Approval` (collection `approvals`, extends `SmrtObject`)
- `AssistantMessage` (collection `assistantmessages`, extends `SmrtObject`)
- `AssistantThread` (collection `assistantthreads`, extends `SmrtObject`)
- `ChangeBatch` (collection `changebatches`, extends `SmrtObject`)
- `ChangeCard` (collection `changecards`, extends `SmrtObject`)

## MCP tools

- `addField_apps`: addField on `@happyvertical/smrt-app-shell:App`
- `addMethod_apps`: addMethod on `@happyvertical/smrt-app-shell:App`
- `changeFieldType_apps`: changeFieldType on `@happyvertical/smrt-app-shell:App`
- `cleanUp_apps`: cleanUp on `@happyvertical/smrt-app-shell:App`
- `decide_approvals`: decide on `@happyvertical/smrt-app-shell:Approval`
- `defineModel_apps`: defineModel on `@happyvertical/smrt-app-shell:App`
- `describe_apps`: describe on `@happyvertical/smrt-app-shell:App`
- `enableRecipe_apps`: enableRecipe on `@happyvertical/smrt-app-shell:App`
- `exportTemplate_apps`: exportTemplate on `@happyvertical/smrt-app-shell:App`
- `hideField_apps`: hideField on `@happyvertical/smrt-app-shell:App`
- `history_apps`: history on `@happyvertical/smrt-app-shell:App`
- `importTemplate_apps`: importTemplate on `@happyvertical/smrt-app-shell:App`
- `pending_approvals`: pending on `@happyvertical/smrt-app-shell:Approval`
- `removeField_apps`: removeField on `@happyvertical/smrt-app-shell:App`
- `removeModel_apps`: removeModel on `@happyvertical/smrt-app-shell:App`
- `renameField_apps`: renameField on `@happyvertical/smrt-app-shell:App`
- `undoTo_apps`: undoTo on `@happyvertical/smrt-app-shell:App`
- `undo_apps`: undo on `@happyvertical/smrt-app-shell:App`
