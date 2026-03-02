import { describe, expect, it } from 'vitest';
import type {
  SummaryArticleImage,
  SummaryArticleOptions,
  SummaryArticleResult,
} from './summary-article.js';

describe('SummaryArticleResult type', () => {
  it('should accept a minimal result', () => {
    const result: SummaryArticleResult = {
      title: 'Weekly Weather Summary',
      summary: "A brief overview of this week's weather.",
      body: 'Full article body here...',
      dateRange: { start: '2025-01-01', end: '2025-01-07' },
    };
    expect(result.title).toBe('Weekly Weather Summary');
    expect(result.images).toBeUndefined();
    expect(result.scope).toBeUndefined();
    expect(result.stats).toBeUndefined();
  });

  it('should accept a full result with all optional fields', () => {
    const result: SummaryArticleResult = {
      title: 'Council Meeting Recap',
      summary: "Key decisions from this week's council meetings.",
      body: 'Full article body...',
      dateRange: { start: '2025-01-01', end: '2025-01-07' },
      images: [
        {
          url: 'https://example.com/image.jpg',
          alt: 'Council chamber',
          caption: 'The council chamber',
        },
        { url: 'https://example.com/image2.jpg' },
      ],
      scope: {
        councilName: 'Bentley',
        councilId: '123',
      },
      stats: { meetingsFound: 3, recapsAvailable: 2 },
    };
    expect(result.images).toHaveLength(2);
    expect(result.scope?.councilName).toBe('Bentley');
    expect(result.stats?.meetingsFound).toBe(3);
  });

  it('should accept SummaryArticleOptions with minimal fields', () => {
    const options: SummaryArticleOptions = {
      startDate: new Date('2025-01-01'),
      endDate: '2025-01-07',
    };
    expect(options.startDate).toBeInstanceOf(Date);
    expect(options.filters).toBeUndefined();
  });

  it('should accept SummaryArticleOptions with all fields', () => {
    const options: SummaryArticleOptions = {
      startDate: '2025-01-01',
      endDate: '2025-01-07',
      filters: { councilId: '123', category: 'budget' },
      style: 'detailed',
      tone: 'newspaper',
    };
    expect(options.filters?.councilId).toBe('123');
    expect(options.style).toBe('detailed');
    expect(options.tone).toBe('newspaper');
  });

  it('should accept SummaryArticleImage with minimal fields', () => {
    const image: SummaryArticleImage = { url: 'https://example.com/photo.jpg' };
    expect(image.url).toBe('https://example.com/photo.jpg');
    expect(image.alt).toBeUndefined();
    expect(image.caption).toBeUndefined();
  });
});
