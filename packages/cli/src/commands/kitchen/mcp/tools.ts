/**
 * The tools of `smrt kitchen mcp` (#3752): a local, stdio Model Context
 * Protocol server that lets a host's own model (ChatGPT, Codex, Claude)
 * plan a SMRT app with the cookbook command engine, then create the project
 * with `cookbook apply`. The host reasons; nothing here calls a model or
 * holds a credential.
 *
 * Plans may be stored on local disk, one engine state per plan id. Nothing is
 * stored remotely; `apply_plan` writes `smrt.cookbook.json` into the project.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';
import {
  buildBatchTool,
  type CommandError,
  type CookbookEngine,
  checkSchema,
  createCookbookEngine,
  type EngineState,
  type ExportData,
  type JsonSchema,
  type PlanSnapshot,
  type ValidateData,
} from '@happyvertical/smrt-core/cookbook/engine';
import { validateCookbookText } from '../../cookbook/validate.js';
import { createCookbookApplier } from '../apply.js';
import {
  type CatalogOptions,
  type LoadedCatalog,
  loadCatalog,
} from './catalog.js';

/** The most plans one server process holds; the oldest is dropped past it. */
export const MAX_PLANS = 20;

export interface KitchenToolsOptions extends CatalogOptions {
  /** Opt-in static MCP Apps capability probe; does not enable Planner editing. */
  uiSmoke?: boolean;
  /** Self-contained Planner MCP App HTML, built by smrt-planner. */
  plannerUi?: string;
  /** Private local directory for plans that must survive a server restart. */
  plansDir?: string;
  /** Optional loopback port for the live browser preview; 0 chooses a free port. */
  previewPort?: number;
  /** Exact local Vite origin permitted to use the preview bridge. */
  previewOrigin?: string;
  /** Default project template for `apply_plan` (default: smrt-start). */
  template?: string;
  /** Replaces the catalog loader (tests). */
  catalogLoader?: () => Promise<LoadedCatalog>;
}

/** Tool annotations as MCP defines them. */
export interface KitchenToolAnnotations {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface KitchenToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  annotations: KitchenToolAnnotations;
}

/** What a handler returns: structured data plus the compact text for the model. */
export interface KitchenToolResult {
  data: Record<string, unknown> & { ok: boolean };
  text: string;
}

const SCHEMA = 'https://json-schema.org/draft/2020-12/schema';

const planId: JsonSchema = {
  type: 'string',
  description: 'The plan id start_plan returned.',
  minLength: 1,
  maxLength: 100,
};

const errorSchema: JsonSchema = {
  type: 'object',
  description: 'Present when ok is false.',
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
    path: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
  },
  required: ['code', 'message'],
  additionalProperties: true,
};

const snapshotSchema: JsonSchema = {
  type: 'object',
  description:
    'The plan: revision, app name, recipes, features, settings, theme, menu sections and undo ids.',
  properties: {
    version: { type: 'integer' },
    revision: { type: 'integer' },
  },
  required: ['revision'],
  additionalProperties: true,
};

/** A document and snapshot captured together from the current engine state. */
const stateSchema: JsonSchema = {
  type: 'object',
  description:
    'Current authoritative state; paired atomically, including on replay.',
  properties: {
    snapshot: snapshotSchema,
    cookbook: { type: 'object', additionalProperties: true },
  },
  required: ['snapshot', 'cookbook'],
};

/** An output schema: `ok` always, `error` when it is false, plus the extras. */
const output = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema => ({
  $schema: SCHEMA,
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    error: errorSchema,
    warnings: { type: 'array', items: { type: 'string' } },
    ...properties,
  },
  required: ['ok', ...required],
  additionalProperties: true,
});

const input = (
  properties: Record<string, JsonSchema>,
  required: string[] = [],
): JsonSchema => ({
  $schema: SCHEMA,
  type: 'object',
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const annotations = (
  title: string,
  hints: Partial<Omit<KitchenToolAnnotations, 'title'>>,
): KitchenToolAnnotations => ({
  title,
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
  ...hints,
});

const READ_ONLY = { readOnlyHint: true, idempotentHint: true } as const;

/** The batch tool's schema without catalog enums: ids come from search_recipes. */
const batchBase = buildBatchTool({ recipes: [], models: [] }).inputSchema;

export const KITCHEN_TOOLS: readonly KitchenToolDefinition[] = [
  {
    name: 'list_cookbooks',
    title: 'List cookbooks',
    description:
      'List the ready-made cookbooks (starting points such as a bakery or a yoga studio) with the recipes each one switches on. Start here to offer the user a head start.',
    inputSchema: input({}),
    outputSchema: output(
      {
        cookbooks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              recipes: { type: 'array', items: { type: 'string' } },
              features: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'name', 'recipes'],
          },
        },
      },
      ['cookbooks'],
    ),
    annotations: annotations('List cookbooks', READ_ONLY),
  },
  {
    name: 'search_recipes',
    title: 'Search recipes',
    description:
      'Find recipes (units of app function such as Sales or Customers) by words in their id, name, summary or synonyms. With no query, lists them all. Use the returned ids with add_recipes.',
    inputSchema: input({
      query: {
        type: 'string',
        description: 'Words to look for; every word must match.',
        maxLength: 200,
      },
      limit: {
        type: 'integer',
        description: 'Most results to return (default 20).',
        minimum: 1,
        maximum: 100,
      },
    }),
    outputSchema: output(
      {
        total: { type: 'integer' },
        recipes: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              summary: { type: 'string' },
              requires: { type: 'array', items: { type: 'string' } },
              models: { type: 'array', items: { type: 'string' } },
            },
            required: ['id', 'label'],
          },
        },
      },
      ['total', 'recipes'],
    ),
    annotations: annotations('Search recipes', READ_ONLY),
  },
  {
    name: 'start_plan',
    title: 'Start a plan',
    description:
      'Start a new plan for an app, empty or from a ready-made cookbook (see list_cookbooks). Returns the plan id every other tool takes.',
    inputSchema: input({
      cookbook: {
        type: 'string',
        description: 'A ready-made cookbook id from list_cookbooks.',
        minLength: 1,
        maxLength: 200,
      },
      name: {
        type: 'string',
        description: 'A name for the app.',
        minLength: 1,
        maxLength: 200,
      },
    }),
    outputSchema: output(
      {
        planId: { type: 'string' },
        snapshot: snapshotSchema,
        state: stateSchema,
      },
      [],
    ),
    annotations: annotations('Start a plan', {}),
  },
  {
    name: 'run_commands',
    title: 'Change the plan',
    description:
      'Apply plan commands (add_recipes, set_settings, set_theme, rename_item, hide, ...) all-or-nothing. Send expectedRevision from the last snapshot so a stale change is refused, and a batch id so a retry is not applied twice. A single undo command is also accepted. Returns the new snapshot and one receipt per command.',
    inputSchema: {
      ...batchBase,
      $schema: SCHEMA,
      properties: {
        planId,
        ...(batchBase.properties as Record<string, JsonSchema>),
      },
      required: ['planId', 'commands'],
    },
    outputSchema: output({
      planId: { type: 'string' },
      replayed: { type: 'boolean' },
      receipt: { type: 'object', additionalProperties: true },
      results: { type: 'array', items: { type: 'object' } },
      snapshot: snapshotSchema,
      state: stateSchema,
    }),
    annotations: annotations('Change the plan', { idempotentHint: true }),
  },
  {
    name: 'get_plan',
    title: 'Get the plan',
    description:
      'The current plan as a compact snapshot: revision, recipes, settings, theme and the menu the app would show.',
    inputSchema: input({ planId }, ['planId']),
    outputSchema: output({
      planId: { type: 'string' },
      snapshot: snapshotSchema,
      state: stateSchema,
    }),
    annotations: annotations('Get the plan', READ_ONLY),
  },
  {
    name: 'open_preview',
    title: 'Open the live app preview',
    description:
      'Return a local browser URL for this plan when the Kitchen preview bridge is enabled. The app shell and chat then use the same plan.',
    inputSchema: input({ planId }, ['planId']),
    outputSchema: output({
      planId: { type: 'string' },
      url: { type: 'string' },
    }),
    annotations: annotations('Open the live app preview', READ_ONLY),
  },
  {
    name: 'validate_plan',
    title: 'Validate the plan',
    description:
      'Check the plan as a cookbook: the document, that every recipe exists with what it requires, and that policies name real fields. Run before apply_plan. Changes nothing.',
    inputSchema: input({ planId }, ['planId']),
    outputSchema: output({
      planId: { type: 'string' },
      valid: { type: 'boolean' },
      errors: { type: 'array', items: { type: 'string' } },
      diagnostics: { type: 'array', items: { type: 'object' } },
      packages: { type: 'array', items: { type: 'string' } },
    }),
    annotations: annotations('Validate the plan', READ_ONLY),
  },
  {
    name: 'export_plan',
    title: 'Export the plan',
    description:
      'The plan as a cookbook document (version 1) and its `<name>.cookbook.json` text, to show, save or send elsewhere. Changes nothing.',
    inputSchema: input(
      {
        planId,
        name: {
          type: 'string',
          description: 'File name stem; default the app name.',
          maxLength: 200,
        },
      },
      ['planId'],
    ),
    outputSchema: output({
      planId: { type: 'string' },
      fileName: { type: 'string' },
      text: { type: 'string' },
      cookbook: { type: 'object', additionalProperties: true },
    }),
    annotations: annotations('Export the plan', READ_ONLY),
  },
  {
    name: 'apply_plan',
    title: 'Create the project',
    description:
      'Create the project from the plan in an absolute directory: copy the template, add the packages the recipes need to package.json, and write smrt.cookbook.json. Writes files, so ask the user to confirm the directory first; without confirm: true and the confirmCode from the preview nothing is written and the plan is previewed. The template is set by the server (--template), not chosen per call. Re-applying to a project that already has smrt.cookbook.json updates it. Does not install packages unless install is true.',
    inputSchema: input(
      {
        planId,
        dir: {
          type: 'string',
          description:
            'Absolute path of the project directory: absent or empty for a new project, or an existing project that holds smrt.cookbook.json.',
          minLength: 1,
          maxLength: 1000,
        },
        confirm: {
          type: 'boolean',
          description:
            'true once the user agreed to write into dir. Needs confirmCode from the preview of this same plan and dir; otherwise only a preview is returned.',
        },
        confirmCode: {
          type: 'string',
          description:
            'The confirmCode the preview returned for this exact plan state and dir. A code from another dir or an edited plan is refused.',
          maxLength: 200,
        },
        dryRun: {
          type: 'boolean',
          description: 'Preview only, even with confirm.',
        },
        install: {
          type: 'boolean',
          description:
            'Run the package manager install afterwards (slow; default false).',
        },
      },
      ['planId', 'dir'],
    ),
    outputSchema: output({
      planId: { type: 'string' },
      applied: { type: 'boolean' },
      confirmCode: { type: 'string' },
      dir: { type: 'string' },
      mode: { type: 'string', enum: ['new', 'update'] },
      installed: { type: 'boolean' },
      packagesAdded: { type: 'array', items: { type: 'string' } },
      config: { type: 'string' },
      nextSteps: { type: 'array', items: { type: 'string' } },
      errors: { type: 'array', items: { type: 'string' } },
    }),
    annotations: annotations('Create the project', {
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    }),
  },
];

const fail = (
  code: string,
  message: string,
  extra: Partial<CommandError> = {},
): KitchenToolResult => ({
  data: { ok: false, error: { code, message, ...extra } },
  text: `Error ${code}: ${message}`,
});

const failFrom = (error: CommandError): KitchenToolResult =>
  fail(error.code, error.message, {
    ...(error.path ? { path: error.path } : {}),
    ...(error.details ? { details: error.details } : {}),
  });

/** One line of a snapshot, for the model's text. */
export function describeSnapshot(snapshot: PlanSnapshot): string {
  const recipes = snapshot.recipes.map((r) => r.id).join(', ') || 'none';
  const menu = snapshot.sections
    .filter((s) => !s.hidden)
    .map(
      (s) =>
        `${s.label} (${s.items
          .filter((i) => !i.hidden)
          .map((i) => i.label)
          .join(', ')})`,
    )
    .join('; ');
  return [
    `"${snapshot.app.name}" revision ${snapshot.revision}`,
    `recipes: ${recipes}`,
    ...(snapshot.features.length
      ? [`features: ${snapshot.features.join(', ')}`]
      : []),
    ...(snapshot.unavailable.length
      ? [`unavailable: ${snapshot.unavailable.join(', ')}`]
      : []),
    `settings: ${snapshot.settings.currency}, tax ${snapshot.settings.taxRate}%, ${snapshot.settings.paymentTerms}`,
    `theme: ${snapshot.theme.text}`,
    `menu: ${menu || 'empty'}`,
  ].join('\n');
}

interface Plan {
  engine: CookbookEngine;
  /** Exact bytes last read or written; a different file invalidates undo. */
  serialized?: string;
}

/** The first `max` lines, then a count of the rest. */
const firstLines = (lines: string[], max: number): string =>
  [
    ...lines.slice(0, max),
    ...(lines.length > max ? [`... and ${lines.length - max} more`] : []),
  ].join('\n');

/** Tools that say what the catalog lacks; the rest stay quiet. */
const WARNS = new Set([
  'list_cookbooks',
  'search_recipes',
  'start_plan',
  'validate_plan',
]);

const words = (text: string): string[] =>
  text.toLowerCase().split(/\s+/).filter(Boolean);

/** The server's state: the lazily loaded catalog and the plans. */
export class KitchenSession {
  private loaded?: Promise<LoadedCatalog>;
  private readonly plans = new Map<string, Plan>();
  private readonly updates = new Map<string, Promise<void>>();
  previewUrl?: string;

  constructor(private readonly options: KitchenToolsOptions) {}

  /** Load the catalog once; a failed load is retried on the next call. */
  catalog(): Promise<LoadedCatalog> {
    if (!this.loaded) {
      const load =
        this.options.catalogLoader ?? (() => loadCatalog(this.options));
      this.loaded = load().catch((error) => {
        this.loaded = undefined;
        throw error;
      });
    }
    return this.loaded;
  }

  private planPath(id: string): string {
    if (!/^plan-[a-f0-9-]{8,36}$/.test(id)) throw new Error('Invalid plan id.');
    if (!this.options.plansDir)
      throw new Error('Plans directory is not configured.');
    return join(this.options.plansDir, `${id}.json`);
  }

  private savePlan(id: string, engine: CookbookEngine): void {
    if (!this.options.plansDir) return;
    mkdirSync(this.options.plansDir, { recursive: true, mode: 0o700 });
    const target = this.planPath(id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const serialized = `${JSON.stringify(engine.state())}\n`;
    try {
      writeFileSync(temporary, serialized, { mode: 0o600 });
      renameSync(temporary, target);
      this.plans.set(id, { engine, serialized });
    } finally {
      if (existsSync(temporary)) rmSync(temporary);
    }
  }

  /** Serialize the read/check/write transaction across Kitchen processes. */
  private async lockPlan(
    id: string,
  ): Promise<(() => void) | KitchenToolResult> {
    if (!this.options.plansDir) return () => {};
    mkdirSync(this.options.plansDir, { recursive: true, mode: 0o700 });
    const path = `${this.planPath(id)}.lock`;
    const token = randomUUID();
    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const fd = openSync(path, 'wx', 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, token }));
        } catch {
          rmSync(path, { force: true });
          return fail(
            'unavailable',
            'The plan cannot be locked on this device.',
          );
        } finally {
          closeSync(fd);
        }
        return () => {
          try {
            const owner = JSON.parse(readFileSync(path, 'utf8')) as {
              token?: string;
            };
            if (owner.token === token) unlinkSync(path);
          } catch {
            // A failed cleanup must not hide the authoritative command result.
          }
        };
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') {
          return fail(
            'unavailable',
            'The plan cannot be locked on this device.',
          );
        }
      }
      // A crashed owner can leave a stale lock. Automatic stale-lock removal
      // cannot be made safe with an unlink race against a new owner, so fail
      // closed and require operator recovery after the bounded wait.
      if (Date.now() >= deadline) {
        return fail(
          'conflict',
          'This plan is busy in another Kitchen session. Retry the same command; if it stays busy, stop Kitchen and remove its stale plan lock.',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }

  private async plan(id: unknown): Promise<Plan | KitchenToolResult> {
    if (typeof id === 'string' && this.options.plansDir) {
      if (!/^plan-[a-f0-9-]{8,36}$/.test(id)) {
        return fail('not_found', `No plan ${JSON.stringify(id)}.`, {
          path: 'planId',
        });
      }
      let serialized: string;
      try {
        serialized = readFileSync(this.planPath(id), 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          return fail('not_found', `No plan ${JSON.stringify(id)}.`, {
            path: 'planId',
          });
        }
        throw error;
      }
      const cached = this.plans.get(id);
      if (cached?.serialized === serialized) return cached;
      const saved = JSON.parse(serialized) as EngineState;
      const { catalog } = await this.catalog();
      const plan = {
        engine: createCookbookEngine({
          catalog,
          state: saved,
          undoPrefix: `undo-${randomUUID()}`,
        }),
        serialized,
      };
      this.plans.set(id, plan);
      return plan;
    }
    const plan = typeof id === 'string' ? this.plans.get(id) : undefined;
    return (
      plan ??
      fail(
        'not_found',
        `No plan ${JSON.stringify(id)} in this server; call start_plan.`,
        { path: 'planId' },
      )
    );
  }

  /** Validate arguments against a tool's published schema. */
  private static check(
    tool: KitchenToolDefinition,
    args: Record<string, unknown>,
  ): KitchenToolResult | null {
    const problem = checkSchema(tool.inputSchema, args, 'arguments');
    return problem
      ? fail('invalid_input', problem.message, { path: problem.path })
      : null;
  }

  async call(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<KitchenToolResult> {
    const tool = KITCHEN_TOOLS.find((t) => t.name === name);
    if (!tool)
      return fail('unknown_tool', `Unknown tool ${JSON.stringify(name)}.`);
    const invalid = KitchenSession.check(tool, args);
    if (invalid) return invalid;
    try {
      const result = await this.dispatch(name, args);
      if (!result.data.ok || !WARNS.has(name)) return result;
      const { warnings } = await this.catalog().catch(() => ({ warnings: [] }));
      if (!warnings.length || result.data.warnings) return result;
      return {
        data: { ...result.data, warnings },
        text: `${result.text}\nWarnings:\n${firstLines(warnings, 5)}`,
      };
    } catch (error) {
      return fail(
        'failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async dispatch(
    name: string,
    args: Record<string, unknown>,
  ): Promise<KitchenToolResult> {
    switch (name) {
      case 'list_cookbooks':
        return this.listCookbooks();
      case 'search_recipes':
        return this.searchRecipes(args);
      case 'start_plan':
        return this.startPlan(args);
      case 'run_commands':
        return this.runCommands(args);
      case 'get_plan': {
        const plan = await this.plan(args.planId);
        if (!('engine' in plan)) return plan;
        const snapshot = plan.engine.snapshot();
        return {
          data: {
            ok: true,
            planId: args.planId,
            snapshot,
            state: { snapshot, cookbook: plan.engine.cookbook() },
          },
          text: describeSnapshot(snapshot),
        };
      }
      case 'open_preview': {
        const plan = await this.plan(args.planId);
        if (!('engine' in plan)) return plan;
        if (!this.previewUrl || !this.options.previewOrigin) {
          return fail(
            'unavailable',
            'The local preview bridge is not enabled.',
          );
        }
        const port = new URL(this.previewUrl).port;
        const url = `${this.options.previewOrigin}/?kitchenPlan=${encodeURIComponent(args.planId as string)}&kitchenPort=${port}`;
        return {
          data: { ok: true, planId: args.planId, url },
          text: `Open the live app shell: ${url}`,
        };
      }
      case 'validate_plan':
        return this.validatePlan(args);
      case 'export_plan':
        return this.exportPlan(args);
      case 'apply_plan':
        return this.applyPlan(args);
      default:
        return fail('unknown_tool', `Unknown tool ${JSON.stringify(name)}.`);
    }
  }

  private async listCookbooks(): Promise<KitchenToolResult> {
    const { catalog } = await this.catalog();
    const cookbooks = (catalog.cookbooks ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      recipes: c.document.recipes,
      features: c.document.features,
    }));
    return {
      data: { ok: true, cookbooks },
      text: cookbooks.length
        ? cookbooks
            .map((c) => `${c.id}: ${c.name} (${c.recipes.join(', ')})`)
            .join('\n')
        : 'No ready-made cookbooks are available; start an empty plan.',
    };
  }

  private async searchRecipes(
    args: Record<string, unknown>,
  ): Promise<KitchenToolResult> {
    const { catalog } = await this.catalog();
    const wanted = words(typeof args.query === 'string' ? args.query : '');
    const limit = typeof args.limit === 'number' ? args.limit : 20;
    const matches = catalog.recipes.filter((recipe) => {
      const hay =
        `${recipe.id} ${recipe.label} ${(recipe as { summary?: string }).summary ?? ''} ${((recipe as { synonyms?: string[] }).synonyms ?? []).join(' ')}`.toLowerCase();
      return wanted.every((word) => hay.includes(word));
    });
    const recipes = matches.slice(0, limit).map((recipe) => ({
      id: recipe.id,
      label: recipe.label,
      summary: (recipe as { summary?: string }).summary ?? '',
      requires: recipe.requires,
      models: recipe.models,
    }));
    return {
      data: { ok: true, total: matches.length, recipes },
      text: recipes.length
        ? `${matches.length} recipe(s)${matches.length > recipes.length ? `, first ${recipes.length}` : ''}:\n${recipes
            .map(
              (r) => `${r.id}: ${r.label}${r.summary ? ` - ${r.summary}` : ''}`,
            )
            .join('\n')}`
        : 'No recipes match.',
    };
  }

  private async startPlan(
    args: Record<string, unknown>,
  ): Promise<KitchenToolResult> {
    const { catalog } = await this.catalog();
    const engine = createCookbookEngine({
      catalog,
      undoPrefix: `undo-${randomUUID()}`,
    });
    // Apply the starting point first so a refusal (an unknown cookbook) keeps
    // its own error; nothing is stored unless every step worked.
    const steps: unknown[] = [];
    if (typeof args.cookbook === 'string') {
      steps.push({ name: 'apply_cookbook', input: { id: args.cookbook } });
    }
    if (typeof args.name === 'string') {
      steps.push({ name: 'set_name', input: { name: args.name } });
    }
    for (const step of steps) {
      const result = engine.run(step);
      if (!result.ok) return failFrom(result.error);
    }
    const id = `plan-${randomUUID()}`;
    if (this.options.plansDir) {
      try {
        this.savePlan(id, engine);
      } catch {
        return fail(
          'unavailable',
          'The plan could not be saved on this device.',
        );
      }
    } else {
      this.plans.set(id, { engine });
      while (this.plans.size > MAX_PLANS) {
        const oldest = this.plans.keys().next().value;
        if (oldest === undefined) break;
        this.plans.delete(oldest);
      }
    }
    const snapshot = engine.snapshot();
    return {
      data: {
        ok: true,
        planId: id,
        snapshot,
        state: { snapshot, cookbook: engine.cookbook() },
      },
      text: `Started ${id}.\n${describeSnapshot(snapshot)}`,
    };
  }

  private async runCommands(
    args: Record<string, unknown>,
  ): Promise<KitchenToolResult> {
    const id = args.planId as string;
    const previous = this.updates.get(id) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    this.updates.set(id, current);
    await previous;
    try {
      const lock = await this.lockPlan(id);
      if (typeof lock !== 'function') return lock;
      try {
        return await this.runCommandsUnlocked(args);
      } finally {
        lock();
      }
    } finally {
      release();
      if (this.updates.get(id) === current) this.updates.delete(id);
    }
  }

  private async runCommandsUnlocked(
    args: Record<string, unknown>,
  ): Promise<KitchenToolResult> {
    const plan = await this.plan(args.planId);
    if (!('engine' in plan)) return plan;
    const { planId: _planId, ...batch } = args;
    if (!Array.isArray(batch.commands)) {
      return fail('invalid_input', 'commands must be an array.', {
        path: 'commands',
      });
    }
    const commands = batch.commands as { name?: unknown }[];
    // `undo` is refused inside a batch; a lone one is run as a command.
    const lone =
      commands.length === 1 && commands[0]?.name === 'undo'
        ? plan.engine.run({
            ...(commands[0] as object),
            ...(batch.id !== undefined ? { id: batch.id } : {}),
            ...(batch.expectedRevision !== undefined
              ? { expectedRevision: batch.expectedRevision }
              : {}),
          })
        : null;
    if (lone) {
      if (!lone.ok) {
        const failed = failFrom(lone.error);
        return {
          ...failed,
          data: {
            ...failed.data,
            planId: args.planId,
            state: {
              snapshot: plan.engine.snapshot(),
              cookbook: plan.engine.cookbook(),
            },
          },
        };
      }
      if (!lone.replayed) {
        try {
          this.savePlan(args.planId as string, plan.engine);
        } catch {
          this.plans.delete(args.planId as string);
          return fail(
            'unavailable',
            'The plan could not be saved on this device.',
          );
        }
      }
      return {
        data: {
          ok: true,
          planId: args.planId,
          ...(lone.replayed ? { replayed: true } : {}),
          receipt: lone.receipt,
          results: [lone.receipt],
          snapshot: lone.snapshot,
          state: {
            snapshot: plan.engine.snapshot(),
            cookbook: plan.engine.cookbook(),
          },
        },
        text: `${lone.receipt.summary}\n${describeSnapshot(lone.snapshot)}`,
      };
    }
    const result = plan.engine.batch(batch);
    if (!result.ok) {
      const current = result.snapshot;
      return {
        data: {
          ok: false,
          planId: args.planId,
          error: result.error,
          snapshot: current,
          state: { snapshot: current, cookbook: plan.engine.cookbook() },
        },
        text: `Error ${result.error.code}: ${result.error.message}\nNothing was changed (revision ${current.revision}).`,
      };
    }
    if (!result.replayed) {
      try {
        this.savePlan(args.planId as string, plan.engine);
      } catch {
        this.plans.delete(args.planId as string);
        return fail(
          'unavailable',
          'The plan could not be saved on this device.',
        );
      }
    }
    return {
      data: {
        ok: true,
        planId: args.planId,
        ...(result.replayed ? { replayed: true } : {}),
        receipt: result.receipt,
        results: result.results.map((r) => r.receipt),
        snapshot: result.snapshot,
        state: {
          snapshot: plan.engine.snapshot(),
          cookbook: plan.engine.cookbook(),
        },
      },
      text: `${result.replayed ? 'Already applied (same id): ' : ''}${result.results
        .map((r) => r.receipt.summary)
        .join('\n')}\n${describeSnapshot(result.snapshot)}`,
    };
  }

  private async validatePlan(
    args: Record<string, unknown>,
  ): Promise<KitchenToolResult> {
    const plan = await this.plan(args.planId);
    if (!('engine' in plan)) return plan;
    const { index } = await this.catalog();
    const checked = plan.engine.run({ name: 'validate' });
    if (!checked.ok) return failFrom(checked.error);
    const diagnostics = (checked.data as ValidateData).diagnostics;
    const exported = plan.engine.run({ name: 'export_cookbook' });
    if (!exported.ok) return failFrom(exported.error);
    const report = validateCookbookText(
      (exported.data as ExportData).text,
      index,
    );
    const valid = (checked.data as ValidateData).ok && report.ok;
    const errors = report.errors;
    return {
      data: {
        ok: true,
        planId: args.planId,
        valid,
        errors,
        diagnostics,
        packages: report.packages,
        ...(report.warnings.length ? { warnings: report.warnings } : {}),
      },
      text: valid
        ? `Valid. Packages needed: ${report.packages.join(', ') || 'none'}.`
        : `Not valid:\n${firstLines(errors.length ? errors : diagnostics.map((d) => `${d.path}: ${d.message}`), 12)}`,
    };
  }

  private async exportPlan(
    args: Record<string, unknown>,
  ): Promise<KitchenToolResult> {
    const plan = await this.plan(args.planId);
    if (!('engine' in plan)) return plan;
    const result = plan.engine.run({
      name: 'export_cookbook',
      input: typeof args.name === 'string' ? { name: args.name } : {},
    });
    if (!result.ok) return failFrom(result.error);
    const exported = result.data as ExportData;
    return {
      data: {
        ok: true,
        planId: args.planId,
        fileName: exported.fileName,
        text: exported.text,
        cookbook: exported.cookbook as unknown as Record<string, unknown>,
      },
      text: `${exported.fileName}\n${exported.text}`,
    };
  }

  private async applyPlan(
    args: Record<string, unknown>,
  ): Promise<KitchenToolResult> {
    const plan = await this.plan(args.planId);
    if (!('engine' in plan)) return plan;
    const dir = args.dir as string;
    if (!isAbsolute(dir)) {
      return fail('invalid_input', 'dir must be an absolute path.', {
        path: 'dir',
      });
    }
    const exported = plan.engine.run({ name: 'export_cookbook' });
    if (!exported.ok) return failFrom(exported.error);
    // The token binds a confirmation to the previewed directory, template
    // and plan state: a model cannot pre-confirm, and an edited plan or a
    // different directory needs a fresh preview.
    const confirmCode = createHash('sha256')
      .update(
        [
          dir,
          this.options.template ?? '',
          (exported.data as ExportData).text,
        ].join('\0'),
      )
      .digest('hex')
      .slice(0, 32);
    const confirmed =
      args.confirm === true &&
      args.dryRun !== true &&
      args.confirmCode === confirmCode;
    const { index } = await this.catalog();
    const applier = createCookbookApplier({
      dir,
      index,
      template: this.options.template,
      install: confirmed && args.install === true,
      // stdout carries the protocol; the install must never write to it.
      installOutput: 'stderr',
      dryRun: !confirmed,
      manifests: this.options.manifests,
      registry: this.options.registry !== false,
    });
    const outcome = await applier((exported.data as ExportData).text);
    if (!outcome.ok) {
      return {
        data: {
          ok: false,
          planId: args.planId,
          error: {
            code: outcome.status === 422 ? 'invalid_cookbook' : 'apply_refused',
            message: outcome.errors.join('; '),
          },
          errors: outcome.errors,
        },
        text: `Not applied:\n${firstLines(outcome.errors, 12)}`,
      };
    }
    const { plan: applied } = outcome.result;
    const added = Object.keys(applied.addDependencies);
    const summary = `${applied.mode === 'new' ? 'new project' : 'update'} in ${applied.targetDir}; packages added: ${added.join(', ') || 'none'}; smrt.cookbook.json ${applied.config}`;
    const common = {
      planId: args.planId,
      dir: applied.targetDir,
      mode: applied.mode,
      packagesAdded: added,
      config: applied.config,
      nextSteps: outcome.body.nextSteps,
    };
    if (!confirmed) {
      return {
        data: {
          ok: false,
          error: {
            code: 'confirmation_required',
            message:
              'Nothing was written. Show the user this preview and the directory, then call apply_plan again with confirm: true and this confirmCode once they agree.',
            details: { preview: summary },
          },
          confirmCode,
          applied: false,
          installed: false,
          ...common,
        },
        text: `Preview only (nothing written): ${summary}\nAsk the user to confirm, then call apply_plan with confirm: true and confirmCode: ${confirmCode}.`,
      };
    }
    return {
      data: {
        ok: true,
        applied: true,
        installed: outcome.body.installed,
        ...common,
      },
      text: `Applied: ${summary}\nNext steps:\n${outcome.body.nextSteps.join('\n')}`,
    };
  }
}
