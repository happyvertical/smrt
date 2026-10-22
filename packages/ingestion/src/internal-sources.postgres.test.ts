import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { backgroundEligible } from '@happyvertical/smrt-jobs';
import { internalSourceSuite } from './test-support/internal-sources.js';

@smrt({ api: false, cli: false, mcp: false })
class PostgresInternalSourceFixtureWorker extends SmrtObject {
  @backgroundEligible()
  async process(): Promise<void> {}
}
internalSourceSuite('postgres', 'PostgresInternalSourceFixtureWorker');
