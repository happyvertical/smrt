import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { backgroundEligible } from '@happyvertical/smrt-jobs';
import { proposalSuite } from './test-support/proposals.js';

@smrt({ api: false, cli: false, mcp: false })
class ProposalFixtureWorker3 extends SmrtObject {
  @backgroundEligible()
  async process(): Promise<void> {}
}
proposalSuite('sqlite', 'ProposalFixtureWorker3', { index: 3, count: 4 });
