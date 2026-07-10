import { describe, expect, it } from 'vitest';
import {
  metadataFromSynthesizedSpeech,
  type SynthesizedSpeech,
  VoiceOutput,
  VoiceProfile,
  wordTimingsFromSpeech,
} from '../index.js';

describe('speech adapter contract mapping', () => {
  it('converts a voice profile into a provider-neutral speech voice', () => {
    const profile = new VoiceProfile({
      name: 'Anchor',
      language: 'en-US',
      provider: 'qwen3-tts',
      defaultSpeed: 1.15,
      defaultPitch: 2,
      voiceData: {
        providerVoiceId: 'vivian',
        voicePrompt: 'encoded-prompt',
        stableKey: 'tenant-anchor',
      },
    });

    const voice = profile.toSpeechVoice();

    expect(voice).toMatchObject({
      name: 'Anchor',
      language: 'en-US',
      speakerId: 'vivian',
      prompt: 'encoded-prompt',
      metadata: {
        provider: 'qwen3-tts',
        stableKey: 'tenant-anchor',
        defaultSpeed: 1.15,
        defaultPitch: 2,
      },
    });
  });

  it('normalizes speech word timings onto the persisted SMRT shape', () => {
    expect(
      wordTimingsFromSpeech([
        {
          word: 'hello',
          startSeconds: 0.1,
          endSeconds: 0.4,
          confidence: 0.93,
          speakerId: 'speaker-a',
        },
      ]),
    ).toEqual([
      {
        word: 'hello',
        start: 0.1,
        end: 0.4,
        confidence: 0.93,
        speakerId: 'speaker-a',
      },
    ]);
  });

  it('creates VoiceOutput metadata from synthesized speech without storing audio bytes', () => {
    const speech: SynthesizedSpeech = {
      audio: new Uint8Array([1, 2, 3, 4]).buffer,
      contentType: 'audio/wav',
      sampleRate: 24_000,
      channels: 1,
      durationSeconds: 0.8,
      provider: 'qwen3-tts',
      model: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
      words: [{ word: 'hello', startSeconds: 0, endSeconds: 0.5 }],
    };

    expect(metadataFromSynthesizedSpeech(speech)).toMatchObject({
      contentType: 'audio/wav',
      fileSize: 4,
      format: 'wav',
      sampleRate: 24_000,
      channels: 1,
      provider: 'qwen3-tts',
      model: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
    });

    const output = VoiceOutput.fromSynthesizedSpeech({
      speech,
      sourceText: 'hello',
      voiceProfileId: 'voice-1',
      audioAssetId: 'asset-1',
    });

    expect(output.duration).toBe(0.8);
    expect(output.wordTimings).toEqual([{ word: 'hello', start: 0, end: 0.5 }]);
    expect(output.audioMetadata).toMatchObject({
      contentType: 'audio/wav',
      fileSize: 4,
      provider: 'qwen3-tts',
    });
  });
});
