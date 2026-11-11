---
type: "Component"
title: "@happyvertical/smrt-chat"
description: "Chat rooms, DMs, threads, and agent conversations for the SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-11T04:54:32Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:be7af23603336e10fdda30c90bef89a86746bc07bff953520881137003afeecd"
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
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/owner-approvals.md"
    title: "@happyvertical/smrt-chat packages/chat/agents/owner-approvals.md"
  - id: "agents-7"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/recipes.md"
    title: "@happyvertical/smrt-chat packages/chat/agents/recipes.md"
  - id: "agents-8"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/token-streaming.md"
    title: "@happyvertical/smrt-chat packages/chat/agents/token-streaming.md"
  - id: "agents-9"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/tool-loop.md"
    title: "@happyvertical/smrt-chat packages/chat/agents/tool-loop.md"
  - id: "agents-10"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/chat/agents/turn-drivers.md"
    title: "@happyvertical/smrt-chat packages/chat/agents/turn-drivers.md"
---

# @happyvertical/smrt-chat

## Package

- Directory: `packages/chat`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/chat/AGENTS.md`
- `packages/chat/agents/ai-unavailable.md`
- `packages/chat/agents/assistant-questions.md`
- `packages/chat/agents/dev-workbench.md`
- `packages/chat/agents/overview-tools.md`
- `packages/chat/agents/owner-approvals.md`
- `packages/chat/agents/recipes.md`
- `packages/chat/agents/token-streaming.md`
- `packages/chat/agents/tool-loop.md`
- `packages/chat/agents/turn-drivers.md`

## Framework dependencies

- [smrt-agents](/components/smrt-agents.md)
- [smrt-app-runtime](/components/smrt-app-runtime.md)
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
- `AgentSessionCollection` (collection `agentsessions`, extends `SmrtCollection`)
- `ChatMessage` (collection `chatmessages`, extends `SmrtObject`)
- `ChatMessageCollection` (collection `chatmessages`, extends `SmrtCollection`)
- `ChatParticipant` (collection `chatparticipants`, extends `SmrtObject`)
- `ChatParticipantCollection` (collection `chatparticipants`, extends `SmrtCollection`)
- `ChatReaction` (collection `chatreactions`, extends `SmrtObject`)
- `ChatReactionCollection` (collection `chatreactions`, extends `SmrtCollection`)
- `ChatRoom` (collection `chatrooms`, extends `SmrtObject`)
- `ChatRoomCollection` (collection `chatrooms`, extends `SmrtCollection`)
- `ChatThread` (collection `chatthreads`, extends `SmrtObject`)
- `ChatThreadCollection` (collection `chatthreads`, extends `SmrtCollection`)
- `VoiceGatewayTurn` (collection `voicegatewayturns`, extends `SmrtObject`)
- `VoiceGatewayTurnCollection` (collection `voicegatewayturns`, extends `SmrtCollection`)
- `VoiceSession` (collection `voicesessions`, extends `SmrtObject`)
- `VoiceSessionCollection` (collection `voicesessions`, extends `SmrtCollection`)

## MCP tools

- `agentsession_get`: get on `@happyvertical/smrt-chat:AgentSession`
- `agentsession_list`: list on `@happyvertical/smrt-chat:AgentSession`
- `chatmessage_get`: get on `@happyvertical/smrt-chat:ChatMessage`
- `chatmessage_list`: list on `@happyvertical/smrt-chat:ChatMessage`
- `chatparticipant_get`: get on `@happyvertical/smrt-chat:ChatParticipant`
- `chatparticipant_list`: list on `@happyvertical/smrt-chat:ChatParticipant`
- `chatreaction_list`: list on `@happyvertical/smrt-chat:ChatReaction`
- `chatroom_get`: get on `@happyvertical/smrt-chat:ChatRoom`
- `chatroom_list`: list on `@happyvertical/smrt-chat:ChatRoom`
- `chatthread_get`: get on `@happyvertical/smrt-chat:ChatThread`
- `chatthread_list`: list on `@happyvertical/smrt-chat:ChatThread`
- `voicegatewayturn_get`: get on `@happyvertical/smrt-chat:VoiceGatewayTurn`
- `voicegatewayturn_list`: list on `@happyvertical/smrt-chat:VoiceGatewayTurn`
- `voicesession_get`: get on `@happyvertical/smrt-chat:VoiceSession`
- `voicesession_list`: list on `@happyvertical/smrt-chat:VoiceSession`

## Agent intents

- `chatdev.stage_draft_subject`: Stage a subject line into the dev workbench draft form. The value is a proposal: a human reviews and applies it. (`src/routes/chat-dev.intents.ts`)
