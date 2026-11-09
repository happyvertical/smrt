// `holdForUser`: pause a chat turn on an Approval until the owner decides it
// (through the dock's card or anywhere else that calls `Approval.decide`).
// The turn only WAITS: the decision is made by `Approval.decide`, the one
// place the engine's `approved` flag is set; nothing here can approve.
import { ApprovalCollection } from '../../objects/Approval.ts';
import { subscribe } from '../events.ts';
import { getShellDb } from '../host.ts';

export type HoldOutcome =
  | { status: 'approved'; result: unknown }
  | { status: 'failed'; error: string }
  | { status: 'denied' }
  | { status: 'timeout' }
  | { status: 'aborted' };

function parse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * The decided outcome, or null while pending. An approved row with no result
 * yet is still being applied (the service marks it before running it), so it
 * only counts once the decision event has fired (`settled`).
 */
async function read(
  approvalId: string,
  settled: boolean,
): Promise<HoldOutcome | null> {
  const row = await (
    await ApprovalCollection.create({ db: await getShellDb() })
  ).get(approvalId);
  if (!row || row.status === 'pending') return null;
  if (row.status === 'denied') return { status: 'denied' };
  if (row.status === 'approved' && !row.result && !settled) return null;
  const result = parse(row.result);
  if (row.status === 'failed')
    return {
      status: 'failed',
      error:
        (result as { error?: unknown } | null)?.error !== undefined
          ? String((result as { error: unknown }).error)
          : 'the change failed',
    };
  return { status: 'approved', result };
}

/**
 * Wait until approval `approvalId` is decided. Resolves `timeout` after
 * `timeoutMs` and `aborted` when `signal` fires; either way the approval stays
 * pending and the owner can still decide it later.
 */
export async function holdForUser(
  approvalId: string,
  options: { signal: AbortSignal; timeoutMs: number },
): Promise<HoldOutcome> {
  const { signal } = options;
  if (signal.aborted) return { status: 'aborted' };
  let settle: (outcome: HoldOutcome) => void = () => {};
  const done = new Promise<HoldOutcome>((resolve) => {
    settle = resolve;
  });
  const check = async (settled: boolean) => {
    try {
      const outcome = await read(approvalId, settled);
      if (outcome) settle(outcome);
    } catch {
      // keep waiting; the timeout or the next event decides
    }
  };
  // Subscribe BEFORE the first read, so a decision between the two is seen.
  const off = subscribe((e) => {
    if (e.type === 'approval' && e.id === approvalId && e.status !== 'pending')
      void check(true);
  });
  const onAbort = () => settle({ status: 'aborted' });
  signal.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(
    () => settle({ status: 'timeout' }),
    options.timeoutMs,
  );
  void check(false);
  try {
    return await done;
  } finally {
    clearTimeout(timer);
    off();
    signal.removeEventListener('abort', onAbort);
  }
}
