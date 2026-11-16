/** Register workflow handlers before the embedded fenced runner starts. */
import type { TaskRunner } from '@happyvertical/smrt-jobs';
import { closeHost } from './host.ts';
import { createShellImportService } from './import-workflow.ts';
import { runtime } from './smrt.ts';

let pending: Promise<ReturnType<typeof createShellImportService>> | undefined;
let runner: TaskRunner | undefined;
let service: ReturnType<typeof createShellImportService> | undefined;
let hooked = false;
export function shellImports() {
  pending ??= (async () => {
    const local = await runtime.localRuntime();
    const next = createShellImportService({
      db: local.db,
      root: local.paths.root,
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
      if (!hooked) {
        hooked = true;
        process.on('sveltekit:shutdown' as never, () => {
          void stopShellImports().then(closeHost);
        });
      }
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
export async function stopShellImports() {
  await runner?.stop();
  runner = undefined;
  service?.dispose();
  service = undefined;
  pending = undefined;
}
