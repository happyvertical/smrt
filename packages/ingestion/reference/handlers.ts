/** Maintained application fixture; deliberately not a published ingestion entry. */
import { AssetCollection } from '@happyvertical/smrt-assets';
import { Contents } from '@happyvertical/smrt-content';
import type {
  HandlerContext,
  IntakeExecutionOptions,
  IntakeValues,
  OperationHandler,
} from '../src/execution-contracts.js';
export const CONTENT = '@happyvertical/smrt-content:Content';
export const DOCUMENT = '@happyvertical/smrt-content:ContentDocument';
export const CREATE = '@happyvertical/smrt-ingestion-reference:create-draft';
export const ATTACH = '@happyvertical/smrt-ingestion-reference:attach-evidence';
function revision(value: Date | null | undefined): string {
  if (!value) throw new Error('Target revision missing');
  return value.toISOString();
}
async function content(context: HandlerContext, contentId: string) {
  const collection = await Contents.create({ db: context.db });
  const found = await collection.get({ id: contentId });
  if (
    !found ||
    found.tenantId !== context.scope.tenantId ||
    found.context !== context.scope.confidentialScopeId
  )
    throw new Error('Target unavailable');
  return found;
}
async function evidence(context: HandlerContext, evidenceId: string) {
  const rows = (
    await context.db.query(
      "SELECT asset_id FROM intake_evidence WHERE id=? AND item_id=? AND tenant_id=? AND confidential_scope_id=? AND state='durable'",
      evidenceId,
      context.itemId,
      context.scope.tenantId,
      context.scope.confidentialScopeId,
    )
  ).rows;
  if (!rows.length) throw new Error('Evidence unavailable');
  const collection = await AssetCollection.create({ db: context.db });
  const asset = await collection.get({ id: String(rows[0].asset_id) });
  if (!asset || asset.tenantId !== context.scope.tenantId)
    throw new Error('Evidence unavailable');
  return asset;
}
export const assertReferenceTarget: IntakeExecutionOptions['assertTarget'] =
  async (input) => {
    if (![CONTENT, DOCUMENT].includes(input.model))
      throw new Error('Target model unavailable');
    // The application owns this target table. Serialize revision/ownership checks
    // with concurrent writers using the same executor as the domain mutation.
    await input.db.query(
      'UPDATE contents SET id=id WHERE id=? AND tenant_id=? AND context=?',
      input.id,
      input.scope.tenantId,
      input.scope.confidentialScopeId,
    );
    const found = await (await Contents.create({ db: input.db })).get({
      id: input.id,
    });
    if (
      !found ||
      found.tenantId !== input.scope.tenantId ||
      found.context !== input.scope.confidentialScopeId ||
      (input.model === DOCUMENT && found.constructor.name !== 'ContentDocument')
    )
      throw new Error('Target unavailable');
    if (
      input.revision !== undefined &&
      revision(found.updated_at) !== input.revision
    )
      throw new Error('Target changed');
    return { revision: revision(found.updated_at) };
  };
const resultSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['contentId'],
  properties: { contentId: { type: 'string', minLength: 1, maxLength: 64 } },
};
export function referenceHandlers(
  hooks: {
    afterCreate?: () => Promise<void>;
    beforeAttach?: () => Promise<void>;
  } = {},
): OperationHandler[] {
  return [
    {
      id: CREATE,
      version: '1',
      description: 'Create a draft document; never publish.',
      operation: { model: CONTENT, action: 'create', version: '1' },
      capability: { effect: 'write', idempotent: false, openWorld: false },
      argsSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'body'],
        properties: {
          title: { type: 'string', minLength: 1, maxLength: 200 },
          body: { type: 'string', maxLength: 10000 },
        },
      },
      resultSchema,
      resultModels: { contentId: DOCUMENT },
      validate: async () => ({ ok: true }),
      preview: async (args) => ({
        display: {
          operation: 'Create draft',
          title: args.title,
          body: args.body,
        },
        normalizedArgs: args,
        targetPreconditions: [],
      }),
      execution: {
        kind: 'database',
        apply: async (args, context) => {
          const collection = await Contents.create({ db: context.db });
          const created = await collection.create({
            _meta_type: DOCUMENT,
            tenantId: context.scope.tenantId,
            context: context.scope.confidentialScopeId,
            title: String(args.title),
            body: String(args.body),
            status: 'draft',
          });
          await hooks.afterCreate?.();
          return { contentId: created.id } as IntakeValues;
        },
      },
    },
    {
      id: ATTACH,
      version: '1',
      description: 'Attach retained evidence to the reviewed document.',
      operation: { model: CONTENT, action: 'addAsset', version: '1' },
      capability: { effect: 'write', idempotent: true, openWorld: false },
      argsSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['contentId', 'evidenceId'],
        properties: {
          contentId: { type: 'string', minLength: 1, maxLength: 64 },
          evidenceId: { type: 'string', minLength: 1, maxLength: 64 },
        },
      },
      resultSchema,
      resultModels: { contentId: DOCUMENT },
      validate: async (args, context) => {
        await evidence(context, String(args.evidenceId));
        return { ok: true };
      },
      preview: async (args, context) => {
        await evidence(context, String(args.evidenceId));
        const found = args.contentId
          ? await content(context, String(args.contentId))
          : null;
        return {
          display: {
            operation: 'Attach evidence',
            evidenceId: args.evidenceId,
            target: found ? String(found.id) : 'Approved predecessor result',
          },
          normalizedArgs: args,
          targetPreconditions: found
            ? [
                {
                  model: DOCUMENT,
                  id: String(found.id),
                  revision: revision(found.updated_at),
                },
              ]
            : [],
        };
      },
      execution: {
        kind: 'database',
        apply: async (args, context) => {
          const target = await content(context, String(args.contentId));
          const asset = await evidence(context, String(args.evidenceId));
          await hooks.beforeAttach?.();
          await target.addAsset(asset, 'attachment', 0);
          return { contentId: String(target.id) };
        },
      },
    },
  ];
}
