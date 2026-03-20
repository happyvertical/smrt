import { describe, expect, it } from 'vitest';
import { evaluateContentPublishReadiness } from './publish-readiness';

describe('evaluateContentPublishReadiness', () => {
  it('returns null when the draft is not being published', () => {
    expect(
      evaluateContentPublishReadiness({
        status: 'draft',
        contentId: 'content-1',
        reviewProfileKey: 'publication',
        reviewProfiles: [],
        enforce: true,
      }),
    ).toBeNull();
  });

  it('blocks unsaved publication when enforcement is enabled', () => {
    expect(
      evaluateContentPublishReadiness({
        status: 'published',
        contentId: null,
        reviewProfileKey: 'publication',
        reviewProfiles: [],
        enforce: true,
      }),
    ).toMatchObject({
      level: 'blocked',
      disableSave: true,
    });
  });

  it('warns when blocking requirements are not satisfied', () => {
    expect(
      evaluateContentPublishReadiness({
        status: 'published',
        contentId: 'content-2',
        reviewProfileKey: 'publication',
        reviewProfiles: [
          {
            profileKey: 'publication',
            ready: false,
            complete: false,
            requirements: [
              {
                label: 'Safety Review',
                blocking: true,
                missing: true,
                stale: false,
                satisfied: false,
                latestStatus: null,
              },
            ],
          },
        ],
        enforce: false,
      }),
    ).toMatchObject({
      level: 'advisory',
      disableSave: false,
      details: ['Safety Review: not run yet'],
    });
  });

  it('treats stale blocking reviews as requiring a rerun', () => {
    expect(
      evaluateContentPublishReadiness({
        status: 'published',
        contentId: 'content-2',
        reviewProfileKey: 'publication',
        reviewProfiles: [
          {
            profileKey: 'publication',
            ready: false,
            complete: false,
            requirements: [
              {
                label: 'Facts Review',
                blocking: true,
                missing: false,
                stale: true,
                satisfied: false,
                latestStatus: 'passed',
              },
            ],
          },
        ],
        enforce: true,
      }),
    ).toMatchObject({
      level: 'blocked',
      disableSave: true,
      details: ['Facts Review: stale, rerun required'],
    });
  });

  it('returns ready when the publication profile is fully satisfied', () => {
    expect(
      evaluateContentPublishReadiness({
        status: 'published',
        contentId: 'content-3',
        reviewProfileKey: 'publication',
        reviewProfiles: [
          {
            profileKey: 'publication',
            ready: true,
            complete: true,
            requirements: [
              {
                label: 'Safety Review',
                blocking: true,
                missing: false,
                stale: false,
                satisfied: true,
                latestStatus: 'passed',
              },
            ],
          },
        ],
        enforce: true,
      }),
    ).toMatchObject({
      level: 'ready',
      disableSave: false,
    });
  });
});
