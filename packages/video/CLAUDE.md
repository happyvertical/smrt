# @happyvertical/smrt-video

AI-powered video content management with characters, performers, scenes, shot composition, and ComfyUI workflow integration.

## Architecture

```
src/
  index.ts                    # Export barrel
  character.ts                # Virtual character (voice + visual identity)
  characters.ts               # CharacterCollection
  performer.ts                # Physical likeness for consistent generation
  personality-profile.ts      # Deprecated alias for Character
  scene.ts                    # 360° panorama or standard backgrounds
  video-composition.ts        # Publishable container with render specs
  video-compositions.ts       # VideoCompositionCollection
  video-sequence.ts           # Thematic section with transitions
  video-sequences.ts          # VideoSequenceCollection
  video-shot.ts               # Atomic generation unit
  video-shots.ts              # VideoShotCollection
  video-shot-character.ts     # Join: shot ↔ character with role/position
  video-shot-characters.ts    # VideoShotCharacterCollection
  video-workflow.ts           # ComfyUI template management
  composite-job.ts            # Batch rendering job tracker
  *-asset.ts                  # STI asset subclasses per model
  types/                      # Shared types
```

## Key Models

- `Character` — Virtual character with voice + visual identity (renamed from PersonalityProfile)
- `Performer` — Physical likeness/face DNA for IP-Adapter FaceID generation
- `Scene` — 360° panorama or standard background with anchor points, lighting profiles
- `VideoComposition` — Publishable container: fps, width, height, render specs
- `VideoSequence` — Thematic section with transitions (extends Content)
- `VideoShot` — Atomic generation unit: durationInFrames, scriptText, trimming (extends Content)
- `VideoShotCharacter` — Join table: shot + character with role (primary/secondary/background) and position
- `VideoWorkflow` — ComfyUI workflow templates with node mappings for dynamic parameter injection
- `CompositeJob` — Batch rendering job tracking

## Key Patterns

- **Video hierarchy**: Composition → Sequence → Shot → ShotCharacter
- **Asset layer**: Each model has a corresponding STI asset subclass (CharacterAsset, SceneAsset, etc.)
- **ComfyUI integration**: VideoWorkflow stores workflow JSON with node mappings for seed images, audio, prompts
- **Workflow types**: prebake, broadcast, lipsync, postprod, custom
- **Multi-tenancy**: Optional tenant scoping via `@TenantScoped`
- **STI throughout**: Most models use `tableStrategy: 'sti'`

## Dependencies

- `@happyvertical/smrt-core`, `@happyvertical/smrt-tenancy`
- `@happyvertical/smrt-content` (Content base class for shots, sequences)
- `@happyvertical/smrt-assets` (Asset subclasses)
- `@happyvertical/smrt-profiles`, `@happyvertical/smrt-config`
- `@happyvertical/smrt-voice` (VoiceProfile FK)
- `@happyvertical/utils`
