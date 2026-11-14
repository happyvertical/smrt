import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import { VoiceOutput } from '../voice-output.js';

for (const replaced of [false, true]) {
  describe(`speech output, app replacement=${replaced}`, () => {
    let restore: () => void;
    let expected: typeof VoiceOutput;
    beforeAll(async () => {
      restore = snapshotObjectRegistryState();
      expected = replaced
        ? (await import('./issue-4931-app.fixture.js')).VoiceOutput
        : VoiceOutput;
    });
    afterAll(() => restore());

    it('builds the exact effective class without initializing or saving it', () => {
      const output = VoiceOutput.fromSynthesizedSpeech({
        sourceText: 'hello',
        voiceProfileId: 'voice-1',
        audioAssetId: 'asset-1',
        speech: {
          audio: new Uint8Array([1, 2]).buffer,
          contentType: 'audio/wav',
          durationSeconds: 1,
          words: [{ word: 'hello', startSeconds: 0, endSeconds: 1 }],
        },
      });
      expect(output.constructor).toBe(expected);
      expect(output.duration).toBe(1);
      expect(output.wordTimings).toEqual([{ word: 'hello', start: 0, end: 1 }]);
      expect(output.audioMetadata.fileSize).toBe(2);
      expect(output.isPersisted).toBe(false);
    });
  });
}
