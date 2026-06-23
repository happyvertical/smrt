/**
 * Unit tests for the pure (DB-free) model logic in smrt-video:
 * constructor option handling plus computed getters and helpers on
 * VideoShot, Performer, Scene, and VideoShotCharacter.
 *
 * These exercise plain TypeScript business logic (frame/word arithmetic,
 * status predicates, asset-presence checks) without touching the database,
 * per `.claude/rules/testing.md` (no DB mocking; only construct real models).
 */

import { describe, expect, it } from 'vitest';
import { Performer } from '../performer.js';
import { Scene } from '../scene.js';
import { VideoShot } from '../video-shot.js';
import { VideoShotCharacter } from '../video-shot-character.js';

describe('VideoShot model logic', () => {
  it('derives scriptWordCount from scriptText in the constructor', () => {
    const shot = new VideoShot({
      scriptText: 'Welcome to the evening news tonight',
    });
    expect(shot.scriptWordCount).toBe(6);
  });

  it('lets an explicit scriptWordCount override the derived count', () => {
    const shot = new VideoShot({
      scriptText: 'one two three',
      scriptWordCount: 42,
    });
    expect(shot.scriptWordCount).toBe(42);
  });

  it('applies all constructor options', () => {
    const shot = new VideoShot({
      sequenceId: 'seq-1',
      sceneId: 'scene-1',
      position: 3,
      durationInFrames: 120,
      trimBeforeFrames: 5,
      trimAfterFrames: 10,
      targetDuration: 20,
      shotStatus: 'processing',
      progress: 45,
      errorMessage: null,
      statusMessage: 'rendering',
      videoMetadata: { fps: 30, resolution: '1920x1080' },
    });
    expect(shot.sequenceId).toBe('seq-1');
    expect(shot.sceneId).toBe('scene-1');
    expect(shot.position).toBe(3);
    expect(shot.durationInFrames).toBe(120);
    expect(shot.trimBeforeFrames).toBe(5);
    expect(shot.trimAfterFrames).toBe(10);
    expect(shot.targetDuration).toBe(20);
    expect(shot.shotStatus).toBe('processing');
    expect(shot.progress).toBe(45);
    expect(shot.statusMessage).toBe('rendering');
    expect(shot.videoMetadata.fps).toBe(30);
  });

  it('estimates speech duration at 2.7 words/sec', () => {
    const shot = new VideoShot({ scriptWordCount: 27 });
    expect(shot.estimatedDuration).toBeCloseTo(10, 5);
  });

  it('validates script length against target duration within +/-15%', () => {
    // 27 words -> 10s estimated; target 10s is within tolerance.
    const onTarget = new VideoShot({ scriptWordCount: 27, targetDuration: 10 });
    expect(onTarget.isScriptLengthValid).toBe(true);

    // 27 words -> 10s estimated; target 30s is far outside tolerance.
    const tooShort = new VideoShot({
      scriptWordCount: 27,
      targetDuration: 30,
    });
    expect(tooShort.isScriptLengthValid).toBe(false);
  });

  it('recommends a word-count window for the target duration', () => {
    const shot = new VideoShot({ targetDuration: 10 });
    const rec = shot.recommendedWordCount;
    // 10s * 2.7 = 27 target, tolerance round(27*0.15)=4.
    expect(rec.target).toBe(27);
    expect(rec.min).toBe(23);
    expect(rec.max).toBe(31);
  });

  it('computes effective frames after trimming and clamps at zero', () => {
    const trimmed = new VideoShot({
      durationInFrames: 100,
      trimBeforeFrames: 10,
      trimAfterFrames: 20,
    });
    expect(trimmed.effectiveFrames).toBe(70);

    const overTrimmed = new VideoShot({
      durationInFrames: 10,
      trimBeforeFrames: 20,
      trimAfterFrames: 5,
    });
    expect(overTrimmed.effectiveFrames).toBe(0);
  });

  it('reports generation and readiness state from shotStatus', () => {
    expect(new VideoShot({ shotStatus: 'queued' }).isGenerating).toBe(true);
    expect(new VideoShot({ shotStatus: 'processing' }).isGenerating).toBe(true);
    expect(new VideoShot({ shotStatus: 'draft' }).isGenerating).toBe(false);

    expect(new VideoShot({ shotStatus: 'ready' }).isReady).toBe(true);
    expect(new VideoShot({ shotStatus: 'draft' }).isReady).toBe(false);
  });

  it('recalculates word count via setScript()', () => {
    const shot = new VideoShot();
    shot.setScript('  the  quick brown   fox ');
    expect(shot.scriptText).toBe('  the  quick brown   fox ');
    expect(shot.scriptWordCount).toBe(4);
  });
});

describe('Performer model logic', () => {
  it('applies all constructor options', () => {
    const performer = new Performer({
      name: 'Alex Bentley',
      description: 'Lead anchor',
      dna: { gender: 'male', ageRange: 'adult', ipAdapterWeight: 0.8 },
      referenceAssetIds: ['ref-1', 'ref-2'],
      seedImageAssetId: 'seed-1',
      voiceProfileId: 'voice-1',
      status: 'ready',
      profileId: 'profile-1',
      tenantId: 'tenant-1',
    });
    expect(performer.name).toBe('Alex Bentley');
    expect(performer.description).toBe('Lead anchor');
    expect(performer.dna.ipAdapterWeight).toBe(0.8);
    expect(performer.referenceAssetIds).toEqual(['ref-1', 'ref-2']);
    expect(performer.seedImageAssetId).toBe('seed-1');
    expect(performer.voiceProfileId).toBe('voice-1');
    expect(performer.status).toBe('ready');
    expect(performer.profileId).toBe('profile-1');
    expect(performer.tenantId).toBe('tenant-1');
  });

  it('defaults DNA to neutral adult when not provided', () => {
    const performer = new Performer();
    expect(performer.dna.gender).toBe('neutral');
    expect(performer.dna.ageRange).toBe('adult');
    expect(performer.dna.ipAdapterWeight).toBe(0.7);
  });

  it('reports hasReferences based on referenceAssetIds', () => {
    expect(new Performer().hasReferences).toBe(false);
    expect(new Performer({ referenceAssetIds: ['ref-1'] }).hasReferences).toBe(
      true,
    );
  });

  it('reports hasFaceEmbedding based on the DNA embedding vector', () => {
    expect(new Performer().hasFaceEmbedding).toBe(false);
    expect(
      new Performer({
        dna: {
          gender: 'female',
          ageRange: 'adult',
          ipAdapterWeight: 0.7,
          faceEmbedding: [0.1, 0.2, 0.3],
        },
      }).hasFaceEmbedding,
    ).toBe(true);
  });

  it('is ready only when status is ready AND references exist', () => {
    expect(
      new Performer({ status: 'ready', referenceAssetIds: ['ref-1'] }).isReady,
    ).toBe(true);
    expect(new Performer({ status: 'ready' }).isReady).toBe(false);
    expect(
      new Performer({ status: 'pending', referenceAssetIds: ['ref-1'] })
        .isReady,
    ).toBe(false);
  });
});

describe('Scene model logic', () => {
  it('applies all constructor options', () => {
    const scene = new Scene({
      name: 'Town Hall',
      description: 'Exterior pano',
      sourceAssetId: 'asset-1',
      sourceType: 'panorama_360',
      projection: 'equirectangular',
      viewpoints: [{ id: 'vp-1', name: 'Front', pan: 0, tilt: 0, fov: 90 }],
      lightingProfile: { colorTemperature: 5600 },
      location: { name: 'Downtown' },
      anchorPoints: [
        {
          id: 'a-1',
          name: 'Center',
          position: { x: 0.5, y: 0.5 },
          suggestedScale: 1,
          groundY: 0.9,
        },
      ],
      status: 'ready',
      tenantId: 'tenant-1',
    });
    expect(scene.name).toBe('Town Hall');
    expect(scene.description).toBe('Exterior pano');
    expect(scene.sourceAssetId).toBe('asset-1');
    expect(scene.sourceType).toBe('panorama_360');
    expect(scene.projection).toBe('equirectangular');
    expect(scene.viewpoints).toHaveLength(1);
    expect(scene.lightingProfile?.colorTemperature).toBe(5600);
    expect(scene.location?.name).toBe('Downtown');
    expect(scene.anchorPoints).toHaveLength(1);
    expect(scene.status).toBe('ready');
    expect(scene.tenantId).toBe('tenant-1');
  });

  it('identifies panorama source types', () => {
    expect(new Scene({ sourceType: 'panorama_360' }).isPanorama).toBe(true);
    expect(new Scene({ sourceType: 'panorama_180' }).isPanorama).toBe(true);
    expect(new Scene({ sourceType: 'image' }).isPanorama).toBe(false);
    expect(new Scene({ sourceType: 'video' }).isPanorama).toBe(false);
  });

  it('reports hasViewpoints based on the viewpoints array', () => {
    expect(new Scene().hasViewpoints).toBe(false);
    expect(
      new Scene({
        viewpoints: [{ id: 'vp', name: 'v', pan: 0, tilt: 0, fov: 90 }],
      }).hasViewpoints,
    ).toBe(true);
  });

  it('is ready only when status is ready AND a source asset exists', () => {
    expect(
      new Scene({ status: 'ready', sourceAssetId: 'asset-1' }).isReady,
    ).toBe(true);
    expect(new Scene({ status: 'ready' }).isReady).toBe(false);
    expect(
      new Scene({ status: 'pending', sourceAssetId: 'asset-1' }).isReady,
    ).toBe(false);
  });
});

describe('VideoShotCharacter model logic', () => {
  it('requires shot and character IDs and applies optional fields', () => {
    const link = new VideoShotCharacter({
      videoShotId: 'shot-1',
      characterId: 'char-1',
      role: 'secondary',
      position: 2,
      tenantId: 'tenant-1',
    });
    expect(link.videoShotId).toBe('shot-1');
    expect(link.characterId).toBe('char-1');
    expect(link.role).toBe('secondary');
    expect(link.position).toBe(2);
    expect(link.tenantId).toBe('tenant-1');
  });

  it('defaults role to primary and position to 0', () => {
    const link = new VideoShotCharacter({
      videoShotId: 'shot-1',
      characterId: 'char-1',
    });
    expect(link.role).toBe('primary');
    expect(link.position).toBe(0);
    expect(link.tenantId).toBeNull();
  });
});
