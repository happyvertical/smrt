/**
 * Declared recipes for smrt-video (#4409, #4437): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Character } from './character.js';
import { Scene } from './scene.js';
import { VideoComposition } from './video-composition.js';
import { VideoSequence } from './video-sequence.js';
import { VideoShot } from './video-shot.js';

/**
 * Video: plan a video from the whole piece down to each shot, with the
 * characters and scenes that appear in it.
 *
 * Left out on purpose: Performer (a face-likeness record behind a character;
 * technical, and Character already carries what a person needs), VideoWorkflow
 * (a render template), CompositeJob (a render job) and the owned-asset joins
 * (closed to the generated surface).
 */
export class VideoLibraryRecipe extends SmrtRecipe {
  static id = 'video.library';
  static help = './library.recipe.md';
  static label = 'Video';
  static summary =
    'Plan each video as sequences and shots, with the characters and scenes that appear in it.';
  static synonyms = [
    'videos',
    'video production',
    'video scripts',
    'shots',
    'storyboard',
    'characters and scenes',
  ];
  static section = {
    id: 'publish',
    label: 'Publish',
    icon: 'fileText',
    description: 'What you write, record and put out.',
  };
  static models = [
    VideoComposition,
    VideoSequence,
    VideoShot,
    Character,
    Scene,
  ];
  static nav = [
    {
      label: 'Videos',
      model: VideoComposition,
      icon: 'layers',
      description: 'Each finished video you are putting together.',
      noun: 'video',
    },
    {
      label: 'Sequences',
      model: VideoSequence,
      icon: 'folder',
      description: 'The parts of a video, in the order they play.',
      noun: 'sequence',
    },
    {
      label: 'Shots',
      model: VideoShot,
      icon: 'fileText',
      description: 'Each clip in a sequence, with the words spoken in it.',
      noun: 'shot',
    },
    {
      label: 'Characters',
      model: Character,
      icon: 'users',
      description: 'The on-screen presenters, with their look and voice.',
      noun: 'character',
    },
    {
      label: 'Scenes',
      model: Scene,
      icon: 'home',
      description: 'The backgrounds your characters appear in front of.',
      noun: 'scene',
    },
  ];
  static options = {
    VideoComposition: {
      fields: {
        name: { order: 1 },
        description: { order: 2 },
        fps: { label: 'Frames per second', order: 3 },
        width: { order: 4 },
        height: { order: 5 },
        durationInFrames: { label: 'Length in frames', order: 6 },
        renderStatus: { label: 'Render status', order: 7 },
        renderProgress: { label: 'Render progress', order: 8 },
        title: { visibility: 'advanced' },
        body: { label: 'Notes', visibility: 'advanced' },
        author: { visibility: 'advanced' },
        publish_date: { label: 'Publish date', visibility: 'advanced' },
        url: { label: 'Web address', visibility: 'advanced' },
        language: { visibility: 'advanced' },
        tags: { visibility: 'advanced' },
        category: { visibility: 'advanced' },
        status: { label: 'Publishing status', visibility: 'advanced' },
        thumbnailAssetId: { label: 'Thumbnail', visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        type: { visibility: 'hidden' },
        variant: { visibility: 'hidden' },
        fileKey: { visibility: 'hidden' },
        bodyFormat: { visibility: 'hidden' },
        source: { visibility: 'hidden' },
        original_url: { visibility: 'hidden' },
        state: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    VideoSequence: {
      fields: {
        name: { order: 1 },
        compositionId: { label: 'Video', order: 2 },
        position: { label: 'Order', order: 3 },
        description: { order: 4 },
        durationInFrames: { label: 'Length in frames', order: 5 },
        transitionType: { label: 'Transition to next', order: 6 },
        transitionDurationFrames: {
          label: 'Transition length in frames',
          visibility: 'advanced',
        },
        title: { visibility: 'advanced' },
        body: { label: 'Notes', visibility: 'advanced' },
        author: { visibility: 'advanced' },
        publish_date: { label: 'Publish date', visibility: 'advanced' },
        url: { label: 'Web address', visibility: 'advanced' },
        language: { visibility: 'advanced' },
        tags: { visibility: 'advanced' },
        category: { visibility: 'advanced' },
        status: { label: 'Publishing status', visibility: 'advanced' },
        thumbnailAssetId: { label: 'Thumbnail', visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        type: { visibility: 'hidden' },
        variant: { visibility: 'hidden' },
        fileKey: { visibility: 'hidden' },
        bodyFormat: { visibility: 'hidden' },
        source: { visibility: 'hidden' },
        original_url: { visibility: 'hidden' },
        state: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    VideoShot: {
      fields: {
        name: { order: 1 },
        sequenceId: { label: 'Sequence', order: 2 },
        position: { label: 'Order', order: 3 },
        scriptText: { label: 'Script', order: 4 },
        sceneId: { label: 'Scene', order: 5 },
        targetDuration: { label: 'Target length in seconds', order: 6 },
        durationInFrames: { label: 'Length in frames', order: 7 },
        shotStatus: { label: 'Status', order: 8 },
        description: { visibility: 'advanced' },
        progress: { visibility: 'advanced' },
        statusMessage: { label: 'Status message', visibility: 'advanced' },
        errorMessage: { label: 'Error message', visibility: 'advanced' },
        scriptWordCount: { label: 'Words in script', visibility: 'advanced' },
        trimBeforeFrames: {
          label: 'Trim from start in frames',
          visibility: 'advanced',
        },
        trimAfterFrames: {
          label: 'Trim from end in frames',
          visibility: 'advanced',
        },
        videoMetadata: { visibility: 'hidden' },
        title: { visibility: 'advanced' },
        body: { label: 'Notes', visibility: 'advanced' },
        author: { visibility: 'advanced' },
        publish_date: { label: 'Publish date', visibility: 'advanced' },
        url: { label: 'Web address', visibility: 'advanced' },
        language: { visibility: 'advanced' },
        tags: { visibility: 'advanced' },
        category: { visibility: 'advanced' },
        status: { label: 'Publishing status', visibility: 'advanced' },
        thumbnailAssetId: { label: 'Thumbnail', visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        type: { visibility: 'hidden' },
        variant: { visibility: 'hidden' },
        fileKey: { visibility: 'hidden' },
        bodyFormat: { visibility: 'hidden' },
        source: { visibility: 'hidden' },
        original_url: { visibility: 'hidden' },
        state: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    Character: {
      fields: {
        name: { order: 1 },
        description: { order: 2 },
        imageAssetId: { label: 'Picture', order: 3 },
        voiceProfileId: { label: 'Voice', order: 4 },
        defaultSceneId: { label: 'Usual scene', order: 5 },
        status: { order: 6 },
        performerId: { label: 'Performer', visibility: 'advanced' },
        baseMotionAssetId: {
          label: 'Base motion video',
          visibility: 'advanced',
        },
        profileId: { label: 'Profile', visibility: 'advanced' },
        brandingKit: { visibility: 'hidden' },
        sceneConfigs: { visibility: 'hidden' },
        tenantId: { visibility: 'hidden' },
      },
    },
    Scene: {
      fields: {
        name: { order: 1 },
        description: { order: 2 },
        sourceType: { label: 'Kind of background', order: 3 },
        sourceAssetId: { label: 'Background picture or video', order: 4 },
        status: { order: 5 },
        projection: { visibility: 'advanced' },
        location: { visibility: 'hidden' },
        viewpoints: { visibility: 'hidden' },
        lightingProfile: { visibility: 'hidden' },
        anchorPoints: { visibility: 'hidden' },
        tenantId: { visibility: 'hidden' },
      },
    },
  } as const;
}
