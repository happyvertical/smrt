---
type: "Component"
title: "@happyvertical/smrt-voice"
description: "Voice profile management for AI-powered voice synthesis and cloning in the SMRT ecosystem"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:b3a2be45e1008706a29a11045accff2eec0111e4b99da7ebbc4e00490383d19f"
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

- Version: `0.60.8`
- Directory: `packages/voice`
- Private: no
- Object source: `domain-artifact`
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

- `VoiceOutput` (collection `contents`, extends `Content`, STI table)
- `VoiceProfile` (collection `voiceprofiles`, extends `SmrtObject`, STI table)
- `VoiceSample` (collection `voicesamples`, extends `SmrtObject`, STI table)

## MCP tools

- `voiceoutput_get`: get on `@happyvertical/smrt-voice:VoiceOutput`
- `voiceoutput_list`: list on `@happyvertical/smrt-voice:VoiceOutput`
- `voiceprofile_get`: get on `@happyvertical/smrt-voice:VoiceProfile`
- `voiceprofile_list`: list on `@happyvertical/smrt-voice:VoiceProfile`
- `voicesample_get`: get on `@happyvertical/smrt-voice:VoiceSample`
- `voicesample_list`: list on `@happyvertical/smrt-voice:VoiceSample`
