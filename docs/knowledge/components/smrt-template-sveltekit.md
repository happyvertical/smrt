---
type: "Component"
title: "@happyvertical/smrt-template-sveltekit"
description: "Minimal SvelteKit project template with s-m-r-t framework integration"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-12T02:13:12Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:d20bd97d66e4b92a9f2a78d4b4a83539a812363ced18ae3bcfc8f3ff68665631"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/template-sveltekit/package.json"
    title: "@happyvertical/smrt-template-sveltekit package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/template-sveltekit/AGENTS.md"
    title: "@happyvertical/smrt-template-sveltekit packages/template-sveltekit/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/template-sveltekit/agents/cookbook-host.md"
    title: "@happyvertical/smrt-template-sveltekit packages/template-sveltekit/agents/cookbook-host.md"
---

# @happyvertical/smrt-template-sveltekit

## Package

- Directory: `packages/template-sveltekit`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/template-sveltekit/AGENTS.md`
- `packages/template-sveltekit/agents/cookbook-host.md`

## Framework dependencies

- [smrt-agents](/components/smrt-agents.md)
- [smrt-app-cli](/components/smrt-app-cli.md)
- [smrt-app-mcp](/components/smrt-app-mcp.md)
- [smrt-app-runtime](/components/smrt-app-runtime.md)
- [smrt-assets](/components/smrt-assets.md)
- [smrt-chat](/components/smrt-chat.md)
- [smrt-cli](/components/smrt-cli.md)
- [smrt-commerce](/components/smrt-commerce.md)
- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-inference](/components/smrt-inference.md)
- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-mcp-openai](/components/smrt-mcp-openai.md)
- [smrt-playbooks](/components/smrt-playbooks.md)
- [smrt-preferences](/components/smrt-preferences.md)
- [smrt-profiles](/components/smrt-profiles.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-reports](/components/smrt-reports.md)
- [smrt-scanner](/components/smrt-scanner.md)
- [smrt-secrets](/components/smrt-secrets.md)
- [smrt-svelte](/components/smrt-svelte.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-web](/components/smrt-web.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./host/CookbookModelPage.svelte`
- `./host/InferenceSettingsPage.svelte`
- `./host/client`
- `./host/generate`
- `./host/preferences`
- `./host/server`
- `./host/settings`
- `./host/sveltekit-client`
- `./template.config.js`
- `./template/*`

## Models

- `Note` (collection `notes`, extends `SmrtObject`)
- `ReferenceWorkItem` (collection `referenceworkitems`, extends `SmrtObject`)
- `ReferenceWorkItemAsset` (collection `referenceworkitemassets`, extends `SmrtObject`)

## MCP tools

- `archive_referenceworkitems`: archive on `@happyvertical/smrt-template-sveltekit:ReferenceWorkItem`
- `create_referenceworkitems`: create on `@happyvertical/smrt-template-sveltekit:ReferenceWorkItem`
- `delete_referenceworkitems`: delete on `@happyvertical/smrt-template-sveltekit:ReferenceWorkItem`
- `get_notes`: get on `@happyvertical/smrt-template-sveltekit:Note`
- `get_referenceworkitems`: get on `@happyvertical/smrt-template-sveltekit:ReferenceWorkItem`
- `list_notes`: list on `@happyvertical/smrt-template-sveltekit:Note`
- `list_referenceworkitems`: list on `@happyvertical/smrt-template-sveltekit:ReferenceWorkItem`
- `prepareForReview_referenceworkitems`: prepareForReview on `@happyvertical/smrt-template-sveltekit:ReferenceWorkItem`
- `update_referenceworkitems`: update on `@happyvertical/smrt-template-sveltekit:ReferenceWorkItem`
