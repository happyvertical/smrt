// Builder operations: run an engine command, or, if it is risky, turn it into
// an Approval and return `pending_approval` without changing anything.
//
// Every function takes the copy it acts on (`target`), named by the caller from
// the request. There is no default. On the LIVE copy a risky change becomes an
// Approval; on the DRAFT copy the draft host approves its own risky changes
// (`autoApprove`, engine-enforced to draft hosts only), so none is asked.
import {
  ApprovalRequiredError,
  type Command,
  EngineError,
  isStructuralCommand,
} from '../../engine/index.ts';
import {
  type ApprovalAction,
  type PendingApproval,
  requestApproval,
} from './approvals.ts';
import { getDraftSlot, hostFor } from './host.ts';
import { type PublicExecuteResult, publicChangeResult } from './results.ts';
import type { Target } from './target.ts';

export type BuilderResult = PublicExecuteResult | PendingApproval;

/** The refusal for a structural request that names the live copy while a draft is open. */
async function refuseLiveStructure(): Promise<never> {
  const slot = await getDraftSlot();
  throw new EngineError(
    slot
      ? `The draft "${slot.name}" is open, so the live app's structure is frozen. Make this change in the draft (target=draft), or publish or discard the draft first.`
      : 'The live app is frozen.',
    'refused',
  );
}

/** Run a command for `author` on `target`. Never passes `approved` (see approvals.ts). */
export async function runCommand(
  command: Command,
  author: string,
  target: Target,
): Promise<BuilderResult> {
  const host = await hostFor(target);
  if (target === 'live' && host.frozen && isStructuralCommand(command))
    await refuseLiveStructure();
  try {
    return publicChangeResult(await host.execute(command, { author }));
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      // Only the live host asks (the draft's autoApprove never throws this).
      // An undo is approved for the version it was planned against: if the app
      // moves on first, approving it must not undo something else.
      const version = (e.plan.preview as { version?: unknown } | undefined)
        ?.version;
      let pinned: Command = command;
      if (command.type === 'undo' && typeof version === 'number')
        pinned = { type: 'undo', version };
      else if (command.type === 'undoTo')
        pinned = {
          type: 'undoTo',
          version: command.version,
          from: host.version,
        };
      return requestApproval(
        { kind: 'command', command: pinned },
        e.plan,
        author,
      );
    }
    throw e;
  }
}

/** Run an app tool on `target`; a risky one (`<model>_delete`) on live becomes an approval. */
export async function runAppTool(
  name: string,
  args: Record<string, unknown>,
  author: string,
  target: Target,
) {
  const host = await hostFor(target);
  try {
    return await host.callAppTool(name, args);
  } catch (e) {
    if (e instanceof ApprovalRequiredError)
      return requestApproval({ kind: 'tool', name, args }, e.plan, author);
    throw e;
  }
}

/** Pass a request to the app's generated REST on `target`; a live DELETE becomes an approval. */
export async function runRest(
  req: { method: string; url: string; body?: string },
  author: string,
  target: Target,
) {
  const host = await hostFor(target);
  try {
    return await host.rest(req);
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      const action: ApprovalAction = {
        kind: 'rest',
        method: req.method.toUpperCase(),
        url: req.url,
        ...(req.body ? { body: req.body } : {}),
      };
      return requestApproval(action, e.plan, author);
    }
    throw e;
  }
}

export function isPending(x: unknown): x is PendingApproval {
  return (
    !!x &&
    typeof x === 'object' &&
    (x as { status?: unknown }).status === 'pending_approval'
  );
}

/**
 * Delete a record. On live: always an approval (nothing is deleted until
 * decided). On the draft: deleted at once (a draft's records are throw-away
 * test data and its host approves its own risky changes).
 */
export async function requestRecordDelete(
  model: string,
  id: string,
  author: string,
  target: Target,
): Promise<PendingApproval | { deleted: string }> {
  const host = await hostFor(target);
  const record = await host.get(model, id); // 404s for a missing record
  if (target === 'draft') return host.remove(model, id);
  return requestApproval(
    { kind: 'record-delete', model, id },
    {
      summary: `Delete ${model} record ${id}`,
      risky: true,
      preview: { model, id, record },
    },
    author,
  );
}
