/**
 * OpportunityCollection — collection manager for Opportunity, including
 * validated, audited stage movement.
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Opportunity } from '../models/Opportunity.js';
import type { MoveToStageParams } from '../types.js';
import { PipelineStageCollection } from './PipelineStageCollection.js';
import { SalesActivityCollection } from './SalesActivityCollection.js';

export class OpportunityCollection extends SmrtCollection<Opportunity> {
  static readonly _itemClass = Opportunity;

  private stageCollectionPromise: Promise<PipelineStageCollection> | null =
    null;
  private activityCollectionPromise: Promise<SalesActivityCollection> | null =
    null;

  /** Sibling stage collection sharing this collection's DB connection. */
  private async getStageCollection(): Promise<PipelineStageCollection> {
    if (!this.stageCollectionPromise) {
      this.stageCollectionPromise = PipelineStageCollection.create({
        db: this.db,
      });
    }
    return this.stageCollectionPromise;
  }

  /** Sibling activity collection sharing this collection's DB connection. */
  private async getActivityCollection(): Promise<SalesActivityCollection> {
    if (!this.activityCollectionPromise) {
      this.activityCollectionPromise = SalesActivityCollection.create({
        db: this.db,
      });
    }
    return this.activityCollectionPromise;
  }

  /**
   * Opportunities originating from a given lead, oldest first (the first row
   * is the one `LeadCollection.qualify()` treats as canonical).
   */
  async findByLead(leadId: string): Promise<Opportunity[]> {
    return await this.list({
      where: { leadId },
      orderBy: 'created_at ASC',
    });
  }

  /**
   * Open (still in play) opportunities, optionally narrowed to one pipeline.
   */
  async findOpen(pipelineId?: string): Promise<Opportunity[]> {
    return await this.list({
      where: { status: 'open', ...(pipelineId ? { pipelineId } : {}) },
      orderBy: 'created_at ASC',
    });
  }

  /**
   * Move an opportunity to another stage of ITS pipeline, with the full
   * consequence set:
   *
   * - validates the target stage belongs to the opportunity's pipeline
   *   (an opportunity created without a pipeline adopts the stage's);
   * - adopts the stage's default `probability` unless
   *   `probabilityOverride` is given;
   * - terminal stages close the deal: `isWon` sets `status: 'won'` +
   *   `wonAt`; `isLost` sets `status: 'lost'` + `lostAt` (record the loss
   *   reason via `outcomeReason`);
   * - writes a `stage_change` SalesActivity carrying from/to detail.
   *
   * Moves after a terminal status are rejected — a closed deal's history is
   * settled; reopening is not supported (create a new opportunity instead).
   *
   * @returns The updated opportunity
   */
  async moveToStage(params: MoveToStageParams): Promise<Opportunity> {
    const opportunity = await this.get({ id: params.opportunityId });
    if (!opportunity) {
      throw new Error(
        `OpportunityCollection.moveToStage: opportunity '${params.opportunityId}' not found`,
      );
    }
    if (opportunity.status !== 'open') {
      throw new Error(
        `OpportunityCollection.moveToStage: opportunity '${params.opportunityId}' ` +
          `is '${opportunity.status}' — stage moves after a terminal status are not allowed`,
      );
    }

    const stagesCollection = await this.getStageCollection();
    const stage = await stagesCollection.get({ id: params.stageId });
    if (!stage) {
      throw new Error(
        `OpportunityCollection.moveToStage: stage '${params.stageId}' not found`,
      );
    }
    if (opportunity.pipelineId && stage.pipelineId !== opportunity.pipelineId) {
      throw new Error(
        `OpportunityCollection.moveToStage: stage '${stage.key || stage.id}' belongs to ` +
          `pipeline '${stage.pipelineId}', not the opportunity's pipeline '${opportunity.pipelineId}'`,
      );
    }

    const fromStageId = opportunity.stageId;
    const fromStatus = opportunity.status;

    // An opportunity created without a pipeline adopts the stage's pipeline
    // on its first move.
    if (!opportunity.pipelineId) {
      opportunity.pipelineId = stage.pipelineId;
    }
    opportunity.stageId = stage.id ?? '';
    opportunity.probability = params.probabilityOverride ?? stage.probability;
    if (params.outcomeReason !== undefined) {
      opportunity.outcomeReason = params.outcomeReason;
    }
    if (stage.isWon) {
      opportunity.status = 'won';
      opportunity.wonAt = new Date();
    } else if (stage.isLost) {
      opportunity.status = 'lost';
      opportunity.lostAt = new Date();
    }
    await opportunity.save();

    const activities = await this.getActivityCollection();
    await activities.create({
      ...(opportunity.tenantId !== null
        ? { tenantId: opportunity.tenantId }
        : {}),
      subjectKind: 'opportunity',
      subjectId: opportunity.id ?? '',
      activityKind: 'stage_change',
      summary: `Moved to stage '${stage.key}'`,
      actorProfileId: params.actorProfileId ?? '',
      metadata: JSON.stringify({
        fromStageId,
        toStageId: stage.id ?? '',
        toStageKey: stage.key,
        fromStatus,
        toStatus: opportunity.status,
        probability: opportunity.probability,
        ...(params.outcomeReason !== undefined
          ? { outcomeReason: params.outcomeReason }
          : {}),
      }),
    });

    return opportunity;
  }
}

export default OpportunityCollection;
