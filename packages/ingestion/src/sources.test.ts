import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { backgroundEligible } from '@happyvertical/smrt-jobs';
import { sourcesSuite } from './test-support/sources.js';

@smrt({ api: false, cli: false, mcp: false })
class SourceTestWorker extends SmrtObject {
  @backgroundEligible()
  async process(): Promise<void> {}
}
sourcesSuite('sqlite', 'SourceTestWorker');
