// `node --import <this file>`: records every module URL this thread loads (and,
// through the inherited execArgv, each worker thread's) one per line to the
// file named by SMRT_LOAD_LOG. Used to prove what a worker has NOT loaded
// (#5214).
import { appendFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

registerHooks({
  load(url, context, nextLoad) {
    const log = process.env.SMRT_LOAD_LOG;
    if (log) appendFileSync(log, `${url}\n`);
    return nextLoad(url, context);
  },
});
