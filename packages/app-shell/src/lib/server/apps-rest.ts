// The generated REST routes for the builder operations (`POST /api/apps/<op>`,
// made from the `App` methods by the smrt() plugin) answer 200 with the
// pending approval buried in `result`, and turn every failure into a bare 500
// with no log. This handle serves those paths first, with the same owner
// check, same-origin rule, approval gate and error handling as the
// `/api/shell/*` routes: a risky operation answers 202
// `{ status: 'pending_approval', approvalId, summary, preview }`.
import type { Handle } from '@sveltejs/kit';
import { App } from '../objects/App.ts';
import { isPending } from './builder.ts';
import { errorResponse, HttpError, json, ownerOf, readJson } from './http.ts';
import { runAs } from './owner.ts';

type Body = Record<string, unknown>;

/** Each builder operation and the arguments it reads from the JSON body. */
const OPERATIONS: Record<string, (b: Body) => Promise<unknown>> = {
  defineModel: (b) =>
    App.defineModel(
      b.name as string,
      b.fields as never,
      b.label as string | undefined,
    ),
  addField: (b) =>
    App.addField(b.model as string, b.field as string, b.definition as never),
  hideField: (b) => App.hideField(b.model as string, b.field as string),
  renameField: (b) =>
    App.renameField(b.model as string, b.from as string, b.to as string),
  removeField: (b) => App.removeField(b.model as string, b.field as string),
  changeFieldType: (b) =>
    App.changeFieldType(b.model as string, b.field as string, b.to as never),
  removeModel: (b) => App.removeModel(b.model as string),
  addMethod: (b) =>
    App.addMethod(b.model as string, b.name as string, b.method as never),
  enableRecipe: (b) => App.enableRecipe(b.recipe as string),
  undo: () => App.undo(),
  cleanUp: (b) => App.cleanUp(b.keep as number | undefined),
  exportTemplate: (b) => App.exportTemplate(b.includeRecords === true),
  importTemplate: (b) => App.importTemplate(b.data as Body),
  describe: () => App.describe(),
  history: () => App.history(),
};

const PATH = /^\/api\/apps\/([A-Za-z]+)\/?$/;

export const appsRestHandle: Handle = async ({ event, resolve }) => {
  const match = PATH.exec(event.url.pathname);
  if (!match) return resolve(event);
  const op = match[1];
  try {
    const run = Object.hasOwn(OPERATIONS, op) ? OPERATIONS[op] : undefined;
    if (!run || event.request.method !== 'POST')
      throw new HttpError(run ? 405 : 404, 'no such operation');
    const owner = await ownerOf(event);
    const text = await event.request.clone().text();
    const body = text.trim() ? await readJson(event.request) : {};
    const result = await runAs(owner, () => run(body));
    return isPending(result) ? json(result, 202) : json({ action: op, result });
  } catch (error) {
    return errorResponse(error);
  }
};
