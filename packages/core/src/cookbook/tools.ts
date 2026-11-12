/** Server adapter over the cookbook engine. Hosts supply storage and authority. */
import { createHash, randomUUID } from 'node:crypto';
import type { AITool } from '@happyvertical/ai';
import type { Cookbook, RecipeDefinition } from '@happyvertical/smrt-types';
import type { ActivationCoordinator } from '../activation.js';
import type { MCPContext, MCPGenerator } from '../generators/mcp.js';
import {
  COOKBOOK_TOOLS_MODEL,
  isRuntimeModelEnabled,
  notifyRuntimeExposureChanged,
} from '../runtime-exposure.js';
import bakery from './__fixtures__/bakery.cookbook.json';
import mechanic from './__fixtures__/mechanic.cookbook.json';
import welder from './__fixtures__/welder.cookbook.json';
import yoga from './__fixtures__/yoga-studio.cookbook.json';
import { AppToolQuestion, describeApp, planAppEdit } from './app-tool-edits.js';
import {
  canonical,
  coveredModels,
  isEmptyCookbook,
} from './engine/document.js';
import { type CookbookEngine, createCookbookEngine } from './engine/engine.js';
import { modelParts, navItemId } from './engine/nav.js';
import { buildCommandTools, checkSchema } from './engine/schemas.js';
import type {
  EngineCatalog,
  EngineRecipe,
  EngineState,
  JsonSchema,
} from './engine/types.js';
import {
  APP_TOOL_NAMES,
  type AppToolName,
  COOKBOOK_TOOL_NAMES,
  type CookbookToolName,
} from './index.js';
import type { createAppModelEditor } from './model-editor.js';

/** Control-plane identity: this is gated by the host predicate, never recipe membership. */
export { COOKBOOK_TOOLS_MODEL } from '../runtime-exposure.js';
export { COOKBOOK_TOOL_NAMES, type CookbookToolName } from './index.js';
export type CookbookToolRecipe = EngineRecipe &
  Partial<Pick<RecipeDefinition, 'summary' | 'synonyms' | 'help'>> & {
    /** Installed manifest/knowledge intent descriptions associated with this recipe. */
    intents?: readonly string[];
  };
export interface CookbookToolContext {
  /** Trusted host identity, never accepted as arguments. */
  tenantId?: string | null;
  userId?: string | null;
  surface: 'mcp' | 'assistant';
  /** Trusted human first-run route, derived from durable server state; never tool arguments. */
  initialSetup?: boolean;
}
export interface CookbookToolDefinition {
  name: CookbookToolName;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: { type: 'object'; additionalProperties: true };
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: false;
  };
}
export interface CookbookToolResult {
  status:
    | 'ok'
    | 'preview'
    | 'approval_required'
    | 'clarification_required'
    | 'collision';
  summary: string;
  [key: string]: unknown;
}
/** Structural subset of app-runtime's OwnerApprovalAuthority; no dependency back edge. */
export interface CookbookToolApprovals {
  request(input: {
    tenantId: string;
    requestedBy: string;
    tool: string;
    callId: string;
    args: Record<string, unknown>;
    summary: string;
    context: Record<string, unknown>;
  }): Promise<{ id: string }>;
  get(
    tenantId: string,
    id: string,
  ): Promise<{
    id: string;
    tenantId: string;
    requestedBy: string;
    tool: string;
    args: Record<string, unknown>;
    context: Record<string, unknown>;
    status: string;
  } | null>;
  consume(tenantId: string, id: string): Promise<unknown>;
  complete(
    tenantId: string,
    id: string,
    ok: boolean,
    result: unknown,
  ): Promise<void>;
}
export interface CookbookToolAudit {
  context: CookbookToolContext;
  tool: CookbookToolName;
  outcome:
    | 'read'
    | 'preview'
    | 'approval_required'
    | 'requested'
    | 'changed'
    | 'refused';
  summary: string;
}
export interface CookbookToolOptions {
  /** Tenant-bound editor; its awaited publisher updates engineFor and the host web definitions. */
  modelEditorFor?(
    context: CookbookToolContext,
  ): Awaited<ReturnType<typeof createAppModelEditor>> | null | undefined;
  /** Opt-in lazy host: activate before committing any newly enabled cookbook models. */
  activation?: Pick<ActivationCoordinator, 'activate'>;
  catalog: Omit<EngineCatalog, 'recipes'> & {
    recipes: readonly CookbookToolRecipe[];
  };
  /** Current tenant engine; null while the store is unreadable. */
  engineFor(context: CookbookToolContext): CookbookEngine | null | undefined;
  /** Live built-in owner membership, e.g. app-runtime isApprovalOwner. */
  isOwner(context: CookbookToolContext): Promise<boolean>;
  /** Permission slug check, even for owners. */
  can(context: CookbookToolContext, tool: CookbookToolName): Promise<boolean>;
  approvals: CookbookToolApprovals;
  /** True only when the host has no application records/configuration to replace.
   * Enabled content still requires approval except for trusted initialSetup. */
  isAppEmpty(context: CookbookToolContext): Promise<boolean>;
  /** Optional host policy. Non-empty template replacement ALWAYS requires approval. */
  requiresApproval?(
    tool: CookbookToolName,
    context: CookbookToolContext,
  ): boolean;
  /** Atomically CAS the exact before state, persist after AND audit, then publish
   * a restored engine via engineFor. Failure must publish nothing. */
  commit(change: {
    context: CookbookToolContext;
    before: EngineState;
    after: EngineState;
    audit: CookbookToolAudit;
  }): Promise<void>;
  /** Use the host's existing audit sink for reads, previews, holds and refusals. */
  audit(event: CookbookToolAudit): Promise<void>;
}

export class CookbookToolError extends Error {
  readonly publicMessage: string;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.publicMessage = message;
  }
}
const fail = (code: string, message: string): never => {
  throw new CookbookToolError(code, message);
};
const text = {
  type: 'string',
  minLength: 1,
  maxLength: 200,
  pattern: /\S/.source,
};
const object = (
  properties: Record<string, unknown>,
  required: string[] = [],
): JsonSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const digest = (value: unknown): string =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) => digest(a) === digest(b);
const writes = new Set<CookbookToolName>([
  'recipes.enable',
  'recipes.disable',
  'recipes.configure',
  'cookbook.apply',
  ...APP_TOOL_NAMES.filter(
    (name) => name !== 'app.describe' && name !== 'app.history',
  ),
]);

/** Bundled portable documents, not package installation. Unavailable templates are reported. */
export const BUNDLED_COOKBOOK_TEMPLATES = [
  { id: 'bakery', name: 'Bakery', document: bakery as Cookbook },
  { id: 'mechanic', name: 'Mechanic', document: mechanic as Cookbook },
  { id: 'welder', name: 'Welder', document: welder as Cookbook },
  { id: 'yoga-studio', name: 'Yoga Studio', document: yoga as Cookbook },
] as const;

/** One schema/implementation set for MCP and assistant server tools. */
export function createCookbookToolService(options: CookbookToolOptions) {
  const catalog: EngineCatalog = {
    ...options.catalog,
    cookbooks: options.catalog.cookbooks ?? BUNDLED_COOKBOOK_TEMPLATES,
  };
  const policySchema = buildCommandTools(catalog).find(
    (t) => t.name === 'set_policy',
  )!.inputSchema;
  const mutation = {
    expectedRevision: { type: 'integer', minimum: 0 },
    approvalId: text,
  };
  const fieldInput = {
    label: text,
    kind: {
      type: 'string',
      enum: [
        'text',
        'long text',
        'number',
        'money',
        'date',
        'date-time',
        'yes/no',
        'choice',
        'link',
      ],
    },
    options: {
      type: 'array',
      minItems: 1,
      maxItems: 100,
      uniqueItems: true,
      items: text,
    },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    linkTo: text,
  };
  const appMutation = mutation;
  const schemas: Record<CookbookToolName, JsonSchema> = {
    'app.describe': object({}),
    'app.history': object({}),
    'app.addField': object({ list: text, ...fieldInput, ...appMutation }, [
      'list',
      'label',
      'kind',
      'expectedRevision',
    ]),
    'app.renameField': object(
      { list: text, field: text, label: text, ...appMutation },
      ['list', 'field', 'label', 'expectedRevision'],
    ),
    'app.hideField': object({ list: text, field: text, ...appMutation }, [
      'list',
      'field',
      'expectedRevision',
    ]),
    'app.showField': object({ list: text, field: text, ...appMutation }, [
      'list',
      'field',
      'expectedRevision',
    ]),
    'app.removeField': object({ list: text, field: text, ...appMutation }, [
      'list',
      'field',
      'expectedRevision',
    ]),
    'app.addList': object(
      {
        label: text,
        fields: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: object(fieldInput, ['label', 'kind']),
        },
        nameField: text,
        iconMeaning: text,
        ...appMutation,
      },
      ['label', 'fields', 'nameField', 'expectedRevision'],
    ),
    'app.renameList': object(
      { list: text, label: text, iconMeaning: text, ...appMutation },
      ['list', 'label', 'expectedRevision'],
    ),
    'app.removeList': object({ list: text, ...appMutation }, [
      'list',
      'expectedRevision',
    ]),
    'app.undo': object(appMutation, ['expectedRevision']),
    'recipes.search': object(
      {
        query: { ...text, maxLength: 1000 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      ['query'],
    ),
    'recipes.describe': object({ id: text }, ['id']),
    'recipes.enable': object({ id: text, ...mutation }, [
      'id',
      'expectedRevision',
    ]),
    'recipes.disable': object({ id: text, ...mutation }, [
      'id',
      'expectedRevision',
    ]),
    'recipes.configure': object(
      {
        id: text,
        ...mutation,
        fields: { type: 'array', maxItems: 100, items: policySchema },
        items: {
          type: 'array',
          maxItems: 100,
          items: object(
            {
              id: text,
              label: { type: ['string', 'null'], maxLength: 120 },
              icon: {
                type: ['string', 'null'],
                pattern: '^[A-Za-z][A-Za-z0-9_-]{0,63}$',
              },
            },
            ['id'],
          ),
        },
      },
      ['id', 'expectedRevision'],
    ),
    'cookbook.listTemplates': object({}),
    'cookbook.apply': object(
      { id: text, apply: { type: 'boolean' }, previewToken: text, ...mutation },
      ['id'],
    ),
  };
  const descriptions: Record<CookbookToolName, string> = {
    'app.describe':
      'Describe the live app lists and fields in plain language, with human labels, ownership and the customization revision.',
    'app.history': 'Show the durable history of changes to your app.',
    'app.addField':
      'Add a field using its human label and kind; internal names are derived for you. Money is integer minor units; supply currency. Choice needs options; link needs linkTo, a list label.',
    'app.renameField':
      'Rename a field label everywhere without changing its stored data.',
    'app.hideField': 'Hide a field while keeping its data.',
    'app.showField': 'Show a hidden field.',
    'app.removeField':
      'Remove a field from view and keep its data; durable owner approval is required.',
    'app.addList':
      'Create your own list from a name and a few fields; nameField is the human label of the record name field. Choose an icon by describing its meaning.',
    'app.renameList':
      'Rename a list and choose its icon by meaning; use the current human list label.',
    'app.removeList':
      'Remove one of your own lists and keep its data; durable owner approval is required.',
    'app.undo':
      'Undo the last app change and explain what was undone; durable approval is required because undo may hide fields or lists.',
    'recipes.search':
      'Find installed building blocks by what you want to do. Reports what each adds and whether it is on.',
    'recipes.describe':
      'Explain a recipe, its records, menu items, dependencies and current revision.',
    'recipes.enable':
      'Turn on a recipe and its dependencies without rebuilding the app. Owner only.',
    'recipes.disable':
      'Turn off a recipe; retain dependencies still in use. Owner approval required by default.',
    'recipes.configure':
      'Change field labels, hidden fields, defaults and menu labels/icons through cookbook overrides.',
    'cookbook.listTemplates':
      'List bundled starter cookbooks and any missing installed building blocks.',
    'cookbook.apply':
      'Preview a starter cookbook diff first; apply its preview token at the same revision. Replacing a non-empty app requires owner approval.',
  };
  const definitions: CookbookToolDefinition[] = COOKBOOK_TOOL_NAMES.map(
    (name) => ({
      name,
      description: descriptions[name],
      inputSchema: schemas[name],
      outputSchema: { type: 'object', additionalProperties: true },
      annotations: {
        readOnlyHint: !writes.has(name),
        destructiveHint:
          name === 'recipes.disable' ||
          name === 'cookbook.apply' ||
          name === 'app.removeField' ||
          name === 'app.removeList' ||
          name === 'app.undo',
        idempotentHint: !writes.has(name),
        openWorldHint: false,
      },
    }),
  );
  type Preview = {
    tenantId: string;
    userId: string;
    revision: number;
    template: string;
    document: string;
    expires: number;
  };
  const previews = new Map<string, Preview>();
  async function allowed(context: CookbookToolContext, name: CookbookToolName) {
    try {
      return (
        !!context.tenantId &&
        !!context.userId &&
        (name.startsWith('app.')
          ? !!options.modelEditorFor?.(context)
          : isRuntimeModelEnabled(COOKBOOK_TOOLS_MODEL, context)) &&
        !!options.engineFor(context) &&
        (await options.isOwner(context)) &&
        (await options.can(context, name))
      );
    } catch {
      return false;
    }
  }
  async function assertAllowed(
    context: CookbookToolContext,
    name: CookbookToolName,
  ) {
    if (!(await allowed(context, name)))
      fail(
        'forbidden',
        'Tools require a signed-in owner, permission and an available app; recipe tools also require pre-built components.',
      );
  }
  function describe(recipe: CookbookToolRecipe, engine: CookbookEngine) {
    return {
      id: recipe.id,
      name: recipe.label,
      description: recipe.summary ?? recipe.label,
      adds: recipe.nav.map((entry) => ({
        id: navItemId(
          modelParts(catalog, entry.model).packageId,
          modelParts(catalog, entry.model).name,
          entry.key,
        ),
        label: entry.label,
        description:
          entry.description ?? `Manage ${entry.label.toLowerCase()}.`,
      })),
      models: recipe.models.map((id) => ({
        id,
        name:
          catalog.models.find((m) => m.id === id)?.name ??
          modelParts(catalog, id).name,
        description: catalog.models.find((m) => m.id === id)?.description,
      })),
      requires: recipe.requires,
      requiresAny: recipe.requiresAny ?? [],
      enabled: engine.snapshot().recipes.some((r) => r.id === recipe.id),
      revision: engine.snapshot().revision,
    };
  }
  function templateInfo(id: string) {
    const template = catalog.cookbooks?.find((t) => t.id === id);
    if (!template) return fail('not_found', 'Unknown cookbook template.');
    const probe = createCookbookEngine({ catalog });
    const result = probe.run({ name: 'apply_cookbook', input: { id } });
    if (!result.ok) return fail(result.error.code, result.error.message);
    const unknownRecipes = probe.snapshot().unavailable;
    const known = new Set(catalog.models.map((m) => m.id));
    const missingModels = probe
      .cookbook()
      .features.filter((id) => !known.has(id));
    return {
      template,
      missing: [...new Set([...unknownRecipes, ...missingModels])],
    };
  }
  async function approveChange(
    name: CookbookToolName,
    args: Record<string, unknown>,
    context: CookbookToolContext,
    binding: Record<string, unknown>,
    summary: string,
  ): Promise<string | CookbookToolResult> {
    const { approvalId: _, ...boundArgs } = args;
    if (typeof args.approvalId !== 'string') {
      const request = await options.approvals.request({
        tenantId: context.tenantId!,
        requestedBy: context.userId!,
        tool: name,
        callId: randomUUID(),
        args: boundArgs,
        summary,
        context: binding,
      });
      await options.audit({
        context,
        tool: name,
        outcome: 'approval_required',
        summary,
      });
      return {
        status: 'approval_required',
        summary: `Owner approval required: ${summary}`,
        approvalId: request.id,
      };
    }
    const record = await options.approvals.get(
      context.tenantId!,
      args.approvalId,
    );
    if (
      !record ||
      record.status !== 'approved' ||
      record.tenantId !== context.tenantId ||
      record.requestedBy !== context.userId ||
      record.tool !== name ||
      !same(record.args, boundArgs) ||
      !same(record.context, binding)
    )
      fail(
        'forbidden',
        'Approval is missing, stale or belongs to another action.',
      );
    await options.approvals.consume(context.tenantId!, record!.id);
    return record!.id;
  }
  async function invokeApp(
    name: AppToolName,
    args: Record<string, unknown>,
    context: CookbookToolContext,
  ): Promise<CookbookToolResult> {
    const editor = options.modelEditorFor?.(context);
    if (!editor) return fail('unavailable', 'Your app editor is unavailable.');
    const before = editor.snapshot();
    const read = async (result: CookbookToolResult) => {
      await options.audit({
        context,
        tool: name,
        outcome: 'read',
        summary: result.summary,
      });
      return result;
    };
    if (name === 'app.describe') {
      const lists = describeApp(before, options.catalog);
      return read({
        status: 'ok',
        summary: `Your app has ${lists.length} lists.`,
        revision: before.revision,
        lists,
      });
    }
    if (name === 'app.history') {
      const history = await editor.history();
      return read({
        status: 'ok',
        summary: `Your app has ${history.length} recorded changes.`,
        revision: before.revision,
        changes: history.map((row) => ({
          revision: row.revision,
          actor: row.actor,
          status: row.status,
          change: JSON.parse(row.command),
          summary: (JSON.parse(row.command) as { summary?: string }).summary,
          undoes: row.undoes,
        })),
      });
    }
    if (args.expectedRevision !== before.revision)
      return fail(
        'conflict',
        'Your app changed; describe it again before editing.',
      );
    let planned: ReturnType<typeof planAppEdit>;
    try {
      planned = planAppEdit(name, args, before, options.catalog);
    } catch (error) {
      if (error instanceof AppToolQuestion) return read(error.result);
      throw error;
    }
    if (name === 'app.undo') {
      const history = await editor.history();
      const undone = new Set(history.map((row) => row.undoes));
      const previous = history.findLast(
        (row) =>
          row.status === 'applied' &&
          row.undoes === undefined &&
          !undone.has(row.revision),
      );
      if (!previous) return fail('not_found', 'There is no change to undo.');
      const edit = JSON.parse(previous.command) as {
        summary?: string;
        type: string;
        label?: string;
        name?: string;
      };
      planned.summary = `Undid change ${previous.revision}: ${edit.summary?.replace(/[.!?]$/, '') ?? `${edit.type.replaceAll('_', ' ')}${edit.label || edit.name ? ` “${edit.label ?? edit.name}”` : ''}`}.`;
      planned.data = { undoneRevision: previous.revision, change: edit };
    }
    let hold: string | undefined;
    if (
      name === 'app.removeField' ||
      name === 'app.removeList' ||
      name === 'app.undo' ||
      options.requiresApproval?.(name, context)
    ) {
      const approval = await approveChange(
        name,
        args,
        context,
        {
          appTools: 1,
          before: digest(before.cookbook),
          revision: before.revision,
          edit: planned.edit,
        },
        planned.summary,
      );
      if (typeof approval !== 'string') return approval;
      hold = approval;
    }
    try {
      await assertAllowed(context, name);
      if (
        options.modelEditorFor?.(context) !== editor ||
        !same(editor.snapshot(), before)
      )
        return fail(
          'conflict',
          'Your app changed before this action could apply.',
        );
      // The editor journal is the durable mutation audit; the host sink records the tool/transport identity.
      await options.audit({
        context,
        tool: name,
        outcome: 'requested',
        summary: planned.summary,
      });
      await assertAllowed(context, name);
      const receipt = await editor.apply(
        { ...planned.edit, summary: planned.summary },
        {
          actor: context.userId!,
          tenantId: context.tenantId!,
          expectedRevision: before.revision,
          requestId: hold ?? randomUUID(),
        },
      );
      const result: CookbookToolResult = {
        status: 'ok',
        summary: planned.summary,
        revision: receipt.revision,
        data: planned.data,
        lists: describeApp(receipt, options.catalog),
      };
      if (hold)
        await options.approvals.complete(context.tenantId!, hold, true, result);
      return result;
    } catch (error) {
      if (hold)
        await options.approvals.complete(context.tenantId!, hold, false, {
          status: 'refused',
        });
      throw error;
    }
  }
  async function invoke(
    name: CookbookToolName,
    input: Record<string, unknown>,
    caller: CookbookToolContext,
  ): Promise<CookbookToolResult> {
    // Copy before any await; caller-owned objects cannot rewrite a held action.
    const context = structuredClone(caller);
    const args = structuredClone(input);
    try {
      await assertAllowed(context, name);
      const problem = checkSchema(schemas[name], args);
      if (problem) fail('invalid_input', problem.message);
      if (name.startsWith('app.'))
        return await invokeApp(name as AppToolName, args, context);
      const engine = options.engineFor(context)!;
      const before = engine.state();
      const staged = createCookbookEngine({ catalog, state: before });
      const event = (
        outcome: CookbookToolAudit['outcome'],
        summary: string,
      ): CookbookToolAudit => ({ context, tool: name, outcome, summary });
      const read = async (result: CookbookToolResult) => {
        await options.audit(
          event(
            result.status === 'preview' ? 'preview' : 'read',
            result.summary,
          ),
        );
        return result;
      };
      if (name === 'recipes.search') {
        const words =
          String(args.query)
            .toLowerCase()
            .match(/[\p{L}\p{N}]+/gu) ?? [];
        const results = options.catalog.recipes
          .map((recipe) => {
            const description = describe(recipe, engine);
            const haystack = JSON.stringify([
              recipe.id,
              recipe.label,
              recipe.summary,
              recipe.synonyms,
              recipe.intents,
              recipe.nav,
              description.models,
            ]).toLowerCase();
            return {
              description,
              score: words.filter((word) => haystack.includes(word)).length,
            };
          })
          .filter((r) => r.score > 0)
          .sort(
            (a, b) =>
              b.score - a.score ||
              a.description.id.localeCompare(b.description.id),
          )
          .slice(0, Number(args.limit ?? 10))
          .map((r) => r.description);
        return read({
          status: 'ok',
          summary: `Found ${results.length} installed recipes.`,
          recipes: results,
          revision: before.revision,
        });
      }
      if (name === 'cookbook.listTemplates') {
        return read({
          status: 'ok',
          summary: 'Starter cookbooks available to preview.',
          templates: (catalog.cookbooks ?? []).map((t) => ({
            id: t.id,
            name: t.name,
            description:
              t.document.description ??
              createCookbookEngine({ catalog, cookbook: t.document })
                .snapshot()
                .sections.filter((s) => !s.hidden)
                .map((s) => s.label)
                .join(' · '),
            lists: createCookbookEngine({ catalog, cookbook: t.document })
              .snapshot()
              .sections.filter((s) => !s.hidden)
              .flatMap((s) =>
                s.items.filter((i) => !i.hidden).map((i) => i.label),
              ),
            recipes: t.document.recipes,
            missing: templateInfo(t.id).missing,
          })),
        });
      }
      if (name === 'recipes.describe') {
        const recipe = options.catalog.recipes.find((r) => r.id === args.id);
        if (!recipe) return fail('not_found', 'Unknown installed recipe.');
        return read({
          status: 'ok',
          summary: recipe.summary ?? recipe.label,
          recipe: describe(recipe, engine),
        });
      }
      if (
        name !== 'cookbook.apply' &&
        args.expectedRevision !== before.revision
      )
        fail('conflict', 'The cookbook changed. Read it again before editing.');
      let summary: string;
      const replacingApp =
        name === 'cookbook.apply' &&
        ((!context.initialSetup && !isEmptyCookbook(before.cookbook)) ||
          !(await options.isAppEmpty(context)));
      if (name === 'cookbook.apply') {
        const { template, missing } = templateInfo(String(args.id));
        if (missing.length)
          fail(
            'unavailable',
            `Template needs installed recipes or models: ${missing.join(', ')}.`,
          );
        const result = staged.run({
          name: 'apply_cookbook',
          input: { id: template.id, replace: true },
        });
        if (!result.ok) return fail(result.error.code, result.error.message);
        // A preview or pending decision is an intention, never a success claim.
        summary = `Use ${template.name}.`;
        if (args.apply !== true) {
          for (const [key, value] of previews)
            if (value.expires <= Date.now()) previews.delete(key);
          if (previews.size >= 500)
            previews.delete(previews.keys().next().value!);
          const token = randomUUID();
          previews.set(token, {
            tenantId: context.tenantId!,
            userId: context.userId!,
            revision: before.revision,
            template: template.id,
            document: digest(canonical(staged.cookbook())),
            expires: Date.now() + 15 * 60_000,
          });
          return read({
            status: 'preview',
            summary: `Preview: ${summary}`,
            previewToken: token,
            revision: before.revision,
            approvalRequired: replacingApp,
            diff: {
              before: before.cookbook,
              after: staged.cookbook(),
              added: staged
                .cookbook()
                .recipes.filter((id) => !before.cookbook.recipes.includes(id)),
              removed: before.cookbook.recipes.filter(
                (id) => !staged.cookbook().recipes.includes(id),
              ),
            },
          });
        }
        // A durable approved hold pins the original preview through restart.
        // Only the host ledger can supply this receipt; arguments alone never restore it.
        if (typeof args.approvalId === 'string') {
          const held = await options.approvals.get(
            context.tenantId!,
            args.approvalId,
          );
          const { approvalId: _, ...boundArgs } = args;
          if (
            held?.status === 'approved' &&
            held.requestedBy === context.userId &&
            held.tool === name &&
            same(held.args, boundArgs) &&
            held.context.preview
          ) {
            previews.set(
              String(args.previewToken),
              held.context.preview as NonNullable<
                ReturnType<typeof previews.get>
              >,
            );
          }
        }
        const preview = previews.get(String(args.previewToken));
        if (
          !preview ||
          preview.expires <= Date.now() ||
          preview.tenantId !== context.tenantId ||
          preview.userId !== context.userId ||
          preview.revision !== before.revision ||
          args.expectedRevision !== before.revision ||
          preview.template !== template.id ||
          preview.document !== digest(canonical(staged.cookbook()))
        )
          fail('conflict', 'Preview this template again before applying it.');
      } else if (name === 'recipes.configure') {
        const recipe = options.catalog.recipes.find((r) => r.id === args.id);
        if (!recipe || !before.cookbook.recipes.includes(recipe.id))
          fail('not_found', 'Enable the recipe before configuring it.');
        const commands: unknown[] = [];
        for (const field of (args.fields ?? []) as Record<string, unknown>[]) {
          if (!recipe!.models.includes(String(field.model)))
            fail(
              'invalid_input',
              'Field model does not belong to this recipe.',
            );
          commands.push({ name: 'set_policy', input: field });
        }
        for (const item of (args.items ?? []) as {
          id: string;
          label?: string | null;
          icon?: string | null;
        }[]) {
          const own = describe(recipe!, engine).adds.some(
            (entry) => entry.id === item.id,
          );
          if (!own)
            fail('invalid_input', 'Menu item does not belong to this recipe.');
          if (item.label !== undefined)
            commands.push({
              name: 'rename_item',
              input: { id: item.id, label: item.label },
            });
        }
        if (commands.length) {
          const result = staged.batch({
            commands,
            expectedRevision: before.revision,
          });
          if (!result.ok) return fail(result.error.code, result.error.message);
        }
        // The document validator owns icon grammar; import preserves all other slices.
        const document = staged.cookbook();
        for (const item of (args.items ?? []) as {
          id: string;
          icon?: string | null;
        }[]) {
          if (item.icon === undefined) continue;
          document.layout ??= { version: 1 };
          document.layout.items ??= {};
          const entry = document.layout.items[item.id] ?? {};
          if (item.icon === null) delete entry.icon;
          else entry.icon = item.icon;
          document.layout.items[item.id] = entry;
        }
        if (!same(document, staged.cookbook())) {
          const result = staged.run({
            name: 'import_cookbook',
            input: { document, replace: true },
          });
          if (!result.ok) return fail(result.error.code, result.error.message);
        }
        summary = `Configured ${recipe!.label}.`;
      } else {
        if (!catalog.recipes.some((recipe) => recipe.id === args.id))
          fail('not_found', 'Unknown installed recipe.');
        const result = staged.run({
          name: name === 'recipes.enable' ? 'add_recipes' : 'remove_recipes',
          input: { ids: [args.id] },
        });
        if (!result.ok) return fail(result.error.code, result.error.message);
        summary =
          result.receipt.summary || 'The cookbook already has these settings.';
      }
      summary ||= 'No changes needed; dependencies still in use are retained.';
      const approvalRequired =
        replacingApp ||
        (options.requiresApproval?.(name, context) ??
          name === 'recipes.disable');
      let hold: string | undefined;
      const binding = {
        cookbookTools: 1,
        before: digest(before),
        after: digest(staged.state()),
        ...(name === 'cookbook.apply'
          ? { preview: previews.get(String(args.previewToken)) }
          : {}),
      };
      if (approvalRequired) {
        const approval = await approveChange(
          name,
          args,
          context,
          binding,
          summary,
        );
        if (typeof approval !== 'string') return approval;
        hold = approval;
      }
      try {
        await assertAllowed(context, name);
        if (
          options.activation &&
          (name === 'recipes.enable' || name === 'cookbook.apply')
        ) {
          try {
            const document = staged.cookbook();
            // Editor-owned lists are outside the fixed source graph. Never hide
            // an undeclared unknown identity: the coordinator must still refuse it.
            const customLists = new Set(
              Object.keys(document.models?.lists ?? {}).map(
                (name) => `${document.models?.packageName}:${name}`,
              ),
            );
            await options.activation.activate(
              [...coveredModels(catalog, document)].filter(
                (id) => !customLists.has(id),
              ),
            );
          } catch (error) {
            fail(
              'activation_failed',
              `Recipe activation failed; cookbook unchanged: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        if (
          name === 'cookbook.apply' &&
          !hold &&
          !(await options.isAppEmpty(context))
        )
          fail(
            'conflict',
            'Your app now contains records. Preview again before applying.',
          );
        // Recheck after every host await, including the live empty-data check.
        await assertAllowed(context, name);
        if (!same(options.engineFor(context)!.state(), before))
          fail(
            'conflict',
            'The cookbook changed before this action could apply.',
          );
        const result: CookbookToolResult = {
          status: 'ok',
          summary,
          revision: staged.snapshot().revision,
          snapshot: staged.snapshot(),
        };
        const editor = options.modelEditorFor?.(context);
        if (editor) {
          const snapshot = editor.snapshot();
          if (!same(canonical(snapshot.cookbook), canonical(before.cookbook)))
            fail(
              'conflict',
              'The app editor and cookbook are out of sync; refresh the host publication.',
            );
          await options.audit(event('requested', summary));
          await assertAllowed(context, name);
          await editor.apply(
            { type: 'import', cookbook: staged.cookbook(), summary },
            {
              actor: context.userId!,
              tenantId: context.tenantId!,
              expectedRevision: snapshot.revision,
              requestId: hold ?? randomUUID(),
            },
          );
          result.revision = options.engineFor(context)!.snapshot().revision;
          result.snapshot = options.engineFor(context)!.snapshot();
        } else {
          await options.commit({
            context,
            before,
            after: staged.state(),
            audit: event('changed', summary),
          });
        }
        notifyRuntimeExposureChanged();
        if (hold)
          await options.approvals.complete(
            context.tenantId!,
            hold,
            true,
            result,
          );
        return result;
      } catch (error) {
        if (hold)
          await options.approvals.complete(context.tenantId!, hold, false, {
            status: 'refused',
          });
        throw error;
      }
    } catch (error) {
      await options.audit({
        context,
        tool: name,
        outcome: 'refused',
        summary: 'App tool refused.',
      });
      throw error;
    }
  }
  return {
    /** Generated hosts reuse the normal runtime generator for edited fields and new lists. */
    async modelTools(
      context: CookbookToolContext,
      execution: Pick<MCPContext, 'ai' | 'permissions'> = {},
    ): Promise<MCPGenerator | undefined> {
      const editor = options.modelEditorFor?.(context);
      if (
        !editor ||
        !context.tenantId ||
        !context.userId ||
        !options.engineFor(context)
      )
        return undefined;
      const { MCPGenerator } = await import('../generators/mcp.js');
      return new MCPGenerator(
        {
          classNames: describeApp(editor.snapshot(), options.catalog).map(
            (list) => list.id,
          ),
        },
        {
          db: editor.database,
          tenantId: context.tenantId,
          user: { id: context.userId },
          ...execution,
        },
      );
    },
    async list(
      context: CookbookToolContext,
    ): Promise<CookbookToolDefinition[]> {
      const result: CookbookToolDefinition[] = [];
      for (const definition of definitions)
        if (await allowed(context, definition.name))
          result.push(structuredClone(definition));
      return result;
    },
    invoke,
    /** Chat/agents' existing PrincipalTool contract, kept structural to avoid a back edge. */
    async assistantTools(context: CookbookToolContext) {
      return (await this.list(context)).map((definition) => ({
        slug: definition.name,
        aiTool: {
          type: 'function',
          function: {
            name: definition.name,
            description: definition.description,
            parameters: definition.inputSchema,
          },
        } as AITool,
        async execute({
          run,
          args,
        }: {
          run: {
            context: { tenantId: string | null; userId: string | null };
            assertToolAllowed(slug: string): void;
            assertOperation(
              collection: string,
              action: string,
            ): Promise<unknown>;
          };
          args: Record<string, unknown>;
        }) {
          run.assertToolAllowed(definition.name);
          const at = definition.name.lastIndexOf('.');
          await run.assertOperation(
            definition.name.slice(0, at),
            definition.name.slice(at + 1),
          );
          return invoke(definition.name, args, {
            tenantId: run.context.tenantId,
            userId: run.context.userId,
            surface: 'assistant',
          });
        },
      }));
    },
  };
}
export type CookbookToolService = ReturnType<typeof createCookbookToolService>;

declare global {
  var __smrtCookbookToolService: CookbookToolService | undefined;
}
/** Opt-in host registration, shared across module copies just like the exposure gate. */
export function setCookbookToolService(
  service: CookbookToolService | undefined,
): void {
  globalThis.__smrtCookbookToolService = service;
  notifyRuntimeExposureChanged();
}
export function getCookbookToolService(): CookbookToolService | undefined {
  return globalThis.__smrtCookbookToolService;
}
