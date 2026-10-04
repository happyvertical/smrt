/** Synthetic Iolaus-shaped domain; deliberately has no employer transmission. */
import { createHash } from 'node:crypto';
import {
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  backgroundEligible,
  type JobExecutionContext,
} from '@happyvertical/smrt-jobs';

export const IOLAUS_RESOURCE = 'ui://iolaus/v1/review.html';
export const SYNTHETIC_EVIDENCE =
  'Synthetic candidate: demonstrated TypeScript and SQL in a fictional project.';
export const SYNTHETIC_OPPORTUNITY =
  'Synthetic opportunity: maintain a fictional TypeScript service. No employer exists.';

@smrt({
  api: false,
  cli: false,
  mcp: { include: ['prepare'], tasks: ['prepare'] },
  conflictColumns: ['id'],
})
export class IolausApplication extends SmrtObject {
  ownerId = '';
  tenantId = '';
  candidateEvidence = SYNTHETIC_EVIDENCE;
  opportunity = SYNTHETIC_OPPORTUNITY;
  decision = 'undecided';
  draft = '';
  materials = '';
  materialsDigest = '';
  revision = 1;
  humanReviewOpened = false;
  reviewCount = 0;

  @backgroundEligible()
  async prepare(
    options: { awaitInput?: boolean },
    context?: JobExecutionContext,
  ) {
    if (!context?.task) throw new Error('Preparation requires a durable task.');
    await context.task.assertAuthorized();
    if (options.awaitInput) {
      await context.task.requestContinuation(
        {
          recordId: String(this.id),
          revision: String(this.revision),
          inputKey: 'notes',
        },
        { type: 'string' },
      );
      await context.task.assertAuthorized();
    }
    if (this.decision !== 'prepare')
      throw new Error('Preparation not selected.');
    // Freeze deterministic materials once. Repeated execution cannot replace them.
    if (!this.materials) {
      const materials = JSON.stringify({
        candidateEvidence: this.candidateEvidence,
        opportunity: this.opportunity,
        draft: 'Synthetic draft for human review only. Not submitted.',
        revision: this.revision,
      });
      await context.task.assertAuthorized();
      this.draft = 'Synthetic draft for human review only. Not submitted.';
      this.materials = materials;
      this.materialsDigest = createHash('sha256')
        .update(materials)
        .digest('hex');
      await this.save();
    }
    return {
      materialsDigest: this.materialsDigest,
      revision: this.revision,
      submitted: false,
    };
  }
}
export class IolausApplicationCollection extends SmrtCollection<IolausApplication> {
  static readonly _itemClass = IolausApplication;
}
ObjectRegistry.registerCollection(
  'IolausApplication',
  IolausApplicationCollection,
);
