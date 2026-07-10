/**
 * SalesActivityCollection — collection manager for the SalesActivity trail.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { SalesActivity } from '../models/SalesActivity.js';
import type { SalesActivitySubjectKind } from '../types.js';

export class SalesActivityCollection extends SmrtCollection<SalesActivity> {
  static readonly _itemClass = SalesActivity;

  /**
   * Full trail for one subject, oldest first (chronological reading order).
   *
   * @param subjectKind - `'lead'` or `'opportunity'`
   * @param subjectId - Subject row id
   */
  async findBySubject(
    subjectKind: SalesActivitySubjectKind,
    subjectId: string,
  ): Promise<SalesActivity[]> {
    return await this.list({
      where: { subjectKind, subjectId },
      orderBy: 'created_at ASC',
    });
  }

  /**
   * Open next actions for one subject: activities with a due date
   * (`dueAt` set) that have not been completed (`completedAt` null),
   * soonest due first.
   *
   * @param subjectKind - `'lead'` or `'opportunity'`
   * @param subjectId - Subject row id
   */
  async findOpenTasks(
    subjectKind: SalesActivitySubjectKind,
    subjectId: string,
  ): Promise<SalesActivity[]> {
    return await this.list({
      where: {
        subjectKind,
        subjectId,
        'dueAt !=': null,
        completedAt: null,
      },
      orderBy: 'due_at ASC',
    });
  }
}

export default SalesActivityCollection;
