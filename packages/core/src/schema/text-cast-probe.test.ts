import { describe, expect, it } from 'vitest';
import {
  isEmptyTextOnlyProbe,
  maskSampleValue,
  renderJsonbColumnConversion,
  renderTimestamptzColumnConversion,
} from './text-cast-probe.js';

describe('empty text as NULL conversions (#3226)', () => {
  it('casts through a NULL-for-empty-text expression only under the opt-in', () => {
    expect(
      renderTimestamptzColumnConversion('contents', 'published_at'),
    ).toEqual([
      'ALTER TABLE "contents" ALTER COLUMN "published_at" TYPE timestamptz USING "published_at"::timestamptz',
    ]);
    expect(
      renderTimestamptzColumnConversion('contents', 'published_at', {
        emptyTextAsNull: true,
      }),
    ).toEqual([
      `ALTER TABLE "contents" ALTER COLUMN "published_at" TYPE timestamptz USING (CASE WHEN btrim("published_at"::text, E' \\t\\n\\r') = '' THEN NULL ELSE "published_at"::text END)::timestamptz`,
    ]);
    expect(
      renderJsonbColumnConversion('contents', 'payload', {
        emptyTextAsNull: true,
      }).at(-1),
    ).toContain('THEN NULL ELSE "payload"::text END)::jsonb');
  });

  it('recognizes a probe whose only obstacle is empty text', () => {
    expect(
      isEmptyTextOnlyProbe({
        status: 'dirty',
        count: 3,
        emptyCount: 3,
        sample: '',
      }),
    ).toBe(true);
    expect(
      isEmptyTextOnlyProbe({ status: 'dirty', count: 3, emptyCount: 2 }),
    ).toBe(false);
    expect(
      isEmptyTextOnlyProbe({
        status: 'dirty',
        count: 3,
        emptyCount: 3,
        reason: 'duplicate_keys',
      }),
    ).toBe(false);
    expect(isEmptyTextOnlyProbe({ status: 'clean' })).toBe(false);
    expect(isEmptyTextOnlyProbe(undefined)).toBe(false);
  });

  it('shows an empty sample as (empty)', () => {
    expect(maskSampleValue('')).toBe('(empty)');
  });
});
