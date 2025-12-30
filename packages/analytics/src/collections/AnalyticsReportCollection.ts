/**
 * AnalyticsReportCollection - Collection manager for AnalyticsReport objects
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { AnalyticsReport } from '../models/AnalyticsReport.js';
import { ReportFrequency, ReportStatus } from '../types/index.js';

export class AnalyticsReportCollection extends SmrtCollection<AnalyticsReport> {
  static readonly _itemClass = AnalyticsReport;

  /**
   * Find reports by property
   *
   * @param propertyId - Parent property ID
   * @returns Array of reports
   */
  async findByProperty(propertyId: string): Promise<AnalyticsReport[]> {
    return await this.list({
      where: { propertyId },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find reports by status
   *
   * @param status - Report status
   * @returns Array of matching reports
   */
  async findByStatus(status: ReportStatus): Promise<AnalyticsReport[]> {
    return await this.list({
      where: { status },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find all draft reports
   */
  async findDrafts(): Promise<AnalyticsReport[]> {
    return await this.findByStatus(ReportStatus.DRAFT);
  }

  /**
   * Find all scheduled reports
   */
  async findScheduled(): Promise<AnalyticsReport[]> {
    return await this.findByStatus(ReportStatus.SCHEDULED);
  }

  /**
   * Find all completed reports
   */
  async findCompleted(): Promise<AnalyticsReport[]> {
    return await this.findByStatus(ReportStatus.COMPLETED);
  }

  /**
   * Find all failed reports
   */
  async findFailed(): Promise<AnalyticsReport[]> {
    return await this.findByStatus(ReportStatus.FAILED);
  }

  /**
   * Find reports by frequency
   *
   * @param frequency - Report frequency
   * @returns Array of matching reports
   */
  async findByFrequency(
    frequency: ReportFrequency,
  ): Promise<AnalyticsReport[]> {
    return await this.list({
      where: { frequency },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find all recurring reports (not one-time)
   */
  async findRecurring(): Promise<AnalyticsReport[]> {
    const all = await this.list({ orderBy: 'name ASC' });
    return all.filter((r) => r.frequency !== ReportFrequency.ONCE);
  }

  /**
   * Find reports due to run
   *
   * @returns Array of reports that are due
   */
  async findDue(): Promise<AnalyticsReport[]> {
    const all = await this.list({
      where: { status: ReportStatus.SCHEDULED },
    });
    return all.filter((r) => r.isDue());
  }

  /**
   * Find reports for a property by status
   *
   * @param propertyId - Parent property ID
   * @param status - Report status
   * @returns Array of matching reports
   */
  async findByPropertyAndStatus(
    propertyId: string,
    status: ReportStatus,
  ): Promise<AnalyticsReport[]> {
    return await this.list({
      where: { propertyId, status },
      orderBy: 'name ASC',
    });
  }

  /**
   * Find recently run reports
   *
   * @param hoursAgo - Hours since last run
   * @returns Array of recently run reports
   */
  async findRecentlyRun(hoursAgo: number = 24): Promise<AnalyticsReport[]> {
    const cutoff = new Date();
    cutoff.setHours(cutoff.getHours() - hoursAgo);

    const all = await this.list({ orderBy: 'lastRunAt DESC' });
    return all.filter((r) => r.lastRunAt && r.lastRunAt >= cutoff);
  }
}
