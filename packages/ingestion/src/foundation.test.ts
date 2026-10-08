import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { backgroundEligible } from '@happyvertical/smrt-jobs';
import { foundationSuite, runHostStage } from './test-support/foundation.js';

@smrt({ api: false, cli: false, mcp: false })
class EmbeddedIntakeWorker extends SmrtObject {
  @backgroundEligible()
  async process(input: { itemId: string; revision: number }): Promise<void> {
    await runHostStage(this.db, input);
  }
}
foundationSuite('sqlite', 'EmbeddedIntakeWorker');
