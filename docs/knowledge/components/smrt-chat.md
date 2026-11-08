---
type: "Component"
title: "@happyvertical/smrt-chat"
description: "Chat rooms, DMs, threads, and agent conversations for the SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T19:39:45Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:e706cb0eb1de31561988d9be5785c5b7d052b7573cf16173581bf765c44343d3"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/package.json"
    title: "@happyvertical/smrt-chat package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/AGENTS.md"
    title: "@happyvertical/smrt-chat packages/chat/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/ai-unavailable.md"
    title: "@happyvertical/smrt-chat packages/chat/agents/ai-unavailable.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/assistant-questions.md"
    title: "@happyvertical/smrt-chat packages/chat/agents/assistant-questions.md"
  - id: "agents-4"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/dev-workbench.md"
    title: "@happyvertical/smrt-chat packages/chat/agents/dev-workbench.md"
  - id: "agents-5"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/overview-tools.md"
    title: "@happyvertical/smrt-chat packages/chat/agents/overview-tools.md"
  - id: "agents-6"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/recipes.md"
    title: "@happyvertical/smrt-chat packages/chat/agents/recipes.md"
  - id: "agents-7"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/token-streaming.md"
    title: "@happyvertical/smrt-chat packages/chat/agents/token-streaming.md"
  - id: "agents-8"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/tool-loop.md"
    title: "@happyvertical/smrt-chat packages/chat/agents/tool-loop.md"
---

# @happyvertical/smrt-chat

## Package

- Directory: `packages/chat`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/chat/AGENTS.md`
- `packages/chat/agents/ai-unavailable.md`
- `packages/chat/agents/assistant-questions.md`
- `packages/chat/agents/dev-workbench.md`
- `packages/chat/agents/overview-tools.md`
- `packages/chat/agents/recipes.md`
- `packages/chat/agents/token-streaming.md`
- `packages/chat/agents/tool-loop.md`

## Framework dependencies

- [smrt-agents](/components/smrt-agents.md)
- [smrt-assets](/components/smrt-assets.md)
- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-images](/components/smrt-images.md)
- [smrt-personas](/components/smrt-personas.md)
- [smrt-playground](/components/smrt-playground.md)
- [smrt-profiles](/components/smrt-profiles.md)
- [smrt-reports](/components/smrt-reports.md)
- [smrt-scanner](/components/smrt-scanner.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)
- [smrt-web](/components/smrt-web.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/images`
- `@happyvertical/sql`

## Exports

- `.`
- `./assistant-turn`
- `./client`
- `./data-surface`
- `./data-surface-bridge`
- `./helper-preferences`
- `./internal/agent-runtime`
- `./manifest`
- `./manifest.json`
- `./playground`
- `./svelte`
- `./sveltekit`
- `./ui`

## Models

- `AgentSession` (collection `agentsessions`, extends `SmrtObject`)
- `ChatMessage` (collection `chatmessages`, extends `SmrtObject`)
- `ChatParticipant` (collection `chatparticipants`, extends `SmrtObject`)
- `ChatReaction` (collection `chatreactions`, extends `SmrtObject`)
- `ChatRoom` (collection `chatrooms`, extends `SmrtObject`)
- `ChatThread` (collection `chatthreads`, extends `SmrtObject`)
- `VoiceGatewayTurn` (collection `voicegatewayturns`, extends `SmrtObject`)
- `VoiceSession` (collection `voicesessions`, extends `SmrtObject`)

## MCP tools

- `get_agentsessions`: get on `@happyvertical/smrt-chat:AgentSession`
- `get_chatmessages`: get on `@happyvertical/smrt-chat:ChatMessage`
- `get_chatparticipants`: get on `@happyvertical/smrt-chat:ChatParticipant`
- `get_chatrooms`: get on `@happyvertical/smrt-chat:ChatRoom`
- `get_chatthreads`: get on `@happyvertical/smrt-chat:ChatThread`
- `get_voicegatewayturns`: get on `@happyvertical/smrt-chat:VoiceGatewayTurn`
- `get_voicesessions`: get on `@happyvertical/smrt-chat:VoiceSession`
- `list_agentsessions`: list on `@happyvertical/smrt-chat:AgentSession`
- `list_chatmessages`: list on `@happyvertical/smrt-chat:ChatMessage`
- `list_chatparticipants`: list on `@happyvertical/smrt-chat:ChatParticipant`
- `list_chatreactions`: list on `@happyvertical/smrt-chat:ChatReaction`
- `list_chatrooms`: list on `@happyvertical/smrt-chat:ChatRoom`
- `list_chatthreads`: list on `@happyvertical/smrt-chat:ChatThread`
- `list_voicegatewayturns`: list on `@happyvertical/smrt-chat:VoiceGatewayTurn`
- `list_voicesessions`: list on `@happyvertical/smrt-chat:VoiceSession`
