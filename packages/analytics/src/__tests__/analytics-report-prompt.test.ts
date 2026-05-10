/**
 * Tests for `AnalyticsReport.analyzeResults()` and
 * `AnalyticsReport.hasPositiveTrends()` — verifies the smrt-prompts
 * integration: prompt resolution, variable substitution, and that
 * internal/PII-adjacent fields (`propertyId`, `lastError`, raw filter
 * expressions) are NOT passed to the AI provider.
 *
 * The AI client is stubbed via a `getAiClient()` override so no network
 * calls are made.
 */

import { clearPromptCache } from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsReport } from '../models/AnalyticsReport.js';
import {
  smrtAnalyticsAnalyzeResultsPrompt,
  smrtAnalyticsHasPositiveTrendsPrompt,
} from '../prompts.js';
import { ReportStatus } from '../types/index.js';

function makeReport(opts: { aiResponse?: string } = {}) {
  const aiResponse = opts.aiResponse ?? 'Findings, trends, and recommendations';
  const aiMessageMock = vi.fn().mockResolvedValue(`${aiResponse}  `);

  const report = new AnalyticsReport({
    name: 'Weekly Traffic Report',
    description: 'Weekly traffic dashboard',
    dimensions: JSON.stringify([
      { name: 'country' },
      { name: 'deviceCategory' },
    ]),
    metrics: JSON.stringify([{ name: 'activeUsers' }, { name: 'sessions' }]),
    dateRangeStart: '7daysAgo',
    dateRangeEnd: 'today',
    rowCount: 42,
    status: ReportStatus.COMPLETED,
    resultData: JSON.stringify({
      rows: [
        { country: 'US', activeUsers: 1234 },
        { country: 'CA', activeUsers: 567 },
      ],
    }),
    // Internal/PII-adjacent fields that should NOT reach the AI provider:
    propertyId: 'analytics-property-uuid-1234',
    dimensionFilter: JSON.stringify({ field: 'userPseudoId', value: 'PII-99' }),
    metricFilter: JSON.stringify({ secret: 'do-not-leak' }),
    lastError: 'INTERNAL: token expired for tenant tenant-secret-9999',
  });
  (report as any).getAiClient = async () => ({
    message: aiMessageMock,
  });
  return { report, aiMessageMock };
}

describe('AnalyticsReport.analyzeResults()', () => {
  beforeEach(() => {
    clearPromptCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the registered prompt key', () => {
    expect(smrtAnalyticsAnalyzeResultsPrompt.key).toBe(
      'smrtAnalytics.report.analyzeResults',
    );
  });

  it('resolves the registered analyzeResults prompt and returns trimmed analysis', async () => {
    const { report, aiMessageMock } = makeReport();

    const result = await report.analyzeResults();

    expect(result.action).toBe('analyzeResults');
    expect(result.analysis).toBe('Findings, trends, and recommendations');
    // After migration, insights mirrors analysis (the registered template
    // already structures the response into findings/trends/recommendations).
    expect(result.insights).toBe(result.analysis);
    expect(aiMessageMock).toHaveBeenCalledTimes(1);

    const [text] = aiMessageMock.mock.calls[0];
    expect(text).toContain('Weekly Traffic Report');
    expect(text).toContain('country');
    expect(text).toContain('activeUsers');
    expect(text).toContain('7daysAgo');
    expect(text).toContain('today');
    expect(text).toContain('42');
  });

  it('does NOT pass internal/PII-adjacent fields to the AI provider', async () => {
    const { report, aiMessageMock } = makeReport();

    await report.analyzeResults();

    const [text] = aiMessageMock.mock.calls[0];
    // Foreign-key reference and tenant-internal payloads must not leak.
    expect(text).not.toContain('analytics-property-uuid-1234');
    expect(text).not.toContain('userPseudoId');
    expect(text).not.toContain('PII-99');
    expect(text).not.toContain('tenant-secret-9999');
    // Internal error strings must not leak (may contain auth tokens).
    expect(text).not.toContain('INTERNAL: token expired');
  });

  it('FORWARDS `resultData` rows verbatim — caller must de-PII before persisting', async () => {
    // This test pins the contract that `resultData` is passed through to the
    // AI provider as opaque aggregate. If a caller persists raw GA4 row-level
    // data containing PII (e.g. a `userPseudoId` dimension), it WILL reach
    // the AI provider. The prompts.ts and CLAUDE.md tenancy notes both
    // document this; the assertion below ensures the contract is intentional
    // rather than hidden behind a sanitization step nobody implemented.
    const aiMessageMock = vi.fn().mockResolvedValue('analysis');
    const report = new AnalyticsReport({
      name: 'PII test',
      dimensions: '[]',
      metrics: '[]',
      dateRangeStart: '7daysAgo',
      dateRangeEnd: 'today',
      rowCount: 1,
      status: ReportStatus.COMPLETED,
      // Caller-persisted PII inside resultData rows.
      resultData: JSON.stringify({
        rows: [
          {
            userPseudoId: 'pii-pseudo-id-leak-9999',
            activeUsers: 1,
          },
        ],
      }),
    });
    (report as any).getAiClient = async () => ({
      message: aiMessageMock,
    });

    await report.analyzeResults();

    const [text] = aiMessageMock.mock.calls[0];
    // Both the field name and its value land in the prompt — that is the
    // documented contract, NOT a regression to be silently fixed.
    expect(text).toContain('userPseudoId');
    expect(text).toContain('pii-pseudo-id-leak-9999');
  });

  it('passes empty AI options for the default registered prompt (no ai config)', async () => {
    const { report, aiMessageMock } = makeReport();

    await report.analyzeResults();

    const [, options] = aiMessageMock.mock.calls[0];
    expect(options).toEqual({});
  });
});

describe('AnalyticsReport.hasPositiveTrends()', () => {
  beforeEach(() => {
    clearPromptCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses the registered prompt key', () => {
    expect(smrtAnalyticsHasPositiveTrendsPrompt.key).toBe(
      'smrtAnalytics.report.hasPositiveTrends',
    );
  });

  it('returns true when the AI response begins with "yes"', async () => {
    const { report, aiMessageMock } = makeReport({
      aiResponse: 'Yes — engagement and conversion are both up week over week.',
    });

    const result = await report.hasPositiveTrends();

    expect(result).toBe(true);
    expect(aiMessageMock).toHaveBeenCalledTimes(1);
  });

  it('returns false when the AI response is "no"', async () => {
    const { report, aiMessageMock } = makeReport({
      aiResponse: 'No, several metrics are trending downward.',
    });

    const result = await report.hasPositiveTrends();

    expect(result).toBe(false);
    expect(aiMessageMock).toHaveBeenCalledTimes(1);
  });

  it('substitutes metrics and result data into the registered prompt', async () => {
    const { report, aiMessageMock } = makeReport({ aiResponse: 'Yes' });

    await report.hasPositiveTrends();

    const [text] = aiMessageMock.mock.calls[0];
    expect(text).toContain('activeUsers');
    expect(text).toContain('sessions');
    // The aggregate result rows pass through.
    expect(text).toContain('1234');
  });

  it('does NOT pass internal/PII-adjacent fields to the AI provider', async () => {
    const { report, aiMessageMock } = makeReport({ aiResponse: 'yes' });

    await report.hasPositiveTrends();

    const [text] = aiMessageMock.mock.calls[0];
    expect(text).not.toContain('analytics-property-uuid-1234');
    expect(text).not.toContain('userPseudoId');
    expect(text).not.toContain('PII-99');
    expect(text).not.toContain('tenant-secret-9999');
    expect(text).not.toContain('INTERNAL: token expired');
    // The descriptive report name is not in this leaner classifier prompt.
    expect(text).not.toContain('Weekly Traffic Report');
  });
});
