---
type: "Component"
title: "@happyvertical/smrt-app-shell"
description: "A smrt app that builds and runs a person's own smrt app from definitions"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-14T15:17:16Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:623f8eb22128bb2f106398491c4c07ba2dd074232a1bdd22bea1015c3033912e"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/package.json"
    title: "@happyvertical/smrt-app-shell package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/AGENTS.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/agents/draft-ui.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/agents/draft-ui.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/agents/engine.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/agents/engine.md"
  - id: "agents-4"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/app-shell/agents/shared-pieces.md"
    title: "@happyvertical/smrt-app-shell packages/app-shell/agents/shared-pieces.md"
---

# @happyvertical/smrt-app-shell

## Package

- Directory: `packages/app-shell`
- Private: no
- Object source: `manifest`
- Evidence level: `source-inspected`

## Documentation

- `packages/app-shell/AGENTS.md`
- `packages/app-shell/agents/draft-ui.md`
- `packages/app-shell/agents/engine.md`
- `packages/app-shell/agents/shared-pieces.md`

## Framework dependencies

- [smrt-app-mcp](/components/smrt-app-mcp.md)
- [smrt-app-runtime](/components/smrt-app-runtime.md)
- [smrt-chat](/components/smrt-chat.md)
- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-inference](/components/smrt-inference.md)
- [smrt-preferences](/components/smrt-preferences.md)
- [smrt-profiles](/components/smrt-profiles.md)
- [smrt-reports](/components/smrt-reports.md)
- [smrt-secrets](/components/smrt-secrets.md)
- [smrt-svelte](/components/smrt-svelte.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)
- [smrt-web](/components/smrt-web.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/sql`

## Exports

- `.`
- `./engine`
- `./engine/worker`
- `./manifest`

## Models

- `App` (collection `apps`, extends `SmrtObject`)
- `AppCollection` (collection `apps`, extends `SmrtCollection`)
- `AppDraft` (collection `appdrafts`, extends `SmrtObject`)
- `AppDraftCollection` (collection `appdrafts`, extends `SmrtCollection`)
- `AppDraftVersion` (collection `appdraftversions`, extends `SmrtObject`)
- `AppDraftVersionCollection` (collection `appdraftversions`, extends `SmrtCollection`)
- `AppVersion` (collection `appversions`, extends `SmrtObject`)
- `AppVersionCollection` (collection `appversions`, extends `SmrtCollection`)
- `Approval` (collection `approvals`, extends `SmrtObject`)
- `ApprovalCollection` (collection `approvals`, extends `SmrtCollection`)
- `AssistantMessage` (collection `assistantmessages`, extends `SmrtObject`)
- `AssistantMessageCollection` (collection `assistantmessages`, extends `SmrtCollection`)
- `AssistantThread` (collection `assistantthreads`, extends `SmrtObject`)
- `AssistantThreadCollection` (collection `assistantthreads`, extends `SmrtCollection`)

## MCP tools

- `addField_apps`: addField on `@happyvertical/smrt-app-shell:App`
- `addMethod_apps`: addMethod on `@happyvertical/smrt-app-shell:App`
- `changeFieldType_apps`: changeFieldType on `@happyvertical/smrt-app-shell:App`
- `cleanUp_apps`: cleanUp on `@happyvertical/smrt-app-shell:App`
- `decide_approvals`: decide on `@happyvertical/smrt-app-shell:Approval`
- `defineModel_apps`: defineModel on `@happyvertical/smrt-app-shell:App`
- `describe_apps`: describe on `@happyvertical/smrt-app-shell:App`
- `discardDraft_apps`: discardDraft on `@happyvertical/smrt-app-shell:App`
- `enableRecipe_apps`: enableRecipe on `@happyvertical/smrt-app-shell:App`
- `exportTemplate_apps`: exportTemplate on `@happyvertical/smrt-app-shell:App`
- `hideField_apps`: hideField on `@happyvertical/smrt-app-shell:App`
- `history_apps`: history on `@happyvertical/smrt-app-shell:App`
- `importTemplate_apps`: importTemplate on `@happyvertical/smrt-app-shell:App`
- `pending_approvals`: pending on `@happyvertical/smrt-app-shell:Approval`
- `previewPublish_apps`: previewPublish on `@happyvertical/smrt-app-shell:App`
- `publishDraft_apps`: publishDraft on `@happyvertical/smrt-app-shell:App`
- `removeField_apps`: removeField on `@happyvertical/smrt-app-shell:App`
- `removeModel_apps`: removeModel on `@happyvertical/smrt-app-shell:App`
- `renameField_apps`: renameField on `@happyvertical/smrt-app-shell:App`
- `startDraft_apps`: startDraft on `@happyvertical/smrt-app-shell:App`
- `undoTo_apps`: undoTo on `@happyvertical/smrt-app-shell:App`
- `undo_apps`: undo on `@happyvertical/smrt-app-shell:App`
