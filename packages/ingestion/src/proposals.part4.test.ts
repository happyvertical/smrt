import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { backgroundEligible } from '@happyvertical/smrt-jobs';
import { proposalSuite } from './test-support/proposals.js';

@smrt({ api: false, cli: false, mcp: false })
class ProposalFixtureWorker4 extends SmrtObject {
  @backgroundEligible()
  async process(): Promise<void> {}
}
proposalSuite('sqlite', 'ProposalFixtureWorker4', { index: 4, count: 4 });
