# @happyvertical/smrt-video

Video production pipeline for AI-powered video generation in the SMRT ecosystem. Models characters, performers, scenes, shots, sequences, compositions, and ComfyUI workflow templates.

## Installation

```bash
pnpm add @happyvertical/smrt-video
```

## Usage

```typescript
import {
  Character,
  Performer,
  Scene,
  VideoShot,
  VideoSequence,
  VideoComposition,
  VideoShotCharacter,
  VideoWorkflow,
} from '@happyvertical/smrt-video';
import { Asset } from '@happyvertical/smrt-assets';

// Character = role being played (outfit, voice, branding)
const anchor = new Character({
  name: 'Bentley News Anchor',
  voiceProfileId: 'voice-123',
});
await anchor.save();

const seedImage = new Asset({
  name: 'Anchor Seed',
  sourceUri: 'file:///tmp/anchor-seed.png',
  mimeType: 'image/png',
});
await seedImage.save();
await anchor.addAsset(seedImage, 'seed-image');

// Performer = physical likeness for IP-Adapter face consistency
const performer = new Performer({ name: 'Alex', ipAdapterWeight: 0.85 });

// Scene = virtual background (image, video, or 360 panorama)
const studio = new Scene({
  name: 'News Studio',
  sourceType: 'image',
  projection: 'flat',
});

// Hierarchy: Composition -> Sequence -> Shot -> ShotCharacter
const composition = new VideoComposition({
  title: 'Evening News - March 2, 2026',
  fps: 30,
  width: 1920,
  height: 1080,
});
await composition.save();

const shot = new VideoShot({
  scriptText: 'Welcome to the evening news broadcast.',
  targetDuration: 30,
});
await shot.save();
// Estimated speech duration: scriptWordCount / 2.7 words per second
shot.estimatedDuration; // ~2.2 seconds
await shot.addAsset(seedImage, 'thumbnail');

// ComfyUI workflow with dynamic parameter injection
const workflow = new VideoWorkflow({
  name: 'Wan 2.6 + EchoMimic',
  workflowType: 'broadcast',
  workflowJson: comfyuiApiJson,
  nodeMapping: { seedImage: '1', audioFile: '5', outputVideo: '12' },
  requiredModels: ['wan_2.6_t2v_14b_fp8', 'echomimic_v2'],
});
await workflow.save();

// Inject runtime parameters into a deep-cloned workflow
const injected = workflow.injectParameters({
  seedImage: '/path/to/anchor.png',
  audioFile: '/path/to/tts.wav',
});
```

## API

### Models

| Export | Description |
|--------|------------|
| `Character` | Virtual persona: seed image + voice profile + branding kit |
| `Performer` | Physical likeness for IP-Adapter FaceID consistency |
| `Scene` | Virtual background with viewpoints, lighting, and anchor points |
| `VideoShot` | Atomic generation unit (extends Content) with script and frame duration |
| `VideoShotCharacter` | Junction: shot-to-character with role (primary/secondary/background) |
| `VideoSequence` | Thematic section (extends Content) with transition type and ordering |
| `VideoComposition` | Top-level container (extends Content): fps, resolution, render status |
| `VideoWorkflow` | ComfyUI template with node mapping for parameter injection |
| `CompositeJob` | Tracks a multi-step video generation job |

Collections: `CharacterCollection`, `VideoCompositionCollection`, `VideoSequenceCollection`, `VideoShotCollection`, `VideoShotCharacterCollection`.

Canonical owned asset joins:
- `CharacterOwnedAsset` -> `character_assets`
- `PerformerOwnedAsset` -> `performer_assets`
- `SceneOwnedAsset` -> `scene_assets`
- `VideoShot`, `VideoSequence`, and `VideoComposition` inherit `Content` asset helpers backed by `content_assets`

Legacy STI asset subclasses `CharacterAsset`, `PerformerAsset`, `SceneAsset`, `VideoCompositionAsset`, `VideoSequenceAsset`, and `VideoShotAsset` remain readable during migration, but new writes should go through the model helpers.
Provision the new join tables with `smrt db:migrate` before relying on canonical writes. Reads still fall back to legacy fields / STI rows when the new tables are not present yet.

### Key Types

| Export | Description |
|--------|------------|
| `CharacterStatus` | `pending`, `ready` |
| `BrandingConfig` | Logo, colors, fonts, lower-thirds, ticker settings |
| `WorkflowType` | `prebake`, `broadcast`, `lipsync`, `postprod`, `custom` |
| `NodeMapping` | Maps semantic names (seedImage, audioFile, etc.) to ComfyUI node IDs |
| `RenderStatus` | `draft`, `rendering`, `ready`, `failed` |
| `VideoShotStatus` | `draft`, `queued`, `processing`, `ready`, `failed`, `published` |
| `TransitionType` | `none`, `fade`, `slide`, `wipe` |
| `VideoMetadata` | Duration, resolution, codec, fps, word timings |
| `SceneSourceType` | `image`, `video`, `panorama_360`, `panorama_180` |
| `VideoShotCharacterRole` | `primary`, `secondary`, `background` |

### Design Principle

Store frames, compute seconds. All duration fields use `durationInFrames`; convert with `frames / fps`. Speech duration estimated at 2.7 words/second (+/- 15% tolerance).

### Asset Ownership

`Character`, `Performer`, and `Scene` expose `getAssets()`, `getAssetByRole()`, `addAsset()`, and `removeAsset()` on canonical noun-join tables. They continue to read legacy scalar slots and legacy STI asset rows during migration.

`VideoShot`, `VideoSequence`, and `VideoComposition` inherit the same helpers from `Content`, so their canonical ownership table is `content_assets` rather than a video-specific join table.

## Dependencies

- `@happyvertical/smrt-core` -- ORM and code generation
- `@happyvertical/smrt-assets` -- base asset management
- `@happyvertical/smrt-config` -- configuration loading
- `@happyvertical/smrt-content` -- content models (VideoShot/Sequence/Composition extend Content)
- `@happyvertical/smrt-profiles` -- profile references for characters
- `@happyvertical/smrt-tenancy` -- multi-tenant scoping
- `@happyvertical/smrt-voice` -- voice profile references
