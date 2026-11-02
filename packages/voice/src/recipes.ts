/**
 * Declared recipes for smrt-voice (#4409, #4437): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { VoiceOutput } from './voice-output.js';
import { VoiceProfile } from './voice-profile.js';
import { VoiceSample } from './voice-sample.js';

/** Voice: the voices your app can speak in, and the speech it has generated. */
export class VoiceProfilesRecipe extends SmrtRecipe {
  static id = 'voice.profiles';
  static help = './profiles.recipe.md';
  static label = 'Voice';
  static summary =
    'Set up the voices your app can speak in, from a description or a recorded clip, and keep the speech it generates.';
  static synonyms = [
    'voices',
    'text to speech',
    'read aloud',
    'voice cloning',
    'narration',
    'speech',
  ];
  static section = {
    id: 'publish',
    label: 'Publish',
    icon: 'fileText',
    description: 'What you write, record and put out.',
  };
  static models = [VoiceProfile, VoiceSample, VoiceOutput];
  static nav = [
    {
      label: 'Voices',
      model: VoiceProfile,
      icon: 'users',
      description:
        'The voices your app can speak in, described in words or copied from a clip.',
      noun: 'voice',
    },
    {
      label: 'Samples',
      model: VoiceSample,
      icon: 'folder',
      description: 'The recorded clips a voice is copied from.',
      noun: 'sample',
    },
    {
      label: 'Generated speech',
      model: VoiceOutput,
      icon: 'fileText',
      description: 'Every recording the app has read aloud, with its text.',
      noun: 'recording',
    },
  ];
  static options = {
    VoiceProfile: {
      fields: {
        name: { order: 1 },
        description: { order: 2 },
        language: { order: 3 },
        gender: { order: 4 },
        designPrompt: { label: 'Describe the voice', order: 5 },
        sampleAssetId: { label: 'Sample clip', order: 6 },
        status: { order: 7 },
        defaultSpeed: { label: 'Speed', visibility: 'advanced' },
        defaultPitch: { label: 'Pitch', visibility: 'advanced' },
        provider: { label: 'Speech service', visibility: 'advanced' },
        errorMessage: { label: 'What went wrong', visibility: 'advanced' },
        voiceData: { visibility: 'hidden' },
        tenantId: { visibility: 'hidden' },
      },
    },
    VoiceSample: {
      fields: {
        voiceProfileId: { label: 'Voice', order: 1 },
        assetId: { label: 'Audio file', order: 2 },
        duration: { label: 'Length in seconds', order: 3 },
        transcription: { label: 'What is said', order: 4 },
        quality: { order: 5 },
        isPrimary: { label: 'Main clip', order: 6 },
        sampleRate: { visibility: 'advanced' },
        channels: { visibility: 'advanced' },
        format: { visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
      },
    },
    VoiceOutput: {
      fields: {
        name: { label: 'Title', order: 1 },
        sourceText: { label: 'Text', order: 2 },
        voiceProfileId: { label: 'Voice', order: 3 },
        audioAssetId: { label: 'Audio file', order: 4 },
        duration: { label: 'Length in seconds', order: 5 },
        description: { visibility: 'advanced' },
        author: { visibility: 'advanced' },
        publish_date: { label: 'Date', visibility: 'advanced' },
        language: { visibility: 'advanced' },
        wordTimings: { visibility: 'hidden' },
        audioMetadata: { visibility: 'hidden' },
        type: { visibility: 'hidden' },
        variant: { visibility: 'hidden' },
        fileKey: { visibility: 'hidden' },
        body: { visibility: 'hidden' },
        bodyFormat: { visibility: 'hidden' },
        url: { visibility: 'hidden' },
        source: { visibility: 'hidden' },
        original_url: { visibility: 'hidden' },
        tags: { visibility: 'hidden' },
        category: { visibility: 'hidden' },
        status: { visibility: 'hidden' },
        state: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
        thumbnailAssetId: { visibility: 'hidden' },
        tenantId: { visibility: 'hidden' },
      },
    },
  } as const;
}
