import { runCommand } from '$lib/server/builder';
import { hostFor } from '$lib/server/host';
import {
  guarded,
  HttpError,
  ident,
  json,
  ownerOf,
  readJson,
  targetOf,
} from '$lib/server/http';
import { reportFailure } from '$lib/server/report-display';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = guarded(async (event) => {
  await ownerOf(event);
  const host = await hostFor(targetOf(event));
  const name = ident(event.params.name, 'report');
  if (!Object.hasOwn(host.describe().reports ?? {}, name))
    throw new HttpError(404, 'This report is no longer available.');
  try {
    return json(await host.runReport(name));
  } catch (error) {
    throw reportFailure(error);
  }
});

export const POST: RequestHandler = guarded(async (event) => {
  const owner = await ownerOf(event);
  const target = targetOf(event);
  const name = ident(event.params.name, 'report');
  const body = await readJson(event.request);
  if (body.action !== 'rename' && body.action !== 'remove')
    throw new HttpError(400, 'Choose rename or remove.');
  if (body.action === 'rename' && typeof body.label === 'string') {
    const label = body.label.trim();
    if (!label || label.length > 120)
      throw new HttpError(400, 'Use a report label of 1 to 120 characters.');
    const host = await hostFor(target);
    const reports = host.describe().reports ?? {};
    const report = Object.hasOwn(reports, name) ? reports[name] : undefined;
    if (!report)
      throw new HttpError(404, 'This report is no longer available.');
    return json(
      await runCommand(
        { type: 'defineReport', name, definition: { ...report, label } },
        owner.id,
        target,
      ),
    );
  }
  const command =
    body.action === 'remove'
      ? { type: 'removeReport' as const, name }
      : {
          type: 'renameReport' as const,
          from: name,
          to: ident(
            typeof body.to === 'string' ? body.to : undefined,
            'report name',
          ),
        };
  return json(await runCommand(command, owner.id, target));
});
