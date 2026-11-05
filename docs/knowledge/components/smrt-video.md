---
type: "Component"
title: "@happyvertical/smrt-video"
description: "Video content management for AI-powered video production in the SMRT ecosystem"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T15:48:19Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:865f423b1f0ae219631164f7a8bb5924f24ee24f8132b4873a75611d60d5ce47"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/video/package.json"
    title: "@happyvertical/smrt-video package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/video/AGENTS.md"
    title: "@happyvertical/smrt-video packages/video/AGENTS.md"
---

# @happyvertical/smrt-video

## Package

- Directory: `packages/video`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/video/AGENTS.md`

## Framework dependencies

- [smrt-assets](/components/smrt-assets.md)
- [smrt-config](/components/smrt-config.md)
- [smrt-content](/components/smrt-content.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-profiles](/components/smrt-profiles.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)
- [smrt-voice](/components/smrt-voice.md)

## SDK dependencies

- `@happyvertical/logger`
- `@happyvertical/sql`
- `@happyvertical/utils`

## Exports

- `.`
- `./manifest`
- `./manifest.json`

## Models

- `Character` (collection `characters`, extends `SmrtObject`, STI table)
- `CharacterAsset` (collection `assets`, extends `Asset`, STI table)
- `CharacterCollection` (collection `characters`, extends `SmrtCollection`)
- `CharacterOwnedAsset` (collection `characterownedassets`, extends `SmrtObject`)
- `CharacterOwnedAssetCollection` (collection `characterownedassets`, extends `SmrtJunction`)
- `CompositeJob` (collection `compositejobs`, extends `SmrtObject`, STI table)
- `Performer` (collection `performers`, extends `SmrtObject`, STI table)
- `PerformerAsset` (collection `assets`, extends `Asset`, STI table)
- `PerformerOwnedAsset` (collection `performerownedassets`, extends `SmrtObject`)
- `PerformerOwnedAssetCollection` (collection `performerownedassets`, extends `SmrtJunction`)
- `Scene` (collection `scenes`, extends `SmrtObject`, STI table)
- `SceneAsset` (collection `assets`, extends `Asset`, STI table)
- `SceneOwnedAsset` (collection `sceneownedassets`, extends `SmrtObject`)
- `SceneOwnedAssetCollection` (collection `sceneownedassets`, extends `SmrtJunction`)
- `VideoComposition` (collection `contents`, extends `Content`, STI table)
- `VideoCompositionAsset` (collection `assets`, extends `Asset`, STI table)
- `VideoCompositionCollection` (collection `contents`, extends `SmrtCollection`)
- `VideoSequence` (collection `contents`, extends `Content`, STI table)
- `VideoSequenceAsset` (collection `assets`, extends `Asset`, STI table)
- `VideoSequenceCollection` (collection `contents`, extends `SmrtCollection`)
- `VideoShot` (collection `contents`, extends `Content`, STI table)
- `VideoShotAsset` (collection `assets`, extends `Asset`, STI table)
- `VideoShotCharacter` (collection `videoshotcharacters`, extends `SmrtObject`, STI table)
- `VideoShotCharacterCollection` (collection `videoshotcharacters`, extends `SmrtCollection`)
- `VideoShotCollection` (collection `contents`, extends `SmrtCollection`)
- `VideoWorkflow` (collection `videoworkflows`, extends `SmrtObject`, STI table)

## MCP tools

- `character_get`: get on `@happyvertical/smrt-video:Character`
- `character_list`: list on `@happyvertical/smrt-video:Character`
- `characterasset_get`: get on `@happyvertical/smrt-video:CharacterAsset`
- `characterasset_list`: list on `@happyvertical/smrt-video:CharacterAsset`
- `compositejob_get`: get on `@happyvertical/smrt-video:CompositeJob`
- `compositejob_list`: list on `@happyvertical/smrt-video:CompositeJob`
- `performer_get`: get on `@happyvertical/smrt-video:Performer`
- `performer_list`: list on `@happyvertical/smrt-video:Performer`
- `performerasset_get`: get on `@happyvertical/smrt-video:PerformerAsset`
- `performerasset_list`: list on `@happyvertical/smrt-video:PerformerAsset`
- `scene_get`: get on `@happyvertical/smrt-video:Scene`
- `scene_list`: list on `@happyvertical/smrt-video:Scene`
- `sceneasset_get`: get on `@happyvertical/smrt-video:SceneAsset`
- `sceneasset_list`: list on `@happyvertical/smrt-video:SceneAsset`
- `videocomposition_get`: get on `@happyvertical/smrt-video:VideoComposition`
- `videocomposition_list`: list on `@happyvertical/smrt-video:VideoComposition`
- `videocompositionasset_get`: get on `@happyvertical/smrt-video:VideoCompositionAsset`
- `videocompositionasset_list`: list on `@happyvertical/smrt-video:VideoCompositionAsset`
- `videosequence_get`: get on `@happyvertical/smrt-video:VideoSequence`
- `videosequence_list`: list on `@happyvertical/smrt-video:VideoSequence`
- `videosequenceasset_get`: get on `@happyvertical/smrt-video:VideoSequenceAsset`
- `videosequenceasset_list`: list on `@happyvertical/smrt-video:VideoSequenceAsset`
- `videoshot_get`: get on `@happyvertical/smrt-video:VideoShot`
- `videoshot_list`: list on `@happyvertical/smrt-video:VideoShot`
- `videoshotasset_get`: get on `@happyvertical/smrt-video:VideoShotAsset`
- `videoshotasset_list`: list on `@happyvertical/smrt-video:VideoShotAsset`
- `videoshotcharacter_get`: get on `@happyvertical/smrt-video:VideoShotCharacter`
- `videoshotcharacter_list`: list on `@happyvertical/smrt-video:VideoShotCharacter`
- `videoworkflow_get`: get on `@happyvertical/smrt-video:VideoWorkflow`
- `videoworkflow_list`: list on `@happyvertical/smrt-video:VideoWorkflow`
