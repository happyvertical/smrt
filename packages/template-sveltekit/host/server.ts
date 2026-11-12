/** Documented local SvelteKit composition over the existing runtime and cookbook APIs. */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  executeAsPrincipal,
  type PrincipalTool,
} from '@happyvertical/smrt-agents';
import type {
  McpAppPrincipal,
  McpWorkflowToolDefinition,
} from '@happyvertical/smrt-app-mcp';
import { mountMcpAppRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import {
  createSqliteOwnerApprovalStore,
  isApprovalOwner,
  OwnerApprovalAuthority,
  OwnerApprovalContinuations,
  readOriginFile,
} from '@happyvertical/smrt-app-runtime';
import {
  createOwnerLinkHandler,
  createSessionLayoutLoad,
  createSmrtSvelteKitRuntime,
  type SmrtRuntimeLocals,
  type SmrtSvelteKitRuntime,
  type SmrtSvelteKitRuntimeOptions,
} from '@happyvertical/smrt-app-runtime/sveltekit';
import {
  buildManifestToolCatalog,
  describeAssistantTool,
  invokeManifestTool,
  type ManifestTool,
  manifestToolToAITool,
  requiresOwnerApproval,
} from '@happyvertical/smrt-chat';
import { readAssistantTurnStream } from '@happyvertical/smrt-chat/assistant-turn';
import {
  type AgentCliChatBinding,
  createAgentCliTurnDriver,
  createInferenceAssistantAdapters,
} from '@happyvertical/smrt-chat/engines';
import {
  type AssistantRequestContext,
  configuredAssistantAI,
  type MountAssistantRoutesOptions,
  mountAssistantRoutes,
  resolveAssistantPrincipalFromLocals,
} from '@happyvertical/smrt-chat/sveltekit';
import {
  ObjectRegistry,
  toSnakeCase,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import {
  type ActivationCoordinator,
  type ActivationManifest,
  createActivationCoordinator,
} from '@happyvertical/smrt-core/activation';
import {
  type AppModelSnapshot,
  cookbookModelCatalog,
  createAppModelEditor,
  createSqliteAppModelHistory,
} from '@happyvertical/smrt-core/app-models';
import { validateCookbook } from '@happyvertical/smrt-core/cookbook';
import {
  BUNDLED_COOKBOOK_TEMPLATES,
  COOKBOOK_TOOL_NAMES,
  CookbookToolError,
  type CookbookToolOptions,
  createCookbookToolService,
  setCookbookToolService,
} from '@happyvertical/smrt-core/cookbook/tools';
import { resolveApiMethodExposure } from '@happyvertical/smrt-core/generators/custom-action';
import {
  MCPGenerator,
  type MCPTool,
} from '@happyvertical/smrt-core/generators/mcp';
import { APIGenerator } from '@happyvertical/smrt-core/generators/rest';
import {
  createCookbookRuntimeExposure,
  filterRuntimeCookbookSnapshot,
  filterRuntimeExposure,
  isRuntimeModelEnabled,
  setRuntimeExposureGate,
} from '@happyvertical/smrt-core/runtime-exposure';
import {
  type ChatGPTPlanConnection,
  createAgentCliService,
  createChatGPTPlanConnection,
  createDesignRunStore,
  createInferenceSettingsController,
  createInferenceSettingsHost,
  INFERENCE_PERMISSION_DEFINITIONS,
  inferencePreferenceKind,
  locateCli,
  nextWorkModel,
  OPENAI_WORK_MODEL_RANKS,
  projectWorkModelSelection,
  type ResolvedWorkProfile,
  rankOpenAIWorkModels,
  recommendedWorkProfile,
  resolveWorkProfile,
  tokenCredentials,
  type WorkProfileName,
  type WorkRunMetadata,
} from '@happyvertical/smrt-inference/server';
import { TaskRunner } from '@happyvertical/smrt-jobs';
import {
  createPrebuiltComponentsPreference,
  createPreferenceStore,
  createWorkProfilesPreference,
  getPreferencePrincipal,
  registerPreferenceKind,
  type WorkProfilePreferences,
} from '@happyvertical/smrt-preferences';
import { mountConnectAiRoutes } from '@happyvertical/smrt-svelte/connect-ai/server';
import {
  buildCookbookShell,
  type CookbookAppData,
  catalogFromManifests,
  readInstalledManifests,
} from '@happyvertical/smrt-svelte/cookbook/server';
import type { OnboardingState } from '@happyvertical/smrt-svelte/onboarding';
import { applyShellLayout } from '@happyvertical/smrt-svelte/workspace/layout';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { Cookbook } from '@happyvertical/smrt-types';
import {
  PermissionResolver,
  RolePermissionCollection,
  registerPermissionDefinitions,
  UserCollection,
} from '@happyvertical/smrt-users';
import type { Handle, RequestEvent, ServerLoad } from '@sveltejs/kit';
import { error, redirect } from '@sveltejs/kit';
import {
  createCookbookDesignRuns,
  isCookbookDesignFinalCheck,
  presentCookbookDesignProgress,
} from './design-runs.js';
import { createCookbookOnboarding } from './onboarding.js';
import {
  createPluginMode,
  PLUGIN_CLIENTS,
  PLUGIN_PERMISSION,
  type PluginModeState,
} from './plugin-mode.js';
import { createCookbookHostState } from './state.js';

const describePublicAssistantTool: typeof describeAssistantTool = (
  name,
  _args,
  outcome,
) =>
  describeAssistantTool(
    outcome ? name : 'change',
    undefined,
    outcome ? { ok: outcome.ok, observation: undefined } : undefined,
    { recordLabels: 'generic' },
  );

// Only the core editor's bounded human command captions may become public.
// Labels containing implementation syntax fall back without altering the ledger.
const personChangeSummary = (
  value: unknown,
  prospective = false,
): string | undefined => {
  if (
    typeof value !== 'string' ||
    value.length > 180 ||
    !/^(Added|Renamed|Removed|Hid|Showed|Undid|Use|Used|Configured|Enabled|Disabled) [\p{L}\p{N} ’'(),-]+\.?$/u.test(
      value,
    ) ||
    /[a-z][A-Z]/.test(value) ||
    /\b(?:revision|cookbook|smrt|profile|tenant|identity|schema|namespace|class|package)\b/i.test(
      value,
    )
  )
    return undefined;
  if (!prospective) return value.replace(/^Use /, 'Used ');
  const verbs: Record<string, string> = {
    added: 'Add',
    renamed: 'Rename',
    removed: 'Remove',
    hid: 'Hide',
    showed: 'Show',
    use: 'Use',
    used: 'Use',
    configured: 'Configure',
    enabled: 'Enable',
    disabled: 'Disable',
  };
  return value
    .replace(
      /^(Added|Renamed|Removed|Hid|Showed|Use|Used|Configured|Enabled|Disabled) /,
      (verb) => `${verbs[verb.trim().toLowerCase()]} `,
    )
    .replace(/ and kept its data(\.?)$/, ' and keep its data$1');
};

export interface CookbookHostOptions {
  runtime: SmrtSvelteKitRuntime;
  packageName?: string;
  application?: string;
  activation?: () => ActivationCoordinator;
  root?: string;
  /** Inject a validated installed catalog/document in tests or generated hosts. */
  app?: { cookbook: Cookbook; catalog: CookbookToolOptions['catalog'] };
  title?: string;
  /** Opt-in first-run composition; owner sign-in remains runtime-owned. */
  onboarding?: boolean;
  assistant?: Pick<
    MountAssistantRoutesOptions,
    'ai' | 'systemPrompt' | 'onError'
  >;
  /** In-process test/host seams; inference still owns vendor discovery and credentials. */
  cli?: ReturnType<typeof createAgentCliService>;
  chatgpt?: ChatGPTPlanConnection;
}

async function readHostApp(
  options: Pick<CookbookHostOptions, 'root' | 'app'>,
): Promise<NonNullable<CookbookHostOptions['app']>> {
  const root = options.root ?? process.cwd();
  return (
    options.app ??
    (await (async () => {
      const manifests = await readInstalledManifests(root);
      const catalog = catalogFromManifests(manifests, true);
      const checked = validateCookbook(
        JSON.parse(await readFile(join(root, 'smrt.cookbook.json'), 'utf8')),
        { recipes: catalog.recipes.map((r) => r.id) },
      );
      if (!checked.ok) throw new Error(checked.errors.join('; '));
      // The catalog keeps search/help while dropping full model declarations.
      return {
        cookbook: checked.cookbook,
        catalog: {
          ...catalog,
          recipes: catalog.recipes.map((r) => ({
            ...r,
            requires: r.requires ?? [],
          })),
        },
      };
    })())
  );
}

/** Normal local runtime, with fixed-graph SQLite activation before owner bootstrap. */
export function createCookbookApplication(
  options: Omit<
    CookbookHostOptions,
    'runtime' | 'activation' | 'packageName'
  > & {
    packageName: string;
    lazyActivation: {
      manifest: ActivationManifest;
      loaders: Record<string, () => Promise<unknown>>;
      scope: string;
      alwaysOn?: string[];
    };
    runtimeOptions?: Omit<
      SmrtSvelteKitRuntimeOptions,
      'createSchema' | 'prepareDatabase'
    >;
  },
) {
  let activation: ActivationCoordinator;
  const runtime = createSmrtSvelteKitRuntime({
    ...options.runtimeOptions,
    createSchema: false,
    prepareDatabase: async (db, context) => {
      if (context.profile !== 'local')
        throw new Error('Cookbook host requires the local SQLite runtime');
      const app = await readHostApp(options);
      const state = await createCookbookHostState(
        db,
        app.catalog,
        app.cookbook,
      );
      const graph = options.lazyActivation;
      activation = createActivationCoordinator({
        scope: graph.scope,
        packageName: options.packageName!,
        db,
        manifest: graph.manifest,
        loaders: graph.loaders,
        alwaysOn:
          graph.alwaysOn ??
          Object.keys(graph.manifest.models).filter((id) =>
            /^@happyvertical\/smrt-(users|profiles|tenancy|chat|approvals|preferences|inference|secrets|jobs):/.test(
              id,
            ),
          ),
        readEnabled: () =>
          state.enabledModelUnion(
            async (tenantId) =>
              (
                await (
                  await createSqliteAppModelHistory({
                    db,
                    tenantId,
                    application: options.application ?? options.packageName,
                  })
                ).read()
              ).at(-1)?.after,
          ),
      });
      setRuntimeExposureGate({ isEnabled: () => false });
      await activation.boot();
    },
  });
  return createCookbookHost({
    ...options,
    runtime,
    activation: () => activation,
  });
}

/** One local owner host per process. Construct before runtime.init seeds permissions. */
export function createCookbookHost(options: CookbookHostOptions) {
  const { runtime } = options;
  registerPreferenceKind(inferencePreferenceKind, { replace: true });
  registerPermissionDefinitions([
    ...INFERENCE_PERMISSION_DEFINITIONS,
    {
      slug: 'app.approvals',
      category: 'app',
      name: 'Read your tool approval outcomes',
      description:
        'Read the existing owner continuation outcome under the original tool scope',
    },
    {
      slug: PLUGIN_PERMISSION,
      category: 'app',
      name: 'Use the app with your own AI',
      description:
        'Delegate the current enabled app tool surface to a local AI client; destructive calls still require owner approval',
    },
  ]);
  const inference = createInferenceSettingsHost({
    database: () => runtime.database(),
    masterKeyProvider: () => runtime.secretMasterKey(),
    overrides: () => runtime.classOptions('InferenceOverride'),
  });
  inference.install();
  const inferenceSettings = createInferenceSettingsController({
    host: inference,
    preferenceStore: async () =>
      createPreferenceStore({ db: await runtime.database() }),
  });
  const cli = options.cli ?? createAgentCliService();
  let connection: ChatGPTPlanConnection;
  let current: Awaited<ReturnType<typeof initialize>>;
  let starting: Promise<typeof current> | undefined;
  const designRequests = new WeakMap<
    Request,
    {
      profile: ResolvedWorkProfile;
      schema: Record<string, unknown>;
      prompt: string;
      content: string;
    }
  >();
  let origin: string | undefined;
  let taskRunner: TaskRunner | undefined;
  let disposeDesignRuns: (() => void) | undefined;
  const turns = new Map<
    string,
    {
      id: string;
      toolCalls: number;
      startedAt: number;
      approvalRequired(id: string): void;
      context: AssistantRequestContext;
      turn: Parameters<
        Parameters<typeof createAgentCliTurnDriver>[0]['bind']
      >[0];
    }
  >();
  const digest = (token: string) =>
    createHash('sha256').update(token).digest('hex');
  const wireName = (slug: string) =>
    toSnakeCase(slug).replace(/[^a-z0-9_]/g, '_');
  const isManifestToolEnabled = (tool: ManifestTool, tenantId: string) =>
    isRuntimeModelEnabled(
      ObjectRegistry.getExposureModel(tool.qualifiedName ?? tool.className),
      { surface: 'assistant', tenantId },
    );
  const json = (value: unknown, status = 200) =>
    Response.json(value, { status, headers: { 'cache-control': 'no-store' } });
  const isOwner = async (tenantId?: string | null, id?: string | null) =>
    !!tenantId &&
    !!id &&
    isApprovalOwner(await runtime.database(), { tenantId, id });

  async function initialize() {
    await runtime.init();
    if ((await runtime.resolvedRuntime()).profile !== 'local')
      throw new Error(
        'Cookbook host currently requires the local SQLite runtime',
      );
    const db = await runtime.database();
    const loaded = await readHostApp(options);
    // Fork only the writable envelope; compiled catalog records are immutable
    // and shared with activation. Model editing replaces its models array.
    const app = { ...loaded, catalog: { ...loaded.catalog } };
    if (options.onboarding)
      app.catalog = {
        ...app.catalog,
        cookbooks: [
          {
            id: 'fresh',
            name: 'Fresh',
            document: {
              $schema: 'https://s-m-r-t.dev/schemas/cookbook/v1.json',
              version: 1,
              recipes: [],
              features: [],
              policies: [],
            },
          },
          ...(app.catalog.cookbooks ?? BUNDLED_COOKBOOK_TEMPLATES),
        ],
      };
    const state = await createCookbookHostState(db, app.catalog, app.cookbook);
    const authority = new OwnerApprovalAuthority(
      await createSqliteOwnerApprovalStore(db),
      (actor) => isApprovalOwner(db, actor),
    );
    const preferences = createPrebuiltComponentsPreference({
      store: createPreferenceStore({ db }),
      isOwner: (p) => isOwner(p.tenantId, p.userId),
    });
    const workProfiles = createWorkProfilesPreference({
      store: createPreferenceStore({ db }),
      isOwner: (p) => isOwner(p.tenantId, p.userId),
    });
    async function restoredDesignContext(
      record: import('@happyvertical/smrt-app-runtime').OwnerApproval,
    ) {
      const action = record.context.designAction as
        | Record<string, unknown>
        | undefined;
      if (!action) return {};
      if (
        action.application !== (options.application ?? options.packageName) ||
        typeof action.runId !== 'string' ||
        typeof action.actionId !== 'string' ||
        !/^(0|[1-9]\d*)$/.test(action.actionId)
      )
        throw new Error('Invalid saved design action');
      const user = await (await UserCollection.create({ db })).get({
        id: record.requestedBy,
      });
      const principal = record.context.principal as
        | Record<string, unknown>
        | undefined;
      const saved = await createDesignRunStore({
        db,
        ownerId: record.requestedBy,
        tenantId: record.tenantId,
        enqueue: async () => {
          throw new Error('Read only');
        },
      }).load(action.runId, record.requestedBy);
      if (
        !saved ||
        !/^cookbook-design\/v[345]\//.test(saved.definition) ||
        !user?.profileId ||
        principal?.profileId !== user.profileId ||
        (saved.input as { threadId?: unknown }).threadId !==
          record.context.threadId
      )
        throw new Error('Saved design principal changed');
      await authorizeDesignThread(
        record.requestedBy,
        record.tenantId,
        record.context.threadId as string,
      );
      await designRuns
        .forOwner(record.requestedBy, record.tenantId)
        .validateAction(
          action.runId,
          action.actionId,
          record.tool,
          record.args,
        );
      return {
        designAction: {
          application: action.application as string,
          runId: action.runId,
          actionId: action.actionId,
        },
        threadId: record.context.threadId as string,
        profileId: user.profileId,
      };
    }
    async function authorizeDesignThread(
      ownerId: string,
      tenantId: string | null,
      threadId: string,
    ) {
      if (!tenantId) throw new Error('Tenant required');
      await runtime.runAsPrincipal(
        { id: ownerId, tenantId, kind: 'human' },
        async (bound) => {
          const user = await (await UserCollection.create({ db })).get({
            id: ownerId,
          });
          if (!user?.profileId || !bound) throw new Error('Owner unavailable');
          const url = new URL(
            `/api/assistant/threads/${encodeURIComponent(threadId)}/messages`,
            origin ?? 'http://127.0.0.1',
          );
          const response = await assistantRoutes.GET({
            url,
            request: new Request(url),
            params: {
              path: `threads/${encodeURIComponent(threadId)}/messages`,
            },
            locals: {
              user: { id: ownerId, profileId: user.profileId },
              tenantId,
              permissions: [...(bound.scopes ?? [])],
            },
          } as unknown as RequestEvent);
          if (!response.ok) throw new Error('Design thread unavailable');
        },
      );
    }
    const continuations = new OwnerApprovalContinuations(authority, {
      cookbook: async (record) => {
        const action = record.context.designAction as
          | { runId?: unknown }
          | undefined;
        if (typeof action?.runId === 'string') {
          const saved = await createDesignRunStore({
            db,
            ownerId: record.requestedBy,
            tenantId: record.tenantId,
            enqueue: async () => {
              throw new Error('Read only');
            },
          }).load(action.runId, record.requestedBy);
          // Native authority records the owner's decision normally. An
          // executor-owned hold remains approved/unconsumed while Stop pauses
          // effects; explicit Resume performs the same stable action.
          if (
            saved?.status === 'stopped' &&
            /^cookbook-design\/v[345]\//.test(saved.definition) &&
            isCookbookDesignFinalCheck(saved)
          )
            return {
              status: 'deferred',
              summary:
                'This design is paused. Resume it to apply the approved change.',
            };
        }
        return executeSaved(record, async () =>
          service.invoke(
            record.tool as Parameters<typeof service.invoke>[0],
            { ...record.args, approvalId: record.id },
            {
              surface: 'mcp',
              tenantId: record.tenantId,
              userId: record.requestedBy,
              ...(await restoredDesignContext(record)),
            },
          ),
        );
      },
      model: async (record) =>
        executeSaved(record, async (run) => {
          const offered =
            record.context.pluginMode === true || record.context.threadId
              ? (
                  await manifest(record.tenantId, record.requestedBy, [
                    ...run.permissions,
                  ])
                ).find((t) => t.slug === record.tool)
              : (
                  await mcpModels({
                    id: record.requestedBy,
                    tenantId: record.tenantId,
                    scopes: [...run.permissions],
                  })
                ).find((t) => t.tool.slug === record.tool)?.tool;
          if (!offered) throw new Error('Approved tool is no longer offered');
          return invokeManifestTool(run, offered, record.args, {
            db: run.context.database ?? runtime.databaseConfig(),
          });
        }),
    });
    const executeSaved = async (
      record: import('@happyvertical/smrt-app-runtime').OwnerApproval,
      execute: (
        run: import('@happyvertical/smrt-agents').PrincipalRun,
      ) => Promise<unknown>,
    ) => {
      const principal = record.continuation!.principal;
      await prepare(principal.tenantId, false);
      return executeAsPrincipal(
        {
          principal: {
            runAsUserId: principal.id,
            tenantId: principal.tenantId,
            allowedTools: principal.allowedTools,
          },
          db: runtime.databaseConfig(),
          permissions: [
            ...(
              await (
                await PermissionResolver.create({
                  db: await runtime.database(),
                })
              ).resolvePermissions(principal.id, principal.tenantId)
            ).permissions,
          ].filter((permission) => principal.permissions.includes(permission)),
        },
        async (run) => {
          run.assertToolAllowed(record.tool);
          const at = record.tool.lastIndexOf('.');
          await run.assertOperation(
            record.tool.slice(0, at),
            record.tool.slice(at + 1),
          );
          return execute(run);
        },
      );
    };
    const service = createCookbookToolService({
      ...(options.activation ? { activation: options.activation() } : {}),
      ...{
        modelEditorFor: (c: { tenantId?: string | null }) =>
          c.tenantId ? editors.get(c.tenantId) : undefined,
      },
      catalog: app.catalog,
      engineFor: state.engineFor,
      isOwner: (c) => isOwner(c.tenantId, c.userId),
      can: async (c, slug) => {
        if (!c.tenantId || !c.userId) return false;
        return (
          await (
            await PermissionResolver.create({ db })
          ).resolvePermissions(c.userId, c.tenantId)
        ).permissions.has(slug);
      },
      approvals: continuations.adapter('cookbook'),
      previewBeforeApply: async (context) => {
        if (context.designAction && context.userId && context.tenantId) {
          const saved = await createDesignRunStore({
            db,
            ownerId: context.userId,
            tenantId: context.tenantId,
            enqueue: async () => {
              throw new Error('Read only');
            },
          }).load(context.designAction.runId, context.userId);
          return (
            (saved?.input as { profile?: ResolvedWorkProfile } | undefined)
              ?.profile?.previewBeforeApply !== false
          );
        }
        return (
          (await workProfiles.read()).settings.design?.previewBeforeApply !==
          false
        );
      },
      isAppEmpty: async (context) => {
        if (!context.initialSetup || !context.tenantId) return false;
        const engine = state.engineFor(context);
        if (!engine) return false;
        const shell = buildCookbookShell({
          cookbook: engine.cookbook(),
          catalog: app.catalog,
        });
        return withTenant(
          { tenantId: context.tenantId, userId: context.userId ?? undefined },
          async () => {
            for (const id of new Set(
              [...shell.entries.values()].map((entry) => entry.model.id),
            )) {
              const table = ObjectRegistry.getTableName(id);
              if (!table) return false;
              if (!(await db.tableExists(table))) continue;
              const collection = await ObjectRegistry.getCollection(id, {
                ...runtime.classOptions(id),
                db,
              });
              if (await collection.count()) return false;
            }
            return true;
          },
        );
      },
      commit: state.commit,
      audit: state.audit,
    });
    const cookbookGate = createCookbookRuntimeExposure({
      catalog: app.catalog,
      engineFor: state.engineFor,
      predicate: (model, c) => {
        if (preferences.isEnabled(c.tenantId)) return true;
        const document = state.engineFor(c)?.cookbook();
        return (
          !!document?.models &&
          Object.keys(document.models.lists).some(
            (name) =>
              model.qualifiedName === `${document.models!.packageName}:${name}`,
          )
        );
      },
    });
    const gate = {
      ...(options.activation
        ? options.activation().gate(cookbookGate)
        : cookbookGate),
      dispose: () => cookbookGate.dispose(),
    };
    setCookbookToolService(service);
    setRuntimeExposureGate(gate);
    const onboarding = options.onboarding
      ? await createCookbookOnboarding({
          db,
          catalog: app.catalog,
          authorize: async (event) => {
            const p = resolveAssistantPrincipalFromLocals(event.locals);
            return p && (await isOwner(p.tenantId, p.userId))
              ? {
                  ...p,
                  permissions: [
                    ...((event.locals as SmrtRuntimeLocals).permissions ?? []),
                  ],
                }
              : null;
          },
          invoke: async (actor, name, args, initialSetup = false) => {
            const permissions = [
              ...(
                await (
                  await PermissionResolver.create({ db })
                ).resolvePermissions(actor.userId, actor.tenantId)
              ).permissions,
            ];
            if (!actor.permissions?.includes(name))
              throw new CookbookToolError(
                'forbidden',
                'This operation is not in the session permission snapshot.',
              );
            const ceiling = permissions.filter((permission) =>
              actor.permissions!.includes(permission),
            );
            return continuations.capture(
              {
                id: actor.userId,
                tenantId: actor.tenantId,
                permissions: ceiling,
                allowedTools: [name],
              },
              () =>
                service.invoke(name, args, {
                  ...actor,
                  surface: 'mcp',
                  initialSetup,
                }),
            );
          },
          approval: async (actor, id) => {
            const record = await authority.get(actor.tenantId, id);
            if (!record || record.requestedBy !== actor.userId) return null;
            return {
              id: record.id,
              tool: record.tool,
              callId: record.callId,
              summary: record.summary,
              status: record.status,
              decidedBy: record.decidedBy,
              decidedAt: record.decidedAt,
            };
          },
        })
      : undefined;
    const describeDesignApp = async (
      ownerId: string,
      tenantId: string | null,
      optional = false,
    ) => {
      if (!tenantId) throw new Error('Tenant required');
      return runtime.runAsPrincipal(
        { id: ownerId, tenantId, kind: 'human' },
        async () => {
          await prepare(tenantId, false);
          const context = {
            surface: 'mcp' as const,
            tenantId,
            userId: ownerId,
          };
          if (
            optional &&
            !(await service.list(context)).some(
              (tool) => tool.name === 'app.describe',
            )
          )
            return undefined;
          return service.invoke(
            'app.describe',
            {},
            { surface: 'mcp', tenantId, userId: ownerId },
          );
        },
      );
    };
    const designRuns = createCookbookDesignRuns({
      db,
      authorizeThread: authorizeDesignThread,
      describeApp: (ownerId, tenantId) =>
        describeDesignApp(ownerId, tenantId, true),
      currentRevision: async (ownerId, tenantId) => {
        const result = await describeDesignApp(ownerId, tenantId);
        if (!result || !Number.isSafeInteger(result.revision))
          throw new Error('Application revision unavailable');
        return result.revision as number;
      },
      authorize: async (ownerId, tenantId) => {
        if (!(await isOwner(tenantId, ownerId)))
          throw new Error('Owner required');
      },
      listOperations: async (ownerId, tenantId) => {
        if (!tenantId) throw new Error('Tenant required');
        return runtime.runAsPrincipal(
          { id: ownerId, tenantId, kind: 'human' },
          async () => {
            await prepare(tenantId, false);
            return (
              await service.list({ surface: 'mcp', userId: ownerId, tenantId })
            ).filter((tool) => service.supportsDesignAction(tool.name));
          },
        );
      },
      executeOperation: async ({
        ownerId,
        tenantId,
        threadId,
        runId,
        actionId,
        permissions,
        operation,
        signal,
      }) => {
        if (
          !tenantId ||
          !options.packageName ||
          !service.supportsDesignAction(operation.tool)
        )
          throw new Error('Durable design operation unavailable');
        return runtime.runAsPrincipal(
          { id: ownerId, tenantId, kind: 'human', scopes: [...permissions] },
          async (bound) => {
            await prepare(tenantId, false);
            await authorizeDesignThread(ownerId, tenantId, threadId);
            const user = await (await UserCollection.create({ db })).get({
              id: ownerId,
            });
            if (!user?.profileId || !bound)
              throw new Error('Owner unavailable');
            signal.throwIfAborted();
            const ceiling = [...(bound.scopes ?? [])].filter((permission) =>
              permissions.includes(permission),
            );
            return executeAsPrincipal(
              {
                principal: {
                  runAsUserId: ownerId,
                  tenantId,
                  allowedTools: [operation.tool],
                },
                db: runtime.databaseConfig(),
                permissions: ceiling,
              },
              async (run) => {
                run.assertToolAllowed(operation.tool);
                const at = operation.tool.lastIndexOf('.');
                await run.assertOperation(
                  operation.tool.slice(0, at),
                  operation.tool.slice(at + 1),
                );
                await designRuns
                  .forOwner(ownerId, tenantId)
                  .validateAction(
                    runId,
                    actionId,
                    operation.tool,
                    operation.tool === 'cookbook.apply'
                      ? { ...operation.args, apply: true }
                      : operation.args,
                  );
                signal.throwIfAborted();
                return continuations.capture(
                  {
                    id: ownerId,
                    tenantId,
                    permissions: ceiling,
                    allowedTools: [operation.tool],
                  },
                  () =>
                    service.invoke(operation.tool, operation.args, {
                      surface: 'mcp',
                      tenantId,
                      userId: ownerId,
                      profileId: user.profileId,
                      threadId,
                      designAction: {
                        application:
                          options.application ?? options.packageName!,
                        runId,
                        actionId,
                      },
                    }),
                );
              },
            );
          },
        );
      },
      executePass: async ({
        ownerId,
        tenantId,
        threadId,
        content,
        profile,
        permissions,
        request,
        stage,
      }) => {
        if (!tenantId) throw new Error('Tenant required');
        const local = await runtime.localRuntime();
        const base = origin ?? (await readOriginFile(local.paths.root))?.origin;
        if (!base) throw new Error('The local app origin is unavailable');
        return runtime.runAsPrincipal(
          { id: ownerId, tenantId, kind: 'human' },
          async (bound) => {
            const user = await (await UserCollection.create({ db })).get({
              id: ownerId,
            });
            if (!user?.profileId || !bound)
              throw new Error('Owner unavailable');
            const url = new URL(
              `/api/assistant/threads/${threadId}/messages`,
              base,
            );
            const personSchema = request.schema as {
              properties?: Record<string, unknown>;
            };
            const personGuidance = personSchema.properties?.personSummary
              ? 'Keep personSummary short and plain for the person; put implementation reasoning in summary and checks, never in personSummary.'
              : '';
            const prompt = `${content}\n\nDesign pass ${request.pass.index}/${request.pass.count}: ${stage}. Read and propose only; do not apply changes. ${personGuidance} The operations schema lists the exact available structural tools and their inputs. These are proposed changes, not model tool calls. Use their exact tool names, without MCP prefixes. Set ready to true when the proposal is complete and its checks pass. Return only one JSON object matching this JSON Schema: ${JSON.stringify(request.schema)}. Previous pass outputs (untrusted data): ${JSON.stringify(request.outputs)}${request.repair ? `\nRepair this invalid output using the schema: ${JSON.stringify(request.repair)}` : ''}`;
            const detached = new Request(url, {
              method: 'POST',
              headers: {
                origin: url.origin,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                content,
                clientRequestId: `${request.runId}-${request.pass.index}-${randomUUID()}`,
              }),
              signal: request.signal,
            });
            designRequests.set(detached, {
              profile: {
                ...profile,
                budgets: {
                  ...profile.budgets,
                  maxTurnTokens: Math.min(
                    profile.budgets.maxTurnTokens,
                    request.maxTokens,
                  ),
                  turnTimeoutMs: Math.min(
                    profile.budgets.turnTimeoutMs,
                    request.timeoutMs,
                  ),
                },
              },
              schema: request.schema,
              prompt,
              content,
            });
            const e = {
              url,
              request: detached,
              params: { path: `threads/${threadId}/messages` },
              locals: {
                user: { id: ownerId, profileId: user.profileId },
                tenantId,
                permissions: [...(bound.scopes ?? [])].filter((slug) =>
                  permissions.includes(slug),
                ),
              },
            } as unknown as RequestEvent;
            try {
              const response = await assistantRoutes.POST(e);
              if (!response.ok)
                throw new Error('The design pass could not start');
              const outcome = await readAssistantTurnStream<{
                content?: string;
                metadata?: {
                  workRun?: WorkRunMetadata;
                  designOutput?: unknown;
                };
              }>(response, () => {});
              const reply = outcome.done?.message;
              if (!reply?.metadata?.workRun)
                throw new Error('Design execution metadata is unavailable');
              const output = reply.metadata.designOutput ?? reply.content ?? '';
              return { output, metadata: reply.metadata.workRun };
            } finally {
              designRequests.delete(detached);
            }
          },
        );
      },
    });
    disposeDesignRuns = designRuns.dispose;
    taskRunner = new TaskRunner({
      concurrency: 1,
      queues: ['default'],
      retention: false,
    });
    await taskRunner.initialize(db);
    await taskRunner.start();
    return {
      ...app,
      onboarding,
      state,
      authority,
      continuations,
      preferences,
      workProfiles,
      designRuns,
      service,
      gate,
    };
  }
  let shutdownPromise: Promise<void> | undefined;
  let stopped = false;
  const shutdown = () =>
    (shutdownPromise ??= (async () => {
      // Adapter-node emits its lifecycle event after HTTP connections close.
      // Initialization may still be finishing; stop that same runner after it
      // starts rather than leaving newly-created polling/liveness handles alive.
      try {
        await starting;
      } catch {
        // Initialization's caller owns that failure. Teardown must still stop
        // partially-started resources without reporting the same error twice.
      }
      try {
        await taskRunner?.stop();
      } finally {
        stopped = true;
        disposeDesignRuns?.();
      }
    })());
  const onShutdown = () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
      // biome-ignore lint/suspicious/noConsole: fixed lifecycle failure, no request or credential data
      console.error('Cookbook host shutdown failed');
    });
  };
  process.once('sveltekit:shutdown', onShutdown);
  const ready = () => {
    if (stopped || (!starting && shutdownPromise))
      return Promise.reject(new Error('Cookbook host is shutting down'));
    starting ??= initialize().then((value) => (current = value));
    return starting;
  };
  const publishedDefinitions = new Map<
    string,
    AppModelSnapshot['webDefinitions']
  >();
  const editors = new Map<
    string,
    Awaited<ReturnType<typeof createAppModelEditor>>
  >();
  const editorStarts = new Map<string, Promise<void>>();
  const prepare = async (tenantId: string, recover = true) => {
    const host = await ready();
    await host.state.refresh(tenantId);
    await host.preferences.read();
    if (options.packageName && !editors.has(tenantId)) {
      let opening = editorStarts.get(tenantId);
      if (!opening) {
        opening = (async () => {
          const engine = host.state.engineFor({ tenantId });
          if (!engine) throw new Error('Cookbook unavailable');
          const editor = await createAppModelEditor({
            db: await runtime.database(),
            application: options.application ?? options.packageName!,
            tenantId,
            packageName: options.packageName!,
            cookbook: engine.cookbook(),
            catalog: host.catalog,
            authorize: (c) => isOwner(c.tenantId, c.actor),
            publish: async (snapshot) => {
              // Reuse the users upgrade rail; only newly catalogued slugs get owner grants.
              // One transaction prevents a crash between permission creation and its role grant.
              await withEmbeddedWriteTransaction(
                await runtime.database(),
                true,
                async (tx) => {
                  await (
                    await RolePermissionCollection.create({ db: tx })
                  ).seedNewCatalogPermissions();
                },
              );
              host.catalog.models = cookbookModelCatalog(
                host.catalog,
                snapshot.cookbook.models,
              ).models;
              await host.state.publishModels(
                tenantId,
                snapshot.cookbook,
                snapshot.revision,
              );
              publishedDefinitions.set(
                tenantId,
                snapshot.webDefinitions.filter(
                  (definition) =>
                    definition.customFields.length > 0 ||
                    (definition.objectRef.startsWith(
                      `${snapshot.cookbook.models?.packageName}:`,
                    ) &&
                      Object.hasOwn(
                        snapshot.cookbook.models?.lists ?? {},
                        definition.objectRef.split(':').at(-1) ?? '',
                      )),
                ),
              );
            },
          });
          editors.set(tenantId, editor);
        })();
        editorStarts.set(tenantId, opening);
      }
      try {
        await opening;
      } finally {
        editorStarts.delete(tenantId);
      }
    }
    if (recover) {
      const actor = getPreferencePrincipal();
      if (
        actor?.tenantId === tenantId &&
        actor.userId &&
        (await isOwner(tenantId, actor.userId))
      ) {
        const owner = { id: actor.userId, tenantId };
        for (const record of await host.authority.list(owner, false)) {
          if (record.status !== 'approved' || !record.continuation) continue;
          try {
            const outcome = await host.continuations.resume(owner, record.id);
            const action = outcome.context.designAction as
              | { runId?: unknown }
              | undefined;
            if (
              outcome.status === 'succeeded' &&
              typeof action?.runId === 'string'
            )
              await host.designRuns
                .forOwner(outcome.requestedBy, outcome.tenantId)
                .resumeAfterApproval(action.runId);
          } catch (error) {
            // A concurrent claimant or a recorded refusal is already visible to the requester.
            if (
              (await host.authority.get(tenantId, record.id))?.status ===
              'approved'
            )
              throw error;
          }
        }
      }
    }
    return host;
  };
  const chatgpt = async () => {
    if (options.chatgpt) return options.chatgpt;
    connection ??= createChatGPTPlanConnection({
      appName: options.title ?? 'SMRT app',
      credentialsPath: join(
        (await runtime.localRuntime()).paths.root,
        'chatgpt-credentials.json',
      ),
    });
    return connection;
  };
  const apiStatus = async (context: AssistantRequestContext) => {
    if (options.assistant?.ai) return { configured: true };
    try {
      await configuredAssistantAI(context);
      return { configured: true };
    } catch {
      return { configured: false };
    }
  };
  const manifest = async (
    tenantId: string,
    userId?: string,
    scopes?: readonly string[],
  ): Promise<ManifestTool[]> => {
    const host = await ready();
    const document = host.state.engineFor({ tenantId })?.cookbook();
    if (!document) return [];
    const shell = buildCookbookShell({
      cookbook: document,
      catalog: host.catalog,
    });
    const engine = userId ? await host.state.engine(tenantId, userId) : null;
    const mcpSlugs =
      engine === 'claude-code' || engine === 'codex'
        ? new Set(
            (
              await mcpModels(
                {
                  id: userId,
                  tenantId,
                  scopes: scopes ? [...scopes] : undefined,
                },
                true,
              )
            ).map((t) => t.tool.slug),
          )
        : undefined;
    const names = new Set<string>();
    return buildManifestToolCatalog({ all: true }).flatMap((tool) => {
      if (
        !isManifestToolEnabled(tool, tenantId) ||
        (scopes && !scopes.includes(tool.slug)) ||
        (mcpSlugs && !mcpSlugs.has(tool.slug))
      )
        return [];
      const key = tool.qualifiedName ?? tool.className;
      // Custom methods follow the owning API declaration, using its canonical
      // exposure resolver. The CLI profile already passed the MCP resolver.
      if (
        !mcpSlugs &&
        !['read', 'create', 'update', 'delete'].includes(tool.action)
      ) {
        const method = ObjectRegistry.resolveRuntimeMethod(
          key,
          tool.action,
        ).method;
        if (
          !method ||
          !resolveApiMethodExposure({
            actionName: tool.action,
            method,
            apiConfig: ObjectRegistry.getConfig(key).api,
          }).exposed
        )
          return [];
      }
      const identity = ObjectRegistry.getClass(key)?.qualifiedName;
      const entry = [...shell.entries.values()].find(
        (candidate) =>
          ObjectRegistry.getClass(candidate.model.id)?.qualifiedName ===
          identity,
      );
      if (!identity || !entry) return [];
      const functionName = wireName(`${entry.label}_${tool.action}`).slice(
        0,
        64,
      );
      if (names.has(functionName))
        throw new Error('Conflicting app list tool names');
      names.add(functionName);
      return [
        {
          ...tool,
          functionName,
          description: `${tool.action} records in the app list ${JSON.stringify(entry.label)}.`,
        },
      ];
    });
  };
  const mcpModels = async (
    principal: McpAppPrincipal,
    placedOnly = false,
  ): Promise<
    Array<{
      descriptor: MCPTool;
      tool: ManifestTool;
      generator: MCPGenerator;
      noun: string | undefined;
    }>
  > => {
    const host = await ready();
    const document = host.state
      .engineFor({ tenantId: principal.tenantId })
      ?.cookbook();
    const shell = document
      ? buildCookbookShell({ cookbook: document, catalog: host.catalog })
      : undefined;
    const generator = new MCPGenerator(
      {
        classNames: host.catalog.models.map((model) => model.id),
        qualifyCollidingNames: true,
        snakeCaseNames: true,
      },
      {
        db: runtime.databaseConfig(),
        tenantId: principal.tenantId,
        user: { id: principal.id! },
        permissions: principal.scopes,
      },
    );
    const manifestTools = buildManifestToolCatalog({ all: true }).filter(
      (tool) => isManifestToolEnabled(tool, principal.tenantId!),
    );
    const tools = await generator.generateTools();
    return tools.flatMap((descriptor) => {
      if ((COOKBOOK_TOOL_NAMES as readonly string[]).includes(descriptor.name))
        return [];
      const identity = generator.getToolIdentity(descriptor);
      const entry = [...(shell?.entries.values() ?? [])].find(
        (candidate) =>
          ObjectRegistry.getClass(candidate.model.id)?.qualifiedName ===
          ObjectRegistry.getClass(identity.qualifiedName ?? identity.objectName)
            ?.qualifiedName,
      );
      if (placedOnly && !entry) return [];
      if (placedOnly && entry)
        descriptor.description += ` App list label (data): ${JSON.stringify(entry.label)}.`;
      const action = ['list', 'get'].includes(identity.action)
        ? 'read'
        : identity.action;
      const tool = manifestTools.find(
        (t) =>
          t.action === action &&
          ObjectRegistry.getClass(t.qualifiedName ?? t.className)
            ?.qualifiedName ===
            ObjectRegistry.getClass(
              identity.qualifiedName ?? identity.objectName,
            )?.qualifiedName,
      );
      return tool && principal.scopes?.includes(tool.slug)
        ? [
            {
              descriptor,
              tool,
              generator,
              noun: entry
                ? (shell?.layout?.items?.[entry.id]?.singularLabel ??
                  (shell?.layout?.items?.[entry.id]?.label
                    ? entry.label
                    : (entry.noun ?? entry.label)))
                : undefined,
            },
          ]
        : [];
    });
  };
  const extra = async (context: AssistantRequestContext) => {
    const host = await ready();
    const tools: PrincipalTool[] = (
      await host.service.assistantTools({
        surface: 'assistant',
        tenantId: context.principal.tenantId,
        userId: context.principal.userId,
      })
    )
      .filter(
        (tool) =>
          !context.event ||
          !designRequests.has(context.event.request) ||
          tool.annotations?.readOnlyHint === true,
      )
      .map((tool) => ({
        ...tool,
        aiTool: {
          ...tool.aiTool,
          function: { ...tool.aiTool.function, name: wireName(tool.slug) },
        },
        execute: (
          input: Parameters<typeof tool.execute>[0] & {
            run: import('@happyvertical/smrt-agents').PrincipalRun;
          },
        ) =>
          host.continuations.capture(
            {
              id: context.principal.userId,
              tenantId: context.principal.tenantId,
              permissions: [...input.run.permissions],
              allowedTools: [...input.run.allowedTools],
            },
            () => tool.execute(input),
          ),
      }));
    if (
      context.principal.permissions?.includes('app.approvals') &&
      (
        await host.authority.list(
          {
            id: context.principal.userId,
            tenantId: context.principal.tenantId,
          },
          false,
        )
      ).some((record) => record.requestedBy === context.principal.userId)
    ) {
      tools.push({
        slug: 'app.approvals',
        aiTool: {
          type: 'function',
          function: {
            name: 'owner_approval_outcome',
            description:
              'Read your pending owner approval or its recorded outcome.',
            parameters: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
        },
        execute: async ({ run, args }) => {
          run.assertToolAllowed('app.approvals');
          await run.assertOperation('app', 'approvals');
          return approvalOutcome(
            {
              id: run.context.userId!,
              tenantId: run.context.tenantId!,
              scopes: [...run.permissions],
            },
            String(args.id),
          );
        },
      });
    }
    return tools;
  };
  const approvalOutcome = async (caller: McpAppPrincipal, id: string) => {
    if (!caller.id || !caller.tenantId)
      throw new Error('Authentication required');
    const record = await (await ready()).continuations.outcome(
      { id: caller.id, tenantId: caller.tenantId },
      id,
    );
    if (!caller.scopes?.includes(record.tool))
      throw new Error('Approval outcome scope required');
    return {
      id: record.id,
      status: record.status,
      summary: record.summary,
      result: record.result ?? null,
    };
  };

  const allowed = async (context: AssistantRequestContext) => {
    const host = await ready();
    const tools = await manifest(
      context.principal.tenantId,
      context.principal.userId,
      context.principal.permissions ??
        (context.event.locals as SmrtRuntimeLocals).permissions,
    );
    return [
      ...tools
        .filter(
          (t) =>
            !designRequests.has(context.event.request) || t.action === 'read',
        )
        .map((t) => t.slug),
      ...(await extra(context)).map((t) => t.slug),
    ];
  };
  // Exactly the execution memo generation. Never key a fallback by its resolved model.
  async function workModelConnectionKey(tenantId: string, ownerId: string) {
    const host = await ready();
    return `${(await cli.cliStatus('claude-code')).version ?? 'unknown'}:${await host.state.engineGeneration(tenantId, ownerId)}:${(await host.workProfiles.read()).revision ?? 'recommended'}`;
  }

  async function resolveProfile(
    context: AssistantRequestContext,
    profile?: WorkProfileName,
  ) {
    const host = await ready();
    const pinned = designRequests.get(context.event.request);
    if (pinned) return pinned.profile;
    const saved = await host.workProfiles.read();
    if (!profile) {
      const onboarding = host.onboarding
        ? await host.onboarding.load(context.event as RequestEvent)
        : null;
      profile =
        onboarding && (!onboarding.completed || onboarding.rerunning)
          ? 'design'
          : 'assist';
    }
    const engine =
      (await host.state.engine(
        context.principal.tenantId,
        context.principal.userId,
      )) ?? 'api';
    const selected = saved.settings[profile]?.engine ?? engine;
    return resolveWorkProfile({
      profile,
      engine,
      settings: saved.settings[profile],
      ...(selected === 'chatgpt'
        ? { catalog: await (await chatgpt()).models() }
        : {}),
    });
  }
  const workProfiles = {
    async read(event: RequestEvent) {
      const principal = resolveAssistantPrincipalFromLocals(event.locals);
      if (!principal) error(401, 'Sign in required');
      const saved = await (await ready()).workProfiles.read();
      const context = { event, principal } as AssistantRequestContext;
      const engine =
        (await (
          await ready()
        ).state.engine(principal.tenantId, principal.userId)) ?? 'api';
      const resolved = await Promise.all(
        (['design', 'assist', 'background'] as const).map(async (name) => {
          try {
            const profile = await resolveProfile(context, name);
            const projected =
              profile.engine === 'claude-code' &&
              profile.model &&
              ['fable', 'opus'].includes(profile.model)
                ? await projectWorkModelSelection({
                    profile,
                    ownerId: principal.userId,
                    connectionKey: await workModelConnectionKey(
                      principal.tenantId,
                      principal.userId,
                    ),
                    store: (await ready()).state.fallbackStore(
                      principal.tenantId,
                    ),
                  })
                : profile;
            return { ...projected, unavailable: false };
          } catch {
            const defaults = recommendedWorkProfile(name);
            const setting = saved.settings[name];
            return {
              ...defaults,
              ...setting,
              name,
              engine: setting?.engine ?? engine,
              tier:
                name === 'background' ? ('cheap' as const) : ('best' as const),
              budgets: { ...defaults.budgets, ...setting?.budgets },
              unavailable: true,
            };
          }
        }),
      );
      return {
        ...saved,
        resolved,
        editable: await isOwner(principal.tenantId, principal.userId),
      };
    },
    async write(
      event: RequestEvent,
      payload: { settings: WorkProfilePreferences; revision: string | null },
    ) {
      const principal = resolveAssistantPrincipalFromLocals(event.locals);
      if (!principal || !(await isOwner(principal.tenantId, principal.userId)))
        error(403, 'Owner required');
      if (
        !payload ||
        typeof payload !== 'object' ||
        !(payload.revision === null || typeof payload.revision === 'string')
      )
        error(400, 'Invalid settings');
      return (await ready()).workProfiles.write(
        payload.settings,
        payload.revision,
      );
    },
    async reset(event: RequestEvent, revision: string | null) {
      const principal = resolveAssistantPrincipalFromLocals(event.locals);
      if (!principal || !(await isOwner(principal.tenantId, principal.userId)))
        error(403, 'Owner required');
      if (!(revision === null || typeof revision === 'string'))
        error(400, 'Invalid revision');
      return (await ready()).workProfiles.reset(revision);
    },
  };
  const adapters = createInferenceAssistantAdapters({
    binding: async (c) =>
      (await ready()).state
        .engine(c.principal.tenantId, c.principal.userId)
        .then((v) => v ?? undefined),
    status: async (c) => ({
      cliStatus: cli.cliStatus,
      chatgpt: { status: async () => (await chatgpt()).status() },
      apiStatus: () => apiStatus(c),
      actions: { api: { label: 'Connect AI', href: '/settings/inference' } },
    }),
    chatgpt: async (context) => ({
      connection: await chatgpt(),
      fallback: {
        ownerId: context.principal.userId,
        connectionKey: `chatgpt:${JSON.stringify(await (await chatgpt()).models())}:${await (await ready()).state.engineGeneration(context.principal.tenantId, context.principal.userId)}:${(await (await ready()).workProfiles.read()).revision ?? 'recommended'}`,
        store: (await ready()).state.fallbackStore(context.principal.tenantId),
      },
      toolNamespace: { name: 'smrt_app', description: 'Work with this app' },
      settingsHref: '/settings',
    }),
    ...(options.assistant?.ai ? { api: options.assistant.ai } : {}),
    cli: (tool, context) =>
      createAgentCliTurnDriver({
        tool,
        bind: async (turn) => {
          const host = await ready();
          if (
            !(await isOwner(
              context.principal.tenantId,
              context.principal.userId,
            ))
          )
            throw new Error('Owner required');
          const local = await runtime.localRuntime();
          const holder = `assistant-${randomUUID()}`;
          const listeners = new Set<
            Parameters<AgentCliChatBinding['approvals']['subscribe']>[0]
          >();
          let tokenHash: string | undefined;
          const models = await manifest(
            context.principal.tenantId,
            context.principal.userId,
            [...(turn.permissions ?? [])],
          );
          const names = new Map([
            ...models
              .filter((t) => turn.tools.some((v) => v.slug === t.slug))
              .map((t) => [t.functionName!, t.slug] as const),
            ...turn.extraTools.map(
              (t) => [t.aiTool.function.name, t.slug] as const,
            ),
          ]);
          const credentials = tokenCredentials(async () => local.mcpTokens, {
            holder,
            scopes: [
              // Mint only tools actually offered by this MCP bridge, not the
              // larger API permission catalog (which can exceed the token bound).
              ...new Set(names.values()),
            ].filter((s) => !turn.permissions || turn.permissions.includes(s)),
            label: 'Assistant turn',
          });
          return {
            mcpUrl: new URL('/mcp', context.event.url).href,
            ...(designRequests.get(context.event.request)
              ? {
                  outputSchema: designRequests.get(context.event.request)!
                    .schema,
                }
              : {}),
            ...(turn.workProfile?.model &&
            ((tool === 'claude-code' &&
              ['fable', 'opus'].includes(turn.workProfile.model)) ||
              (tool === 'codex' &&
                nextWorkModel(
                  rankOpenAIWorkModels(
                    Object.keys(OPENAI_WORK_MODEL_RANKS).map((id) => ({ id })),
                  ),
                  turn.workProfile.model,
                )))
              ? {
                  fallback: {
                    ownerId: context.principal.userId,
                    connectionKey: await workModelConnectionKey(
                      context.principal.tenantId,
                      context.principal.userId,
                    ),
                    nextModel:
                      tool === 'claude-code'
                        ? turn.workProfile.model === 'fable'
                          ? 'opus'
                          : 'sonnet'
                        : nextWorkModel(
                            rankOpenAIWorkModels(
                              Object.keys(OPENAI_WORK_MODEL_RANKS).map(
                                (id) => ({ id }),
                              ),
                            ),
                            turn.workProfile.model,
                          )!,
                    store: host.state.fallbackStore(context.principal.tenantId),
                  },
                }
              : {}),
            canonicalToolName: (name) => names.get(name),
            describeTool: (name, args, outcome) => {
              const model = models.find((entry) => entry.slug === name);
              return describePublicAssistantTool(
                model?.functionName
                  ? `${model.functionName.slice(0, -(wireName(model.action).length + 1))}.${model.action}`
                  : name,
                args,
                outcome,
              );
            },
            allowTool: (name) => names.has(name),
            approvals: {
              subscribe: (listener) => {
                listeners.add(listener);
                let disposed = false;
                let polling = false;
                const poll = async () => {
                  if (disposed || polling) return;
                  polling = true;
                  try {
                    const records = await host.authority.list(
                      {
                        id: context.principal.userId,
                        tenantId: context.principal.tenantId,
                      },
                      false,
                    );
                    for (const record of records)
                      if (
                        !disposed &&
                        record.requestedBy === context.principal.userId &&
                        record.context.cliTurnId === holder &&
                        record.context.threadId === turn.thread?.id &&
                        record.status !== 'pending'
                      )
                        listener({
                          id: record.id,
                          status:
                            record.status === 'succeeded'
                              ? 'approved'
                              : record.status === 'expired'
                                ? 'timeout'
                                : record.status === 'executing'
                                  ? 'pending'
                                  : record.status,
                        });
                  } catch {
                    /* get() fails closed when the observer cannot read. */
                  } finally {
                    polling = false;
                  }
                };
                const timer = setInterval(() => {
                  void poll();
                }, 100);
                return () => {
                  disposed = true;
                  listeners.delete(listener);
                  clearInterval(timer);
                };
              },
              get: async (id) => {
                const record = await host.authority.get(
                  context.principal.tenantId,
                  id,
                );
                return record &&
                  record.requestedBy === context.principal.userId &&
                  record.context.cliTurnId === holder &&
                  record.context.threadId === turn.thread?.id
                  ? {
                      id,
                      status:
                        record.status === 'succeeded'
                          ? 'approved'
                          : record.status === 'executing'
                            ? 'pending'
                            : record.status === 'expired'
                              ? 'timeout'
                              : record.status,
                      summary: record.summary,
                      preview: null,
                    }
                  : null;
              },
            },
            deps: {
              locate: (selected) => locateCli(selected, cli.agentCliDeps()),
              stateDir: async () => local.paths.root,
              baseEnv: cli.agentCliDeps().env,
              credentials: {
                mint: async (pass) => {
                  const token = await credentials.mint(pass);
                  const verified = await runtime.verifyLocalMcpToken(token);
                  if (
                    verified?.id !== context.principal.userId ||
                    verified.tenantId !== context.principal.tenantId
                  ) {
                    await credentials.revoke();
                    throw new Error(
                      'The local credential does not match this turn',
                    );
                  }
                  tokenHash = digest(token);
                  turns.set(tokenHash, {
                    context,
                    turn,
                    id: holder,
                    toolCalls: 0,
                    startedAt: Date.now(),
                    approvalRequired: (id) => {
                      for (const listener of listeners)
                        listener({ id, status: 'pending' });
                    },
                  });
                  return token;
                },
                revoke: async () => {
                  if (tokenHash) turns.delete(tokenHash);
                  await credentials.revoke();
                },
              },
            },
          };
        },
      }),
  });
  const assistantRoutes = mountAssistantRoutes({
    runtime,
    resolvePrincipal: (event) => {
      const principal = resolveAssistantPrincipalFromLocals(event.locals);
      return principal
        ? {
            ...principal,
            permissions: [
              ...((event.locals as SmrtRuntimeLocals).permissions ?? []),
            ],
          }
        : null;
    },
    ...adapters,
    resolveWorkProfile: resolveProfile,
    internalTurn: (context) => {
      const design = designRequests.get(context.event.request);
      return design ? { userMessage: design.content } : undefined;
    },
    deferDesignTurn: (context) => !designRequests.has(context.event.request),
    onDesignEscalation: async (context, input) => {
      const original =
        input.userMessage ??
        [...(input.history ?? [])]
          .reverse()
          .find((message) => message.role === 'user')?.content;
      if (!input.thread?.id || typeof original !== 'string' || !original.trim())
        throw new Error('Design runs require a saved thread and user request');
      const host = await ready();
      const profile = await resolveProfile(context, 'design');
      const fixedPasses = Object.hasOwn(
        (await host.workProfiles.read()).settings.design?.budgets ?? {},
        'passes',
      );
      const state = await host.designRuns
        .forOwner(context.principal.userId, context.principal.tenantId)
        .start({
          threadId: String(input.thread.id),
          content: original,
          profile,
          fixedPasses,
          permissions: [...(context.principal.permissions ?? [])],
        });
      return { runId: state.id, message: 'Thinking this through' };
    },
    designTools: COOKBOOK_TOOL_NAMES.filter((name) =>
      /^(recipes\.(enable|disable|configure)|cookbook\.apply|app\.(add|remove|rename|hide))/.test(
        name,
      ),
    ),
    allowedTools: allowed,
    tools: (context) =>
      manifest(
        context.principal.tenantId,
        context.principal.userId,
        context.principal.permissions ??
          (context.event.locals as SmrtRuntimeLocals).permissions,
      ),
    extraTools: extra,
    approvalContinuations: async () => (await ready()).continuations,
    // These tools hold in their own canonical service; never create a second chat hold.
    approvalPolicy: {
      tools: Object.fromEntries(
        COOKBOOK_TOOL_NAMES.map((name) => [name, false]),
      ),
    },
    ...options.assistant,
    toolPresentation: 'generic',
    presentApproval: async (record) => {
      const binding = record.continuation?.principal;
      const client = Object.values(PLUGIN_CLIENTS).find(
        (label) => label === binding?.clientName,
      );
      if ((COOKBOOK_TOOL_NAMES as readonly string[]).includes(record.tool)) {
        let caption =
          client && record.summary.startsWith(`${client}: `)
            ? record.summary.slice(client.length + 2)
            : record.summary;
        if (record.tool === 'cookbook.apply') {
          const template = (
            (await ready()).catalog.cookbooks ?? BUNDLED_COOKBOOK_TEMPLATES
          ).find((entry) => entry.id === record.args.id);
          caption = template ? `Use ${template.name}.` : caption;
        } else if (
          ['recipes.enable', 'recipes.disable', 'recipes.configure'].includes(
            record.tool,
          )
        ) {
          const recipe = (await ready()).catalog.recipes.find(
            (entry) => entry.id === record.args.id,
          );
          if (recipe)
            caption = `${record.tool === 'recipes.enable' ? 'Enabled' : record.tool === 'recipes.disable' ? 'Disabled' : 'Configured'} ${recipe.label}.`;
        }
        const summary =
          record.tool === 'app.undo'
            ? record.status === 'succeeded'
              ? 'Reversed the last structure change'
              : 'Reverse the last structure change'
            : personChangeSummary(caption, record.status !== 'succeeded');
        return summary
          ? { summary: client ? `${client}: ${summary}` : summary }
          : undefined;
      }
      if (record.continuation?.executor !== 'model' || !binding)
        return undefined;
      const model = (
        await mcpModels(
          {
            id: record.requestedBy,
            tenantId: record.tenantId,
            scopes: binding.allowedTools,
          },
          true,
        )
      ).find((entry) => entry.tool.slug === record.tool);
      const action = model?.tool.action;
      if (
        !model?.noun ||
        !['delete', 'create', 'update'].includes(action ?? '') ||
        !personChangeSummary(`Added ${model.noun}.`)
      )
        return undefined;
      const verb =
        record.status === 'succeeded'
          ? action === 'delete'
            ? 'Deleted'
            : action === 'create'
              ? 'Added'
              : 'Updated'
          : action === 'delete'
            ? 'Delete'
            : action === 'create'
              ? 'Add'
              : 'Update';
      return { summary: `${client ? `${client}: ` : ''}${verb} ${model.noun}` };
    },
    describeTool: describePublicAssistantTool,
    systemPrompt: async (context) => {
      const base = options.assistant?.systemPrompt;
      const prompt =
        typeof base === 'function'
          ? await base(context)
          : (base ??
            "Help the owner work with their business records and installed recipes. Use only the provided tools and their inline inputs. Claim an operation only when it is offered for that list. When deletion is absent, explain the available update or custom actions from that list's tool schemas instead; never invent a delete operation or require the person to manage internal identity records.");
      const design = designRequests.get(context.event.request);
      return design ? `${prompt}\n\n${design.prompt}` : prompt;
    },
    formatAssistantReply: (content, context) => {
      if (!designRequests.has(context.event.request)) return { content };
      let output: unknown;
      try {
        output = JSON.parse(content);
      } catch {
        output = content;
      }
      return {
        content: 'I’m checking the requested changes.',
        metadata: { designOutput: output },
      };
    },
  });

  const designProgress = (
    state: import('@happyvertical/smrt-inference/server').DesignRunState | null,
  ) =>
    state
      ? presentCookbookDesignProgress(
          {
            runId: state.id,
            pass: {
              index: Math.min(
                state.passIndex + 1,
                Number(state.definition.split('/').at(-1)),
              ),
              count: Number(state.definition.split('/').at(-1)),
              name:
                state.passIndex === 0
                  ? 'Understand the request'
                  : state.passIndex === 1
                    ? 'Propose the design'
                    : 'Check and revise the design',
            },
            status: state.status,
            ...(state.note ? { note: state.note } : {}),
          },
          state,
        )
      : null;
  const assistantHandler = async (
    event: Parameters<typeof assistantRoutes.handle>[0],
  ) => {
    const path = event.params?.path ?? '';
    if (!path.startsWith('design-runs')) {
      const response = await assistantRoutes.handle(event);
      const decision = /^approvals\/([^/]+)\/decide$/.exec(path);
      const actor = resolveAssistantPrincipalFromLocals(event.locals);
      if (response.ok && decision && event.request.method === 'POST' && actor) {
        const host = await ready();
        const record = await host.authority.get(actor.tenantId, decision[1]);
        const action = record?.context.designAction as
          | { runId?: unknown }
          | undefined;
        if (
          record &&
          typeof action?.runId === 'string' &&
          ['succeeded', 'denied', 'failed', 'expired'].includes(record.status)
        ) {
          // Native decision is already durable. Queue only its deterministic
          // check; a status read can retry admission after a transient conflict.
          try {
            await host.designRuns
              .forOwner(record.requestedBy, record.tenantId)
              .resumeAfterApproval(action.runId);
          } catch {
            /* durable hold/outcome remains available */
          }
        }
      }
      return response;
    }
    const p = resolveAssistantPrincipalFromLocals(event.locals);
    if (!p || !(await isOwner(p.tenantId, p.userId)))
      return json({ code: 'not_allowed' }, 403);
    const runs = (await ready()).designRuns.forOwner(p.userId, p.tenantId);
    try {
      if (path === 'design-runs' && event.request.method === 'GET') {
        const threadId = event.url.searchParams.get('threadId');
        let state = threadId ? await runs.latest(threadId) : null;
        const pending =
          state?.input &&
          (state.input as { pendingApprovalId?: unknown }).pendingApprovalId;
        if (
          state?.status === 'waiting-approval' &&
          typeof pending === 'string'
        ) {
          const record = await (await ready()).authority.get(
            p.tenantId,
            pending,
          );
          if (
            record?.requestedBy === p.userId &&
            ['succeeded', 'denied', 'failed', 'expired'].includes(record.status)
          ) {
            try {
              state = await runs.resumeAfterApproval(state.id);
            } catch {
              /* retry on next status read */
            }
          }
        }
        return json({
          run: designProgress(state),
        });
      }
      if (path === 'design-runs' && event.request.method === 'POST') {
        if (event.request.headers.get('origin') !== event.url.origin)
          return json({ code: 'invalid_origin' }, 403);
        if (
          !/^application\/json\b/i.test(
            event.request.headers.get('content-type') ?? '',
          )
        )
          return json({ code: 'invalid_design_request' }, 415);
        // Chat's bounded JSON reader is private; keep this route's small bound
        // at its own request boundary rather than buffering an unbounded body.
        const maxBytes = 128 * 1024;
        if (Number(event.request.headers.get('content-length')) > maxBytes)
          return json({ code: 'payload_too_large' }, 413);
        const reader = event.request.body?.getReader();
        const decoder = new TextDecoder();
        let size = 0;
        let text = '';
        if (reader)
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) {
              await reader.cancel();
              return json({ code: 'payload_too_large' }, 413);
            }
            text += decoder.decode(value, { stream: true });
          }
        let body: Record<string, unknown> | null = null;
        try {
          const parsed: unknown = JSON.parse(text + decoder.decode());
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            body = parsed as Record<string, unknown>;
        } catch {
          return json({ code: 'invalid_design_request' }, 400);
        }
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).some(
            (key) => key !== 'threadId' && key !== 'content',
          ) ||
          typeof body.threadId !== 'string' ||
          !body.threadId ||
          body.threadId.length > 200 ||
          typeof body.content !== 'string' ||
          !body.content.trim() ||
          body.content.length > 32_000
        )
          return json({ code: 'invalid_design_request' }, 400);
        // Reuse chat's own session/thread ownership boundary before admission.
        const thread = await assistantRoutes.GET({
          ...event,
          request: new Request(event.request.url, {
            method: 'GET',
            headers: event.request.headers,
          }),
          params: {
            ...event.params,
            path: `threads/${encodeURIComponent(body.threadId)}/messages`,
          },
        });
        if (!thread.ok) return thread;
        const profile = await resolveProfile(
          { event, principal: p } as AssistantRequestContext,
          'design',
        );
        const state = await runs.start({
          threadId: body.threadId,
          content: body.content,
          profile,
          fixedPasses: Object.hasOwn(
            (await (await ready()).workProfiles.read()).settings.design
              ?.budgets ?? {},
            'passes',
          ),
          permissions: [
            ...(p.permissions ??
              (event.locals as SmrtRuntimeLocals).permissions ??
              []),
          ],
        });
        return json({ run: designProgress(state) }, 202);
      }
      const match = /^design-runs\/([^/]+)\/(stop|resume)$/.exec(path);
      if (!match || event.request.method !== 'POST')
        return json({ code: 'not_found' }, 404);
      if (event.request.headers.get('origin') !== event.url.origin)
        return json({ code: 'invalid_origin' }, 403);
      const saved = await (await ready()).workProfiles.read();
      const budgets = {
        ...recommendedWorkProfile('design').budgets,
        ...saved.settings.design?.budgets,
      };
      // Explicit Resume adopts the owner's current aggregate allowances, without
      // resetting usage or changing the run's pinned engine, model or passes.
      const state =
        match[2] === 'stop'
          ? await runs.stop(match[1])
          : await runs.resume(match[1], {
              maxTokens: budgets.maxRunTokens,
              maxDurationMs: budgets.runTimeoutMs,
            });
      return json({ run: designProgress(state) });
    } catch {
      return json({ code: 'design_run_unavailable' }, 409);
    }
  };
  const assistant = { ...assistantRoutes, handle: assistantHandler };
  assistant.GET = assistantHandler;
  assistant.POST = assistantHandler;

  const handle: Handle = (input) => {
    // Serve the browser's conventional icon request through the shipped icon.
    if (input.event.url.pathname === '/favicon.ico')
      return Promise.resolve(
        new Response(null, {
          status: 308,
          headers: {
            location: '/favicon.svg',
            'cache-control': 'public, max-age=86400',
          },
        }),
      );
    return runtime.handle({
      ...input,
      resolve: async (event, resolveOptions) => {
        origin = event.url.origin;
        const locals = event.locals as SmrtRuntimeLocals;
        if (locals.tenantId) {
          await prepare(locals.tenantId);
          const definition = publishedDefinitions
            .get(locals.tenantId)
            ?.find(
              (d) =>
                event.url.pathname === `/api/${d.name}` ||
                event.url.pathname.startsWith(`/api/${d.name}/`),
            );
          if (definition && locals.user?.id)
            return new APIGenerator(
              {
                basePath: '/api',
                authMiddleware: () => async (request) => request,
              },
              {
                tenantId: locals.tenantId,
                user: { id: locals.user.id },
                permissions: locals.permissions,
                db: runtime.databaseConfig(),
              },
            ).generateHandler()(event.request);
        }
        return input.resolve(event, resolveOptions);
      },
    });
  };
  const session = createSessionLayoutLoad();
  const assistantToolCatalog = async (actor: {
    id: string;
    tenantId: string;
  }): Promise<NonNullable<PluginModeState['tools']>> =>
    runtime.runAsPrincipal(actor, async (bound) => {
      const host = await prepare(actor.tenantId);
      const scopes = [...(bound?.scopes ?? [])];
      const context = {
        principal: {
          userId: actor.id,
          tenantId: actor.tenantId,
          permissions: scopes,
        },
      } as AssistantRequestContext;
      const shell = buildCookbookShell({
        cookbook: host.state.engineFor(actor)!.cookbook(),
        catalog: host.catalog,
      });
      const nativeDefinitions = new Map(
        (
          await host.service.list({
            surface: 'assistant',
            tenantId: actor.tenantId,
            userId: actor.id,
          })
        ).map((tool) => [tool.name as string, tool.annotations]),
      );
      return [
        ...(await manifest(actor.tenantId, actor.id, scopes)).map((tool) => ({
          definition: manifestToolToAITool(tool, actor.tenantId).function,
          source: 'model' as const,
          annotations: {
            readOnlyHint: tool.action === 'read',
            destructiveHint: requiresOwnerApproval(tool, {}),
            idempotentHint: tool.action === 'read',
            openWorldHint: false as const,
          },
          model: tool.qualifiedName ?? tool.className,
          operation: tool.action,
          recipe:
            [...shell.entries.values()].find(
              (entry) =>
                ObjectRegistry.getClass(entry.model.id)?.qualifiedName ===
                ObjectRegistry.getClass(tool.qualifiedName ?? tool.className)
                  ?.qualifiedName,
            )?.recipeId ?? undefined,
        })),
        ...(await extra(context))
          .filter((tool) => scopes.includes(tool.slug))
          .map((tool) => ({
            definition: tool.aiTool.function,
            annotations: nativeDefinitions.get(tool.slug),
            source:
              tool.slug === 'app.approvals'
                ? ('lifecycle' as const)
                : tool.slug.startsWith('app.')
                  ? ('app' as const)
                  : ('recipe' as const),
          })),
      ];
    });
  const pluginMode = createPluginMode({
    runtime,
    sourceRoot: options.root ?? process.cwd(),
    name: options.application ?? 'smrt-app',
    state: async () => (await ready()).state,
    tools: assistantToolCatalog,
    authorize: async (event) => {
      const p = resolveAssistantPrincipalFromLocals(event.locals);
      if (!p) return null;
      const local = await runtime.localRuntime();
      const id = event.cookies.get(runtime.sessionCookie.name);
      const restored = id ? await local.restoreSession(id) : null;
      if (
        !restored ||
        restored.user.id !== p.userId ||
        restored.tenantId !== p.tenantId ||
        restored.parent ||
        restored.permissionCeiling !== null ||
        !['local-bootstrap', 'password', 'passkey'].includes(
          restored.authMethod ?? '',
        )
      )
        return null;
      if (
        !(await local.mcpTokens?.isOwnerSession?.({
          userId: p.userId,
          tenantId: p.tenantId,
        }))
      )
        return null;
      return { id: p.userId, tenantId: p.tenantId };
    },
  });
  async function load(event: Parameters<typeof session>[0]): Promise<
    Awaited<ReturnType<typeof session>> & {
      assistantToolCatalog: NonNullable<PluginModeState['tools']>;
      dynamicDefinitions: AppModelSnapshot['webDefinitions'];
      enabledModels: string[];
      cookbookApp: CookbookAppData;
      onboarding: OnboardingState | null;
      assistantIntroduction:
        | { lists: string[]; actions: string[]; configured: boolean }
        | undefined;
      embed: boolean;
    }
  > {
    const data = await session(event);
    const host = await ready();
    const tenantId = (event.locals as SmrtRuntimeLocals).tenantId;
    const engine = tenantId ? host.state.engineFor({ tenantId }) : undefined;
    const snapshot = engine?.snapshot();
    const visible = snapshot
      ? filterRuntimeCookbookSnapshot(snapshot, host.catalog, { tenantId })
      : undefined;
    const p = resolveAssistantPrincipalFromLocals(event.locals);
    const onboarding =
      p && host.onboarding ? await host.onboarding.load(event) : null;
    const allowedSlugs = p
      ? new Set(
          await allowed({ event, principal: p } as AssistantRequestContext),
        )
      : new Set<string>();
    const offered = p
      ? (await manifest(p.tenantId, p.userId, [...allowedSlugs])).filter((t) =>
          allowedSlugs.has(t.slug),
        )
      : [];
    const extras = p
      ? await host.service.list({
          surface: 'assistant',
          tenantId: p.tenantId,
          userId: p.userId,
        })
      : [];
    const connectStatus = p ? await connectAi.GET(event as RequestEvent) : null;
    const connected = connectStatus?.ok
      ? (await connectStatus.json()).configured === true
      : false;
    const introductionShell =
      engine && visible
        ? buildCookbookShell({
            cookbook: {
              ...engine.cookbook(),
              recipes: visible.recipes.map((recipe) => recipe.id),
              features: visible.features,
            },
            catalog: host.catalog,
          })
        : null;
    const navigation = introductionShell
      ? applyShellLayout(
          [],
          introductionShell.navGroups,
          undefined,
          introductionShell.layout,
        )
      : null;
    return {
      assistantToolCatalog:
        p && tenantId && (await isOwner(tenantId, p.userId))
          ? await assistantToolCatalog({ id: p.userId, tenantId })
          : [],
      ...data,
      embed: p ? await host.state.embed(p.tenantId, p.userId) : false,
      onboarding,
      assistantIntroduction: p
        ? {
            lists: navigation
              ? [
                  ...navigation.nav,
                  ...navigation.groups.flatMap((group) =>
                    group.items.slice(0, 1),
                  ),
                  ...navigation.groups.flatMap((group) => group.items.slice(1)),
                ].map((item) => item.label)
              : [],
            actions: [
              ...new Set(
                offered
                  .map((t) => t.action)
                  .filter(
                    (a) =>
                      ['read', 'create', 'update', 'delete'].includes(a) &&
                      offered.every((tool) =>
                        offered.some(
                          (candidate) =>
                            candidate.collection === tool.collection &&
                            candidate.action === a,
                        ),
                      ),
                  ),
              ),
              ...(extras.some((t) => t.name === 'app.addList')
                ? ['customize']
                : []),
            ],
            configured: connected,
          }
        : undefined,
      dynamicDefinitions: tenantId
        ? (publishedDefinitions.get(tenantId) ?? [])
        : [],
      enabledModels: filterRuntimeExposure(
        host.catalog.models,
        (m) => ObjectRegistry.getExposureModel(m.id),
        { surface: 'screen', tenantId },
      ).map((m) => ObjectRegistry.getClass(m.id)?.qualifiedName ?? m.id),
      cookbookApp: {
        cookbook: {
          ...(engine?.cookbook() ?? host.cookbook),
          recipes: visible?.recipes.map((r) => r.id) ?? [],
          features: visible?.features ?? [],
        },
        catalog: host.catalog,
        warnings: [],
      } satisfies CookbookAppData,
    };
  }
  const connectAi = mountConnectAiRoutes<RequestEvent>({
    authorize: async (event) => {
      const principal = resolveAssistantPrincipalFromLocals(event.locals);
      if (
        !principal ||
        !(await isOwner(principal.tenantId, principal.userId)) ||
        !(event.locals as SmrtRuntimeLocals).permissions?.includes(
          'inference.customize',
        )
      )
        return null;
      const host = await ready();
      return {
        engine: () => host.state.engine(principal.tenantId, principal.userId),
        select: (engine) =>
          host.state.select(principal.tenantId, principal.userId, engine),
        cli,
        chatgpt: await chatgpt(),
        apiStatus: () => apiStatus({ event, principal }),
      };
    },
  });

  return {
    runtime,
    handle,
    init: async () => {
      await ready();
    },
    shutdown,
    load,
    assistant,
    connectAi,
    pluginMode: pluginMode.handle,
    inferenceSettings,
    workProfiles,
    async history(event: RequestEvent) {
      if (event.request.method !== 'GET')
        return json({ code: 'method_not_allowed' }, 405);
      const principal = resolveAssistantPrincipalFromLocals(event.locals);
      if (!principal || !(await isOwner(principal.tenantId, principal.userId)))
        return json({ code: 'not_allowed' }, 403);
      const snapshot =
        principal.permissions ??
        (event.locals as SmrtRuntimeLocals).permissions ??
        [];
      if (!snapshot.includes('app.history'))
        return json({ code: 'not_allowed' }, 403);
      try {
        return await runtime.runAsPrincipal(
          {
            id: principal.userId,
            tenantId: principal.tenantId,
            kind: 'human',
            scopes: [...snapshot],
          },
          async () => {
            const host = await prepare(principal.tenantId, false);
            const result = await host.service.invoke(
              'app.history',
              {},
              {
                surface: 'mcp',
                tenantId: principal.tenantId,
                userId: principal.userId,
              },
            );
            if (result.status !== 'ok' || !Array.isArray(result.changes))
              throw new Error('History unavailable');
            const entries = result.changes
              .flatMap((value: unknown) => {
                if (!value || typeof value !== 'object') return [];
                const row = value as Record<string, unknown>;
                if (!Number.isSafeInteger(row.revision)) return [];
                return [
                  {
                    id: String(row.revision),
                    action:
                      (row.change as { type?: unknown } | undefined)?.type ===
                      'undo'
                        ? 'Reversed the last structure change'
                        : (personChangeSummary(row.summary) ??
                          'Changed your app'),
                    resourceType: 'Your app',
                    resourceId: 'Changes',
                    ...(row.actor === principal.userId
                      ? { actorLabel: 'You' }
                      : {}),
                    ...(row.status === 'pending'
                      ? { reason: 'Activation pending' }
                      : {}),
                  },
                ];
              })
              .reverse();
            return json({ revision: result.revision, entries });
          },
        );
      } catch {
        return json({ code: 'history_unavailable' }, 403);
      }
    },
    async onboarding(event: RequestEvent) {
      const mounted = (await ready()).onboarding;
      return mounted ? mounted.handle(event) : json({ code: 'not_found' }, 404);
    },
    async modelEditor(tenantId: string) {
      await prepare(tenantId);
      return editors.get(tenantId);
    },
    ownerLink: createOwnerLinkHandler(runtime, { autoClaim: true }),
    /** Request-scoped: never pass a browser tenant id or retain this across requests. */
    async cookbookApp(tenantId: string) {
      const host = await ready();
      const engine = host.state.engineFor({ tenantId });
      if (!engine) throw new Error('Cookbook unavailable');
      const visible = filterRuntimeCookbookSnapshot(
        engine.snapshot(),
        host.catalog,
        { tenantId },
      );
      return {
        cookbook: {
          ...engine.cookbook(),
          recipes: visible.recipes.map((r) => r.id),
          features: visible.features,
        },
        catalog: host.catalog,
        warnings: [],
      };
    },
    async prebuilt(event: RequestEvent) {
      const p = resolveAssistantPrincipalFromLocals(event.locals);
      if (!p || !(await isOwner(p.tenantId, p.userId)))
        return json({ code: 'not_allowed' }, 403);
      const host = await ready();
      if (event.request.method === 'GET')
        return json(await host.preferences.read());
      if (event.request.method !== 'POST')
        return json({ code: 'method_not_allowed' }, 405);
      if (event.request.headers.get('origin') !== event.url.origin)
        return json({ code: 'invalid_origin' }, 403);
      if (
        event.request.headers.get('content-type')?.split(';')[0].trim() !==
        'application/json'
      )
        return json({ code: 'invalid_request' }, 415);
      const reader = event.request.body?.getReader();
      if (!reader) return json({ code: 'invalid_request' }, 400);
      let body: { enabled?: unknown; revision?: unknown };
      try {
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 4096) {
            await reader.cancel();
            return json({ code: 'body_too_large' }, 413);
          }
          chunks.push(part.value);
        }
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json({ code: 'invalid_request' }, 400);
      } finally {
        reader.releaseLock();
      }
      if (
        !body ||
        Array.isArray(body) ||
        typeof body !== 'object' ||
        Object.keys(body).some(
          (key) => !['enabled', 'revision'].includes(key),
        ) ||
        typeof body.enabled !== 'boolean' ||
        !(body.revision === null || typeof body.revision === 'string')
      )
        return json({ code: 'invalid_request' }, 400);
      try {
        const result = await host.preferences.write(
          body.enabled,
          body.revision,
        );
        return json(result, result.ok ? 200 : 409);
      } catch (error) {
        return json(
          { code: 'not_allowed' },
          (error as Error).name === 'PreferenceAccessError' ? 403 : 503,
        );
      }
    },
    async mcp(event: RequestEvent) {
      const host = await ready();
      const bearer = event.request.headers
        .get('authorization')
        ?.match(/^Bearer (.+)$/i)?.[1];
      const locals = event.locals as SmrtRuntimeLocals;
      // This one delegation scope grants only the live app tool surface, not
      // arbitrary owner permissions. Ordinary operation-scoped tokens stay narrow.
      let pluginDelegated = false;
      const verifyPluginToken = async (token: string) => {
        const verified = await runtime.verifyLocalMcpToken(token);
        if (!verified) return null;
        const local = await runtime.localRuntime();
        const issued = verified.tokenId
          ? (await local.mcpTokens?.list())?.find(
              (record) => record.id === verified.tokenId,
            )
          : undefined;
        // Opt-in follows the issued ceiling, never a live intersection that
        // shrank after permission removal. A mixed token must stay narrow.
        if (!issued)
          return verified.scopes.length === 1 &&
            verified.scopes[0] === PLUGIN_PERMISSION
            ? null
            : verified;
        if (issued.status !== 'active') return null;
        if (
          issued.scopes.length !== 1 ||
          issued.scopes[0] !== PLUGIN_PERMISSION
        )
          return verified;
        if (!verified.scopes.includes(PLUGIN_PERMISSION)) return null;
        pluginDelegated = true;
        if (
          !(await local.mcpTokens?.isOwnerSession?.({
            userId: verified.id,
            tenantId: verified.tenantId,
          }))
        )
          return null;
        return runtime.runAsPrincipal(verified, async () => {
          await prepare(verified.tenantId);
          const held = (
            await (
              await PermissionResolver.create({ db: await runtime.database() })
            ).resolvePermissions(verified.id, verified.tenantId)
          ).permissions;
          const offered = new Set([
            ...(await manifest(verified.tenantId, verified.id, [...held])).map(
              (tool) => tool.slug,
            ),
            ...(
              await extra({
                principal: {
                  userId: verified.id,
                  tenantId: verified.tenantId,
                  permissions: [...held],
                },
              } as AssistantRequestContext)
            ).map((tool) => tool.slug),
          ]);
          return {
            ...verified,
            ...(verified.clientName ? { clientName: verified.clientName } : {}),
            scopes: [...held].filter((scope) => offered.has(scope)),
          };
        });
      };
      const verified = bearer ? await verifyPluginToken(bearer) : null;
      const clientName = verified?.clientName;
      const principal: McpAppPrincipal | null = verified
        ? { ...verified, scopes: [...verified.scopes] }
        : !bearer && locals.user?.id && locals.tenantId
          ? {
              id: locals.user.id,
              tenantId: locals.tenantId,
              kind: 'human',
              scopes: locals.permissions,
            }
          : null;
      const binding = bearer ? turns.get(digest(bearer)) : undefined;
      if (binding?.turn.signal.aborted)
        return json({ code: 'turn_ended' }, 401);
      let workflows: McpWorkflowToolDefinition[] = [];
      if (principal?.id && principal.tenantId)
        await runtime.runAsPrincipal(
          { ...principal, id: principal.id },
          async (bound) => {
            await prepare(principal.tenantId!);
            const scope = new Set(bound?.scopes ?? []);
            const modelTools = (
              pluginDelegated || binding
                ? []
                : await mcpModels(
                    { ...principal, scopes: [...scope] },
                    !!binding,
                  )
            ).filter(
              (t) =>
                !binding ||
                binding.turn.tools.some((v) => v.slug === t.tool.slug),
            );
            const recipeTools = await host.service.list({
              surface: pluginDelegated || binding ? 'assistant' : 'mcp',
              tenantId: principal.tenantId,
              userId: principal.id,
            });
            const specs = [
              ...(pluginDelegated || binding
                ? (
                    await manifest(principal.tenantId!, principal.id!, [
                      ...scope,
                    ])
                  )
                    .filter((tool) => scope.has(tool.slug))
                    .map((tool) => ({
                      name: tool.functionName!,
                      slug: tool.slug,
                      ai: manifestToolToAITool(tool, principal.tenantId),
                      model: tool,
                      generator: undefined,
                      annotations: {
                        readOnlyHint: tool.action === 'read',
                        destructiveHint: requiresOwnerApproval(tool, {}),
                        idempotentHint: tool.action === 'read',
                        openWorldHint: false,
                      },
                    }))
                : []),
              ...modelTools.map(({ tool, descriptor, generator }) => ({
                name: descriptor.name,
                slug: tool.slug,
                ai: {
                  function: {
                    description: descriptor.description,
                    parameters: descriptor.inputSchema,
                  },
                },
                model: tool,
                generator,
                annotations: descriptor.annotations,
              })),
              ...recipeTools
                .filter(
                  (t) =>
                    scope.has(t.name) &&
                    (!binding ||
                      binding.turn.extraTools.some((v) => v.slug === t.name)),
                )
                .map((tool) => ({
                  name: wireName(tool.name),
                  slug: tool.name,
                  ai: {
                    function: {
                      description: tool.description,
                      parameters: tool.inputSchema,
                    },
                  },
                  model: undefined,
                  generator: undefined,
                  annotations: tool.annotations,
                })),
            ];
            const names = new Set<string>();
            workflows = specs.map((spec) => {
              const name = spec.name;
              if (names.has(name))
                throw new Error('Conflicting MCP tool aliases');
              names.add(name);
              const destructive =
                spec.annotations?.destructiveHint === true ||
                (!!spec.model && requiresOwnerApproval(spec.model, {}));
              return {
                name,
                description: spec.ai.function.description ?? spec.slug,
                inputSchema: spec.ai.function.parameters ?? { type: 'object' },
                outputSchema: { type: 'object', additionalProperties: true },
                effect: destructive
                  ? 'destructive'
                  : spec.annotations?.readOnlyHint === true
                    ? 'read'
                    : 'write',
                ...(spec.annotations &&
                'workProfile' in spec.annotations &&
                spec.annotations.workProfile === 'design'
                  ? { metadata: { workProfile: spec.annotations.workProfile } }
                  : {}),
                idempotent: spec.annotations?.idempotentHint === true,
                openWorld: spec.annotations?.openWorldHint === true,
                mapError: (error) =>
                  error instanceof CookbookToolError
                    ? { code: error.code, message: error.publicMessage }
                    : undefined,
                execute: async ({ arguments: args, principal: caller }) => {
                  if (
                    !caller?.id ||
                    !caller.tenantId ||
                    caller.id !== principal.id ||
                    caller.tenantId !== principal.tenantId
                  )
                    throw new Error('Principal changed');
                  binding?.turn.beforeToolExecution(spec.slug);
                  if (binding) {
                    const budget = binding.turn.workProfile?.budgets;
                    if (
                      budget &&
                      (binding.toolCalls >= budget.maxSteps ||
                        Date.now() - binding.startedAt >= budget.turnTimeoutMs)
                    )
                      throw new Error(
                        'This pass has reached its tool or time limit',
                      );
                    if (
                      designRequests.has(binding.context.event.request) &&
                      spec.annotations?.readOnlyHint !== true
                    )
                      throw new Error(
                        'Design passes can only read and propose',
                      );
                    binding.toolCalls += 1;
                  }
                  const tool = spec.model;
                  if (tool && !isManifestToolEnabled(tool, caller.tenantId))
                    throw new Error('Tool disabled');
                  if (
                    tool &&
                    (requiresOwnerApproval(tool, args) ||
                      spec.annotations?.destructiveHint === true)
                  ) {
                    const input = {
                      tenantId: caller.tenantId,
                      requestedBy: caller.id,
                      tool: spec.slug,
                      callId: randomUUID(),
                      args,
                      summary: describeAssistantTool(
                        tool.functionName
                          ? `${tool.functionName.slice(0, -(wireName(tool.action).length + 1))}.${tool.action}`
                          : spec.slug,
                        args,
                      ),
                      context: binding?.turn.thread
                        ? {
                            principal: binding.context.principal,
                            cliTurnId: binding.id,
                            threadId: binding.turn.thread.id,
                            agentSessionId: binding.turn.thread.agentSessionId,
                            originMessageId: binding.turn.originMessageId,
                            allowedTools:
                              binding.turn.principal.allowedTools ?? [],
                            permissionCeiling: binding.turn.permissions ?? [
                              ...scope,
                            ],
                            driver: 'external',
                          }
                        : pluginDelegated
                          ? { pluginMode: true }
                          : {},
                    };
                    const hold = await host.continuations.capture(
                      {
                        id: caller.id,
                        tenantId: caller.tenantId,
                        permissions: [...(caller.scopes ?? [])],
                        allowedTools: [spec.slug],
                        ...(clientName ? { clientName } : {}),
                      },
                      () =>
                        host.continuations
                          .adapter('model', 'continuation')
                          .request(input),
                    );
                    const result = {
                      status: 'approval_required',
                      message: `Waiting for the owner's approval in ${options.title ?? 'this app'}.`,
                      approvalId: hold.id,
                      summary: hold.summary,
                      ...(!binding
                        ? { outcomeTool: 'owner_approval_outcome' }
                        : {}),
                    };
                    // Publish the canonical persisted hold before the fast MCP
                    // response can outrun the background status poll.
                    binding?.approvalRequired(hold.id);
                    return {
                      content: [{ type: 'text', text: JSON.stringify(result) }],
                      structuredContent: result,
                    };
                  }
                  if (tool)
                    return executeAsPrincipal(
                      {
                        principal: {
                          runAsUserId: caller.id,
                          tenantId: caller.tenantId,
                          allowedTools: [spec.slug],
                        },
                        db: runtime.databaseConfig(),
                        permissions: caller.scopes,
                      },
                      async (run) => {
                        run.assertToolAllowed(spec.slug);
                        await run.assertOperation(tool.collection, tool.action);
                        if (spec.generator)
                          return spec.generator.handleToolCall({
                            method: 'tools/call',
                            params: { name, arguments: args },
                          });
                        const value = await invokeManifestTool(
                          run,
                          tool,
                          args,
                          {
                            db:
                              run.context.database ?? runtime.databaseConfig(),
                          },
                        );
                        const result =
                          value &&
                          typeof value === 'object' &&
                          !Array.isArray(value)
                            ? value
                            : { result: value };
                        return {
                          content: [
                            {
                              type: 'text' as const,
                              text: JSON.stringify(result),
                            },
                          ],
                          structuredContent: result,
                        };
                      },
                    );
                  const result = await host.continuations.capture(
                    {
                      id: caller.id,
                      tenantId: caller.tenantId,
                      permissions: [...(caller.scopes ?? [])],
                      allowedTools: [spec.slug],
                      ...(clientName ? { clientName } : {}),
                    },
                    () =>
                      host.service.invoke(
                        spec.slug as Parameters<typeof host.service.invoke>[0],
                        args,
                        {
                          surface: 'mcp',
                          tenantId: caller.tenantId,
                          userId: caller.id,
                        },
                      ),
                  );
                  const presented =
                    result.status === 'approval_required'
                      ? {
                          ...result,
                          message: `Waiting for the owner's approval in ${options.title ?? 'this app'}.`,
                          outcomeTool: 'owner_approval_outcome',
                        }
                      : result;
                  return {
                    content: [
                      { type: 'text', text: JSON.stringify(presented) },
                    ],
                    structuredContent: presented,
                  };
                },
              };
            });
            if (
              (!pluginDelegated || scope.has('app.approvals')) &&
              (!binding ||
                binding.turn.extraTools.some(
                  (tool) => tool.slug === 'app.approvals',
                )) &&
              (
                await host.authority.list(
                  { id: principal.id!, tenantId: principal.tenantId! },
                  false,
                )
              ).some((r) => r.requestedBy === principal.id)
            )
              workflows.push({
                name: 'owner_approval_outcome',
                description:
                  'Read your pending owner approval or its recorded outcome.',
                inputSchema: {
                  type: 'object',
                  properties: { id: { type: 'string' } },
                  required: ['id'],
                  additionalProperties: false,
                },
                outputSchema: { type: 'object', additionalProperties: true },
                effect: 'read',
                idempotent: true,
                openWorld: false,
                execute: async ({ arguments: args, principal: caller }) => {
                  if (!caller?.id || !caller.tenantId)
                    throw new Error('Authentication required');
                  const result = await approvalOutcome(caller, String(args.id));
                  return {
                    content: [{ type: 'text', text: JSON.stringify(result) }],
                    structuredContent: result,
                  };
                },
              });
          },
        );
      return mountMcpAppRoute({
        runtime: { ...runtime, verifyLocalMcpToken: verifyPluginToken },
        models: [],
        requiredScopes: [],
        workflowTools: workflows,
        toolListCache: { ttlMs: 0, cacheScope: 'private' },
      })({ ...event, locals: { ...event.locals } });
    },
    dispose() {
      process.removeListener('sveltekit:shutdown', onShutdown);
      // Release this database's design-run executor now so a replacement host
      // can install its own; the task runner stops through the shared shutdown.
      disposeDesignRuns?.();
      void shutdown().catch(() => {});
      current?.gate.dispose?.();
      setRuntimeExposureGate(undefined);
      setCookbookToolService(undefined);
      turns.clear();
    },
  };
}

/** Mount the ordinary cookbook model page with the live session gate. */
export async function loadCookbookModelPage({
  params,
  parent,
  locals,
  url,
}: Parameters<ServerLoad>[0]) {
  const session = locals as SmrtRuntimeLocals;
  if (!session.user) redirect(303, '/setup');
  const { cookbookApp } = (await parent()) as { cookbookApp?: CookbookAppData };
  if (!cookbookApp) error(404, 'This app has no cookbook.');
  const shell = buildCookbookShell({
    cookbook: cookbookApp.cookbook,
    catalog: cookbookApp.catalog,
  });
  const id = `item:${params.pkg}:${params.model}${params.key ? `:${params.key}` : ''}`;
  const entry = shell.entries.get(id);
  if (!entry) error(404, 'This page is not in your app.');
  if (
    !isRuntimeModelEnabled(ObjectRegistry.getExposureModel(entry.model.id), {
      surface: 'screen',
      tenantId: session.tenantId,
    })
  )
    error(404, 'This page is not enabled.');
  return {
    recordId: url?.searchParams.get('record') ?? null,
    referenceHrefs: Object.fromEntries(
      [...shell.entries.values()]
        .filter((candidate) => !candidate.filter)
        .map((candidate) => [
          ObjectRegistry.getClass(candidate.model.id)?.qualifiedName ??
            candidate.model.id,
          candidate.href.replace(/(.)\/$/, '$1'),
        ]),
    ),
    entry: {
      id: entry.id,
      label: entry.label,
      description: entry.description,
      noun: entry.noun ?? null,
      filter: entry.filter ?? null,
      model:
        ObjectRegistry.getClass(entry.model.id)?.qualifiedName ??
        entry.model.id,
      className: entry.model.name,
    },
    permissions: session.permissions,
  };
}
