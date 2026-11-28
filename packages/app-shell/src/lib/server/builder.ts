// Builder operations: run an engine command, or, if it is risky, turn it into
// an Approval and return `pending_approval` without changing anything.
//
// Every function takes the copy it acts on (`target`), named by the caller from
// the request. There is no default. On the LIVE copy a risky change becomes an
// Approval; on the DRAFT copy the draft host approves its own risky changes
// (`autoApprove`, engine-enforced to draft hosts only), so none is asked.

import { routeFor, toolNamesFor } from '../../engine/definition.ts';
import {
  type AppHost,
  ApprovalRequiredError,
  type Command,
  EngineError,
  type EnginePrincipal,
  isRiskyTool,
  isStructuralCommand,
} from '../../engine/index.ts';
import { commandSummary } from '../ui/command-summary.ts';
import { fieldLabel, humanize } from '../ui/fields.ts';
import type { RecordRow } from '../ui/types.ts';
import {
  type ApprovalAction,
  type PendingApproval,
  requestApproval,
} from './approvals.ts';
import {
  addChangeCard,
  isMaintenanceCommand,
  refuseWhileChangesWait,
  type WaitingResult,
} from './changes.ts';
import { hostFor } from './host.ts';
import { authorCaller, type Principal } from './owner.ts';
import { type PublicExecuteResult, publicChangeResult } from './results.ts';
import type { Target } from './target.ts';
import { templateCommands, templateSummary } from './template-records.ts';

/**
 * A structural command became a change waiting (`waiting: true`, with the
 * engine's own result for it) instead of reaching the live app.
 */
export type BuilderResult =
  | PublicExecuteResult
  | PendingApproval
  | (Omit<WaitingResult['result'], 'snapshot'> & {
      status: 'change_waiting';
      waiting: true;
      cardId: string;
      count: number;
    });

/** Who is asking: the assistant, another API caller, or the owner's own History routes. */
export type CommandSource = 'assistant' | 'api' | 'owner';

/** Owner-facing delete details, separate from executable model keys and record ids. */
async function recordPreview(
  host: AppHost,
  owner: Principal,
  model: string,
  id?: string,
) {
  const definition = host.def.models[model];
  const record = id
    ? await host.get(authorCaller(owner, host), model, id)
    : undefined;
  const title =
    definition?.titleField ??
    Object.entries(definition?.fields ?? {}).find(
      ([, f]) => !f.hidden && f.type === 'text',
    )?.[0];
  const label = title ? record?.[title] : undefined;
  return {
    modelLabel: definition?.label ?? humanize(model),
    recordLabel:
      label == null || String(label).trim() === ''
        ? 'the selected record'
        : String(label),
  };
}

/**
 * Run a command for the verified owner. Never passes `approved` (see approvals.ts).
 *
 * Every structural command (including loadRecords, extractModel and
 * mergeRecords) becomes a CARD in the changes waiting (changes.ts) and never
 * reaches live here; only Apply does. The exceptions are History's own undo,
 * undo-to and clean up, which act on live only for the owner's History routes
 * (`source: 'owner'`) and only while nothing waits; anyone else is refused.
 * Read-only commands (export) run on live.
 *
 * An `importTemplate` that carries records waits as ONE card holding the
 * template, its records as `loadRecords` commands and the hides of the
 * temporary key fields (`template-records.ts`), so Apply brings the records.
 */
export async function runCommand(
  command: Command,
  owner: Principal,
  _target: Target = 'live',
  source: CommandSource = 'api',
): Promise<BuilderResult> {
  if (isStructuralCommand(command)) {
    if (!isMaintenanceCommand(command)) {
      const template =
        command.type === 'importTemplate' ? command.data : undefined;
      const commands = template ? templateCommands(template) : [command];
      const waiting = await addChangeCard(
        {
          commands,
          source: source === 'assistant' ? 'assistant' : 'api',
          ...(template && commands.length > 1
            ? { summary: templateSummary(template) }
            : {}),
        },
        owner.id,
      );
      return {
        ...waiting.result,
        status: 'change_waiting',
        waiting: true,
        cardId: waiting.cardId,
        count: waiting.count,
      };
    }
    if (source !== 'owner')
      throw new EngineError(
        'Undoing and cleaning up history are done by the owner from History',
        'refused',
      );
    await refuseWhileChangesWait();
  }
  const host = await hostFor('live');
  try {
    return publicChangeResult(
      await host.execute(authorCaller(owner, host), command, {
        author: owner.id,
      }),
    );
  } catch (e) {
    if (e instanceof ApprovalRequiredError)
      return requestCommandApproval(host, command, e, owner);
    throw e;
  }
}

/**
 * The Approval for a command the live host refused until approved. Only
 * History's undo and clean up reach it from `runCommand`; kept exported so a
 * stored legacy card can be reproduced in tests.
 */
export async function requestCommandApproval(
  host: AppHost,
  command: Command,
  e: ApprovalRequiredError,
  owner: Principal,
): Promise<PendingApproval> {
  // A known conflict is a refusal, not a decision the owner can approve.
  if (
    (command.type === 'undo' || command.type === 'undoTo') &&
    typeof e.plan.preview?.refusal === 'string'
  )
    throw new EngineError(e.plan.preview.refusal, 'refused');
  // Only the live host asks (only History's undo and clean up reach it here).
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
  const description = host.describe();
  const model =
    'model' in command && Object.hasOwn(description.models, command.model)
      ? description.models[command.model]
      : undefined;
  const field =
    model && 'field' in command && Object.hasOwn(model.fields, command.field)
      ? model.fields[command.field]
      : undefined;
  const keep =
    command.type === 'mergeRecords'
      ? await host.get(authorCaller(owner, host), command.model, command.keep)
      : undefined;
  const labelFor = (record: RecordRow | undefined) => {
    if (!record || !model) return 'the selected record';
    const title =
      host.def.models['model' in command ? command.model : '']?.titleField ??
      Object.entries(model.fields).find(
        ([, f]) => !f.hidden && f.type === 'text',
      )?.[0];
    const value = title ? record[title] : undefined;
    return value == null || String(value).trim() === ''
      ? 'the selected record'
      : String(value);
  };
  const removedLabels =
    command.type === 'mergeRecords'
      ? await Promise.all(
          command.merge
            .slice(0, 10)
            .map(async (id) =>
              labelFor(
                (await host.get(
                  authorCaller(owner, host),
                  command.model,
                  id,
                )) as RecordRow | undefined,
              ),
            ),
        )
      : [];
  const preview = {
    ...e.plan.preview,
    ...(command.type === 'importTemplate'
      ? {
          modelLabels: Object.fromEntries(
            Object.entries(command.data.definition.models).map(([name, md]) => [
              name,
              md.label ?? humanize(name),
            ]),
          ),
        }
      : {}),
    ...(model
      ? {
          modelLabel: model.label ?? ('model' in command ? command.model : ''),
        }
      : {}),
    ...(field && 'field' in command
      ? { fieldLabel: fieldLabel(command.field, field) }
      : {}),
    ...(keep && model
      ? {
          keepLabel: labelFor(keep as RecordRow),
          removedLabels,
        }
      : {}),
    ...(command.type === 'extractModel'
      ? {
          intoLabel: Object.hasOwn(description.models, command.into)
            ? (description.models[command.into].label ?? command.into)
            : command.into,
        }
      : {}),
    ...(command.type === 'setCalculation' && model
      ? { fields: model.fields }
      : {}),
    ...(command.type === 'mergeRecords'
      ? {
          referenceLabels: Object.fromEntries(
            Object.keys(
              (e.plan.preview?.references ?? {}) as Record<string, unknown>,
            )
              .filter((name) => Object.hasOwn(description.models, name))
              .map((name) => [name, description.models[name].label ?? name]),
          ),
        }
      : {}),
  };
  return requestApproval(
    { kind: 'command', command: pinned, reviewedPreview: e.plan.preview },
    {
      ...e.plan,
      summary: commandSummary(command, host.def, undefined, preview),
      preview,
    },
    owner.id,
  );
}

/** Staff delete nothing and ask for no approval (#5197): the owner's call alone. */
function refuseStaffDelete(): never {
  throw new EngineError(
    'deleting a record waits for the owner: staff cannot delete',
    'forbidden',
  );
}

/**
 * Run an app tool on `target`; a risky one (`<model>_delete`) on live becomes
 * an approval. `as` is a STAFF engine principal (#5197): the call runs as it
 * (the engine's `authorize.ts` decides), and a delete is refused, never an
 * approval.
 */
export async function runAppTool(
  name: string,
  args: Record<string, unknown>,
  owner: Principal,
  target: Target,
  as?: EnginePrincipal,
) {
  if (as && isRiskyTool(name)) refuseStaffDelete();
  const host = await hostFor(target);
  try {
    return await host.callAppTool(as ?? authorCaller(owner, host), name, args);
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      const model = Object.entries(host.def.models).find(([model, md]) =>
        toolNamesFor(model, md).includes(name),
      )?.[0];
      const details = model
        ? await recordPreview(
            host,
            owner,
            model,
            typeof args.id === 'string' ? args.id : undefined,
          )
        : {};
      return requestApproval(
        { kind: 'tool', name, args },
        {
          ...e.plan,
          summary: `Delete record${'modelLabel' in details ? ` in ${details.modelLabel}` : ''}`,
          preview: { ...e.plan.preview, ...details },
        },
        owner.id,
      );
    }
    throw e;
  }
}

/**
 * Pass a request to the app's generated REST on `target`; a live DELETE
 * becomes an approval. `as` is a STAFF engine principal (#5197): the request
 * runs as it, and a DELETE is refused, never an approval.
 */
export async function runRest(
  req: { method: string; url: string; body?: string },
  owner: Principal,
  target: Target,
  as?: EnginePrincipal,
) {
  if (as && req.method.toUpperCase() === 'DELETE') refuseStaffDelete();
  const host = await hostFor(target);
  try {
    return await host.rest(as ?? authorCaller(owner, host), req);
  } catch (e) {
    if (e instanceof ApprovalRequiredError) {
      const action: ApprovalAction = {
        kind: 'rest',
        method: req.method.toUpperCase(),
        url: req.url,
        ...(req.body ? { body: req.body } : {}),
      };
      const route = req.url.split('?')[0].split('/');
      const model = Object.entries(host.def.models).find(
        ([name, md]) => routeFor(name, md) === route[2],
      )?.[0];
      const details = model
        ? await recordPreview(
            host,
            owner,
            model,
            route[3] ? decodeURIComponent(route[3]) : undefined,
          )
        : {};
      return requestApproval(
        action,
        {
          ...e.plan,
          summary: `Delete record${'modelLabel' in details ? ` in ${details.modelLabel}` : ''}`,
          preview: { ...e.plan.preview, ...details },
        },
        owner.id,
      );
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
  owner: Principal,
  target: Target,
): Promise<PendingApproval | { deleted: string }> {
  const host = await hostFor(target);
  const caller = authorCaller(owner, host);
  const record = await host.get(caller, model, id); // 404s for a missing record
  if (target === 'draft') return host.remove(caller, model, id);
  return requestApproval(
    { kind: 'record-delete', model, id },
    {
      summary: `Delete record in ${host.def.models[model]?.label ?? humanize(model)}`,
      risky: true,
      preview: {
        model,
        id,
        record,
        ...(await recordPreview(host, owner, model, id)),
      },
    },
    owner.id,
  );
}
