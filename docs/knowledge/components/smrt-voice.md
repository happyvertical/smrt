---
type: "Component"
title: "@happyvertical/smrt-voice"
description: "Voice profile management for AI-powered voice synthesis and cloning in the SMRT ecosystem"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T02:12:11Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:50f181ecbe733363277b81418a59b5d8275de5d6127449bae49afae0b2dd26bd"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/voice/package.json"
    title: "@happyvertical/smrt-voice package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/voice/AGENTS.md"
    title: "@happyvertical/smrt-voice packages/voice/AGENTS.md"
---

# @happyvertical/smrt-voice

## Package

- Directory: `packages/voice`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/voice/AGENTS.md`

## Framework dependencies

- [smrt-assets](/components/smrt-assets.md)
- [smrt-config](/components/smrt-config.md)
- [smrt-content](/components/smrt-content.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./manifest`
- `./manifest.json`

## Models

- `VoiceOutput` (collection `voiceoutputs`, extends `Content`, STI table)
- `VoiceProfile` (collection `voiceprofiles`, extends `SmrtObject`, STI table)
- `VoiceSample` (collection `voicesamples`, extends `SmrtObject`, STI table)

## MCP tools

- `get_voiceoutputs`: get on `@happyvertical/smrt-voice:VoiceOutput`
- `get_voiceprofiles`: get on `@happyvertical/smrt-voice:VoiceProfile`
- `get_voicesamples`: get on `@happyvertical/smrt-voice:VoiceSample`
- `list_voiceoutputs`: list on `@happyvertical/smrt-voice:VoiceOutput`
- `list_voiceprofiles`: list on `@happyvertical/smrt-voice:VoiceProfile`
- `list_voicesamples`: list on `@happyvertical/smrt-voice:VoiceSample`
