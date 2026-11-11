/** Server adapter over the cookbook engine. Hosts supply storage and authority. */
import { createHash, randomUUID } from 'node:crypto';
import type { AITool } from '@happyvertical/ai';
import type { Cookbook, RecipeDefinition } from '@happyvertical/smrt-types';
import {
  isRuntimeModelEnabled,
  notifyRuntimeExposureChanged,
} from '../runtime-exposure.js';
import bakery from './__fixtures__/bakery.cookbook.json';
import mechanic from './__fixtures__/mechanic.cookbook.json';
import welder from './__fixtures__/welder.cookbook.json';
import yoga from './__fixtures__/yoga-studio.cookbook.json';
import { canonical, isEmptyCookbook } from './engine/document.js';
import { type CookbookEngine, createCookbookEngine } from './engine/engine.js';
import { modelParts, navItemId } from './engine/nav.js';
import { buildCommandTools, checkSchema } from './engine/schemas.js';
import type {
  EngineCatalog,
  EngineRecipe,
  EngineState,
  JsonSchema,
} from './engine/types.js';

/** Control-plane identity: this is gated by the host predicate, never recipe membership. */
export const COOKBOOK_TOOLS_MODEL = '@happyvertical/smrt-core:CookbookTools';
export const COOKBOOK_TOOL_NAMES = [
  'recipes.search',
  'recipes.describe',
  'recipes.enable',
  'recipes.disable',
  'recipes.configure',
  'cookbook.listTemplates',
  'cookbook.apply',
] as const;
export type CookbookToolName = (typeof COOKBOOK_TOOL_NAMES)[number];
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
  status: 'ok' | 'preview' | 'approval_required';
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
  outcome: 'read' | 'preview' | 'approval_required' | 'changed' | 'refused';
  summary: string;
}
export interface CookbookToolOptions {
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
   * A cookbook with enabled content is non-empty regardless of this answer. */
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
const text = { type: 'string', minLength: 1, maxLength: 200 };
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
  const schemas: Record<CookbookToolName, JsonSchema> = {
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
          name === 'recipes.disable' || name === 'cookbook.apply',
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
        isRuntimeModelEnabled(COOKBOOK_TOOLS_MODEL, context) &&
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
        'Recipe tools require the owner, permission and pre-built components preference.',
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
        (!isEmptyCookbook(before.cookbook) ||
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
        summary =
          result.receipt.summary || 'The cookbook already has these settings.';
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
      const { approvalId: _, ...boundArgs } = args;
      const binding = {
        cookbookTools: 1,
        before: digest(before),
        after: digest(staged.state()),
      };
      if (approvalRequired) {
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
          await options.audit(event('approval_required', summary));
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
        hold = record!.id;
      }
      try {
        // Recheck after approval/storage awaits, including a preference switched off mid-call.
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
        await options.commit({
          context,
          before,
          after: staged.state(),
          audit: event('changed', summary),
        });
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
        summary: 'Recipe tool refused.',
      });
      throw error;
    }
  }
  return {
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
