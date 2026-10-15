import { describe, expect, it } from 'vitest';
import {
  AuthoredCourse,
  ExternalCourse,
  LessonAsset,
  Reading,
  Video,
  Worksheet,
} from '../index.js';

describe('education catalog models', () => {
  it('keeps behavior-specific course and lesson kinds in their STI families', () => {
    expect(new ExternalCourse()).toBeInstanceOf(ExternalCourse);
    expect(new AuthoredCourse()).toBeInstanceOf(AuthoredCourse);
    expect(new Reading()).toBeInstanceOf(Reading);
    expect(new Video()).toBeInstanceOf(Video);
    expect(new Worksheet().completionRule).toBe('submit');
  });

  it('uses the noun-specific lesson asset join rather than lesson asset-id fields', () => {
    expect(new LessonAsset().relationship).toBe('attachment');
    expect('printableAssetId' in new Worksheet()).toBe(false);
    expect('videoAssetId' in new Video()).toBe(false);
  });
});
