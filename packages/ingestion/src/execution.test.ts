import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import {
  backgroundEligible,
  type JobExecutionContext,
} from '@happyvertical/smrt-jobs';
import { executionSuite, runReviewJob } from './test-support/execution.js';

@smrt({ api: false, cli: false, mcp: false })
class ExecutionFixtureWorker extends SmrtObject {
  @backgroundEligible()
  async process(): Promise<void> {}
  @backgroundEligible()
  async review(input: { actionId: string }, context?: JobExecutionContext) {
    return runReviewJob(this.db, input, context);
  }
}
executionSuite('sqlite', 'ExecutionFixtureWorker');
