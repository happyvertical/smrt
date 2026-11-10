---
type: "Component"
title: "@happyvertical/smrt-video"
description: "Video content management for AI-powered video production in the SMRT ecosystem"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:08:46Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:c968bfb244ff2843605d1de114ae9fa1ece00b83d70cca03e24c3f061c5a544e"
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
- Object source: `scanner`
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
- `CharacterAsset` (collection `characterassets`, extends `Asset`)
- `CharacterOwnedAsset` (collection `characterownedassets`, extends `SmrtObject`)
- `CharacterOwnedAssetCollection` (collection `characterownedassetcollections`, extends `SmrtJunction`)
- `CompositeJob` (collection `compositejobs`, extends `SmrtObject`, STI table)
- `Performer` (collection `performers`, extends `SmrtObject`, STI table)
- `PerformerAsset` (collection `performerassets`, extends `Asset`)
- `PerformerOwnedAsset` (collection `performerownedassets`, extends `SmrtObject`)
- `PerformerOwnedAssetCollection` (collection `performerownedassetcollections`, extends `SmrtJunction`)
- `Scene` (collection `scenes`, extends `SmrtObject`, STI table)
- `SceneAsset` (collection `sceneassets`, extends `Asset`)
- `SceneOwnedAsset` (collection `sceneownedassets`, extends `SmrtObject`)
- `SceneOwnedAssetCollection` (collection `sceneownedassetcollections`, extends `SmrtJunction`)
- `VideoComposition` (collection `videocompositions`, extends `Content`, STI table)
- `VideoCompositionAsset` (collection `videocompositionassets`, extends `Asset`)
- `VideoSequence` (collection `videosequences`, extends `Content`, STI table)
- `VideoSequenceAsset` (collection `videosequenceassets`, extends `Asset`)
- `VideoShot` (collection `videoshots`, extends `Content`, STI table)
- `VideoShotAsset` (collection `videoshotassets`, extends `Asset`)
- `VideoShotCharacter` (collection `videoshotcharacters`, extends `SmrtObject`, STI table)
- `VideoWorkflow` (collection `videoworkflows`, extends `SmrtObject`, STI table)

## MCP tools

- `get_characterassets`: get on `@happyvertical/smrt-video:CharacterAsset`
- `get_characters`: get on `@happyvertical/smrt-video:Character`
- `get_compositejobs`: get on `@happyvertical/smrt-video:CompositeJob`
- `get_performerassets`: get on `@happyvertical/smrt-video:PerformerAsset`
- `get_performers`: get on `@happyvertical/smrt-video:Performer`
- `get_sceneassets`: get on `@happyvertical/smrt-video:SceneAsset`
- `get_scenes`: get on `@happyvertical/smrt-video:Scene`
- `get_videocompositionassets`: get on `@happyvertical/smrt-video:VideoCompositionAsset`
- `get_videocompositions`: get on `@happyvertical/smrt-video:VideoComposition`
- `get_videosequenceassets`: get on `@happyvertical/smrt-video:VideoSequenceAsset`
- `get_videosequences`: get on `@happyvertical/smrt-video:VideoSequence`
- `get_videoshotassets`: get on `@happyvertical/smrt-video:VideoShotAsset`
- `get_videoshotcharacters`: get on `@happyvertical/smrt-video:VideoShotCharacter`
- `get_videoshots`: get on `@happyvertical/smrt-video:VideoShot`
- `get_videoworkflows`: get on `@happyvertical/smrt-video:VideoWorkflow`
- `list_characterassets`: list on `@happyvertical/smrt-video:CharacterAsset`
- `list_characters`: list on `@happyvertical/smrt-video:Character`
- `list_compositejobs`: list on `@happyvertical/smrt-video:CompositeJob`
- `list_performerassets`: list on `@happyvertical/smrt-video:PerformerAsset`
- `list_performers`: list on `@happyvertical/smrt-video:Performer`
- `list_sceneassets`: list on `@happyvertical/smrt-video:SceneAsset`
- `list_scenes`: list on `@happyvertical/smrt-video:Scene`
- `list_videocompositionassets`: list on `@happyvertical/smrt-video:VideoCompositionAsset`
- `list_videocompositions`: list on `@happyvertical/smrt-video:VideoComposition`
- `list_videosequenceassets`: list on `@happyvertical/smrt-video:VideoSequenceAsset`
- `list_videosequences`: list on `@happyvertical/smrt-video:VideoSequence`
- `list_videoshotassets`: list on `@happyvertical/smrt-video:VideoShotAsset`
- `list_videoshotcharacters`: list on `@happyvertical/smrt-video:VideoShotCharacter`
- `list_videoshots`: list on `@happyvertical/smrt-video:VideoShot`
- `list_videoworkflows`: list on `@happyvertical/smrt-video:VideoWorkflow`
