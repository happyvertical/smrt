// Builder operations: run an engine command, or, if it is risky, turn it into
// an Approval and return `pending_approval` without changing anything.
import {
  ApprovalRequiredError,
  type Command,
  type ExecuteResult,
} from '../../engine/index.ts';
import {
  type ApprovalAction,
  type PendingApproval,
  requestApproval,
} from './approvals.ts';
import { getHost } from './host.ts';

export type BuilderResult = ExecuteResult | PendingApproval;

/** Run a command for `author`. Never passes `approved` (see approvals.ts). */
export async function runCommand(
  command: Command,
  author: string,
): Promise<BuilderResult> {
  const host = await getHost();
  try {
    return await host.execute(command, { author });
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      // An undo is approved for the version it was planned against: if the app
      // moves on first, approving it must not undo something else.
      const version = (e.plan.preview as { version?: unknown } | undefined)
        ?.version;
      const pinned: Command =
        command.type === 'undo' && typeof version === 'number'
          ? { type: 'undo', version }
          : command;
      return requestApproval(
        { kind: 'command', command: pinned },
        e.plan,
        author,
      );
    }
    throw e;
  }
}

/** Run an app tool; a risky one (`<model>_delete`) becomes an approval. */
export async function runAppTool(
  name: string,
  args: Record<string, unknown>,
  author: string,
) {
  const host = await getHost();
  try {
    return await host.callAppTool(name, args);
  } catch (e) {
    if (e instanceof ApprovalRequiredError)
      return requestApproval({ kind: 'tool', name, args }, e.plan, author);
    throw e;
  }
}

/** Pass a request to the app's generated REST; a DELETE becomes an approval. */
export async function runRest(
  req: { method: string; url: string; body?: string },
  author: string,
) {
  const host = await getHost();
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

/** Delete a record: always an approval (nothing is deleted until decided). */
export async function requestRecordDelete(
  model: string,
  id: string,
  author: string,
): Promise<PendingApproval> {
  const host = await getHost();
  const record = await host.get(model, id); // 404s for a missing record
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
