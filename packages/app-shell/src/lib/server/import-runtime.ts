/** Register workflow handlers before the embedded fenced runner starts. */

import { readOriginFile } from '@happyvertical/smrt-app-runtime';
import type { TaskRunner } from '@happyvertical/smrt-jobs';
import { requireLocalProfile } from './host.ts';
import { createShellImportService } from './import-workflow.ts';
import { runtime } from './smrt.ts';

let pending: Promise<ReturnType<typeof createShellImportService>> | undefined;
let runner: TaskRunner | undefined;
let service: ReturnType<typeof createShellImportService> | undefined;
export function shellImports() {
  pending ??= (async () => {
    // Workbook import runs on the embedded job runner of the desktop's local
    // runtime; the hosted app has no such runner yet.
    await requireLocalProfile('Workbook import');
    const local = await runtime.localRuntime();
    const next = createShellImportService({
      db: local.db,
      root: local.paths.root,
      assistant: {
        origin: async () =>
          (await readOriginFile(runtime.applicationStateRoot()))?.origin,
      },
    });
    try {
      runner = await local.createEmbeddedJobRunner({
        claimFencing: true,
        concurrency: 1,
        retention: false,
      });
      runner.on('job:failed', () => {
        void next.recover(false).catch(() => {});
      });
      // TaskRunner.start recovers stale workers/jobs; recovery then admits their workflow resumes.
      await runner.start();
      await next.recover();
      service = next;
      return next;
    } catch (error) {
      await runner?.stop();
      next.dispose();
      throw error;
    }
  })();
  pending.catch(() => {
    pending = undefined;
  });
  return pending;
}
/**
 * Stop the import runner and wait for the jobs it is running (`TaskRunner.stop`
 * waits for active jobs). Called by the shutdown sequence (`installShutdown`
 * `stopWork`), after the listener stopped and before the apps close, so an
 * import in flight finishes against an open host.
 */
export async function stopShellImports() {
  // A start still in progress settles first, so its runner is the one stopped.
  await pending?.catch(() => {});
  await runner?.stop();
  runner = undefined;
  service?.dispose();
  service = undefined;
  pending = undefined;
}
