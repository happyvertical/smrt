import { describe, expect, it } from 'vitest';
import { VoiceOutput, VoiceProfile, VoiceSample } from '../index.js';

describe('@happyvertical/smrt-voice exports', () => {
  it('VoiceProfile is a class', () => {
    expect(typeof VoiceProfile).toBe('function');
    expect(VoiceProfile.name).toBe('VoiceProfile');
  });

  it('VoiceSample is a class', () => {
    expect(typeof VoiceSample).toBe('function');
    expect(VoiceSample.name).toBe('VoiceSample');
  });

  it('VoiceOutput is a class', () => {
    expect(typeof VoiceOutput).toBe('function');
    expect(VoiceOutput.name).toBe('VoiceOutput');
  });
});
