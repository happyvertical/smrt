/**
 * Tests for AnalyticsReport model and collection
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AnalyticsReportCollection } from '../collections/AnalyticsReportCollection.js';
import { AnalyticsReport } from '../models/AnalyticsReport.js';
import { ReportFrequency, ReportStatus } from '../types/index.js';
import {
  createTestDb,
  getAdapterDisplayName,
  getTestAdapter,
  isPostgresAvailable,
} from './helpers/index.js';

// Check postgres availability at module load (top-level await)
const pgAvailable = await isPostgresAvailable();
const skipTests = getTestAdapter() === 'postgres' && !pgAvailable;

describe('AnalyticsReport', () => {
  describe('constructor', () => {
    it('should create a report with default values', () => {
      const report = new AnalyticsReport();

      expect(report.name).toBe('');
      expect(report.status).toBe(ReportStatus.DRAFT);
      expect(report.frequency).toBe(ReportFrequency.ONCE);
      expect(report.dateRangeStart).toBe('7daysAgo');
      expect(report.dateRangeEnd).toBe('today');
    });

    it('should create a report with options', () => {
      const report = new AnalyticsReport({
        propertyId: 'prop-123',
        name: 'Weekly Traffic',
        frequency: ReportFrequency.WEEKLY,
        status: ReportStatus.SCHEDULED,
      });

      expect(report.propertyId).toBe('prop-123');
      expect(report.name).toBe('Weekly Traffic');
      expect(report.frequency).toBe(ReportFrequency.WEEKLY);
      expect(report.status).toBe(ReportStatus.SCHEDULED);
    });
  });

  describe('dimensions and metrics', () => {
    it('should get and set dimensions', () => {
      const report = new AnalyticsReport();

      report.setDimensions([{ name: 'country' }, { name: 'deviceCategory' }]);

      const dimensions = report.getDimensions();
      expect(dimensions).toHaveLength(2);
      expect(dimensions[0].name).toBe('country');
      expect(dimensions[1].name).toBe('deviceCategory');
    });

    it('should get and set metrics', () => {
      const report = new AnalyticsReport();

      report.setMetrics([
        { name: 'activeUsers' },
        { name: 'sessions' },
        { name: 'bounceRate' },
      ]);

      const metrics = report.getMetrics();
      expect(metrics).toHaveLength(3);
      expect(metrics[0].name).toBe('activeUsers');
    });

    it('should return empty array for invalid JSON', () => {
      const report = new AnalyticsReport();
      report.dimensions = 'invalid json';
      report.metrics = 'also invalid';

      expect(report.getDimensions()).toEqual([]);
      expect(report.getMetrics()).toEqual([]);
    });
  });

  describe('result data', () => {
    it('should get and set result data', () => {
      const report = new AnalyticsReport();
      const data = {
        rows: [
          { country: 'US', activeUsers: 1000 },
          { country: 'UK', activeUsers: 500 },
        ],
      };

      report.setResultData(data);

      const result = report.getResultData();
      expect(result).toEqual(data);
    });

    it('should return null for empty result data', () => {
      const report = new AnalyticsReport();
      expect(report.getResultData()).toBeNull();
    });
  });

  describe('status management', () => {
    it('should mark report as running', () => {
      const report = new AnalyticsReport();
      report.lastError = 'Previous error';

      report.markRunning();

      expect(report.status).toBe(ReportStatus.RUNNING);
      expect(report.lastError).toBe('');
    });

    it('should mark report as completed', () => {
      const report = new AnalyticsReport({
        frequency: ReportFrequency.DAILY,
      });

      report.markCompleted(100);

      expect(report.status).toBe(ReportStatus.COMPLETED);
      expect(report.rowCount).toBe(100);
      expect(report.lastRunAt).toBeInstanceOf(Date);
      expect(report.nextRunAt).toBeInstanceOf(Date);
    });

    it('should mark report as failed', () => {
      const report = new AnalyticsReport();

      report.markFailed('API error');

      expect(report.status).toBe(ReportStatus.FAILED);
      expect(report.lastError).toBe('API error');
      expect(report.lastRunAt).toBeInstanceOf(Date);
    });
  });

  describe('scheduling', () => {
    it('should calculate next run for daily frequency', () => {
      const report = new AnalyticsReport({
        frequency: ReportFrequency.DAILY,
      });

      report.calculateNextRun();

      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      expect(report.nextRunAt?.getDate()).toBe(tomorrow.getDate());
    });

    it('should calculate next run for weekly frequency', () => {
      const report = new AnalyticsReport({
        frequency: ReportFrequency.WEEKLY,
      });

      report.calculateNextRun();

      const nextWeek = new Date();
      nextWeek.setDate(nextWeek.getDate() + 7);
      expect(report.nextRunAt?.getDate()).toBe(nextWeek.getDate());
    });

    it('should set null next run for one-time reports', () => {
      const report = new AnalyticsReport({
        frequency: ReportFrequency.ONCE,
      });

      report.calculateNextRun();

      expect(report.nextRunAt).toBeNull();
    });

    it('should check if report is due', () => {
      const report = new AnalyticsReport({
        frequency: ReportFrequency.DAILY,
        status: ReportStatus.SCHEDULED,
      });

      // Set nextRunAt to past
      report.nextRunAt = new Date(Date.now() - 1000);

      expect(report.isDue()).toBe(true);
    });
  });
});

describe.skipIf(skipTests)(
  `AnalyticsReportCollection [${getAdapterDisplayName()}]`,
  () => {
    let collection: AnalyticsReportCollection;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const testDb = await createTestDb();
      cleanup = testDb.cleanup;
      collection = await AnalyticsReportCollection.create({
        persistence: testDb.config,
      });
    });

    afterEach(async () => {
      await cleanup();
    });

    it('should create and list reports', async () => {
      const report = await collection.create({
        propertyId: 'prop-123',
        name: 'Test Report',
      });
      await report.save();

      const reports = await collection.list({});
      expect(reports).toHaveLength(1);
      expect(reports[0].name).toBe('Test Report');
    });

    it('should find reports by property', async () => {
      const report1 = await collection.create({
        propertyId: 'prop-1',
        name: 'Report 1',
      });
      await report1.save();

      const report2 = await collection.create({
        propertyId: 'prop-2',
        name: 'Report 2',
      });
      await report2.save();

      const prop1Reports = await collection.findByProperty('prop-1');
      expect(prop1Reports).toHaveLength(1);
      expect(prop1Reports[0].name).toBe('Report 1');
    });

    it('should find reports by status', async () => {
      const draft = await collection.create({
        propertyId: 'prop-status',
        name: 'Draft Report',
        status: ReportStatus.DRAFT,
      });
      await draft.save();

      const scheduled = await collection.create({
        propertyId: 'prop-status',
        name: 'Scheduled Report',
        status: ReportStatus.SCHEDULED,
      });
      await scheduled.save();

      const drafts = await collection.findDrafts();
      expect(drafts).toHaveLength(1);
      expect(drafts[0].name).toBe('Draft Report');

      const scheduledReports = await collection.findScheduled();
      expect(scheduledReports).toHaveLength(1);
      expect(scheduledReports[0].name).toBe('Scheduled Report');
    });

    it('should find recurring reports', async () => {
      const oneTime = await collection.create({
        propertyId: 'prop-recurring',
        name: 'One Time',
        frequency: ReportFrequency.ONCE,
      });
      await oneTime.save();

      const daily = await collection.create({
        propertyId: 'prop-recurring',
        name: 'Daily Report',
        frequency: ReportFrequency.DAILY,
      });
      await daily.save();

      const recurring = await collection.findRecurring();
      expect(recurring).toHaveLength(1);
      expect(recurring[0].name).toBe('Daily Report');
    });
  },
);
