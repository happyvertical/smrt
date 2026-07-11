/**
 * ReferralTouchCollection — collection manager for {@link ReferralTouch}.
 *
 * Touches are immutable evidence: this collection only creates and reads.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { ReferralTouch } from '../models/ReferralTouch.js';

/** Input for {@link ReferralTouchCollection.findByTargetWindow}. */
export interface TouchWindowQuery {
  subjectKind: string;
  subjectId: string;
  /** Restrict to one program's touches. */
  programId: string;
  /** Only touches occurring at or after this instant. */
  since: Date;
}

export class ReferralTouchCollection extends SmrtCollection<ReferralTouch> {
  static readonly _itemClass = ReferralTouch;

  /** All touches for a referrer, oldest first. */
  async findByReferrer(referrerId: string): Promise<ReferralTouch[]> {
    return await this.list({
      where: { referrerId },
      orderBy: 'occurred_at ASC',
    });
  }

  /**
   * Every touch recorded against one subject identity, oldest first —
   * attribution's raw candidate stream.
   */
  async findBySubject(
    subjectKind: string,
    subjectId: string,
  ): Promise<ReferralTouch[]> {
    return await this.list({
      where: { subjectKind, subjectId },
      orderBy: 'occurred_at ASC',
    });
  }

  /**
   * Touches for one subject within one program occurring at or after
   * `since`, oldest first. The date bound is applied in memory after the
   * indexed equality filters (sibling-module pattern — the semantics hold
   * whether an adapter returns ISO strings or Dates).
   */
  async findByTargetWindow(query: TouchWindowQuery): Promise<ReferralTouch[]> {
    const touches = await this.list({
      where: {
        subjectKind: query.subjectKind,
        subjectId: query.subjectId,
        programId: query.programId,
      },
      orderBy: 'occurred_at ASC',
    });
    return touches.filter(
      (touch) => touch.occurredAt.getTime() >= query.since.getTime(),
    );
  }
}

export default ReferralTouchCollection;
