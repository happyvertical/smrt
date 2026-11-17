import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { backgroundEligible } from '@happyvertical/smrt-jobs';
import { proposalSuite } from './test-support/proposals.js';

@smrt({ api: false, cli: false, mcp: false })
class PostgresProposalFixtureWorker1 extends SmrtObject {
  @backgroundEligible()
  async process(): Promise<void> {}
}
proposalSuite('postgres', 'PostgresProposalFixtureWorker1', {
  index: 1,
  count: 4,
});
