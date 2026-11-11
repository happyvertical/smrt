/** Documented local SvelteKit composition over the existing runtime and cookbook APIs. */

import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeAsPrincipal } from '@happyvertical/smrt-agents';
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
  requiresOwnerApproval,
} from '@happyvertical/smrt-chat';
import {
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
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
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
  createInferenceSettingsController,
  createInferenceSettingsHost,
  INFERENCE_PERMISSION_DEFINITIONS,
  inferencePreferenceKind,
  locateCli,
  tokenCredentials,
} from '@happyvertical/smrt-inference/server';
import {
  createPrebuiltComponentsPreference,
  createPreferenceStore,
  getPreferencePrincipal,
  registerPreferenceKind,
} from '@happyvertical/smrt-preferences';
import { mountConnectAiRoutes } from '@happyvertical/smrt-svelte/connect-ai/server';
import {
  buildCookbookShell,
  type CookbookAppData,
  catalogFromManifests,
  readInstalledManifests,
} from '@happyvertical/smrt-svelte/cookbook/server';
import type { OnboardingState } from '@happyvertical/smrt-svelte/onboarding';
import type { Cookbook } from '@happyvertical/smrt-types';
import {
  PermissionResolver,
  RolePermissionCollection,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users';
import type { Handle, RequestEvent, ServerLoad } from '@sveltejs/kit';
import { error, redirect } from '@sveltejs/kit';
import { createCookbookOnboarding } from './onboarding.js';
import { createCookbookHostState } from './state.js';

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
      const catalog = catalogFromManifests(manifests);
      const checked = validateCookbook(
        JSON.parse(await readFile(join(root, 'smrt.cookbook.json'), 'utf8')),
        { recipes: catalog.recipes.map((r) => r.id) },
      );
      if (!checked.ok) throw new Error(checked.errors.join('; '));
      // Preserve recipe search/help metadata from installed manifests.
      const recipes = manifests.flatMap((m) =>
        Array.isArray(m.recipes) ? m.recipes : [],
      );
      return {
        cookbook: checked.cookbook,
        catalog: {
          ...catalog,
          recipes: catalog.recipes.map((r) => ({
            ...recipes.find((raw) => raw.id === r.id),
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
  registerPermissionDefinitions([...INFERENCE_PERMISSION_DEFINITIONS]);
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
  const turns = new Map<
    string,
    {
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
    const app = { ...(await readHostApp(options)) };
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
    const continuations = new OwnerApprovalContinuations(authority, {
      cookbook: async (record) =>
        executeSaved(record, async () =>
          service.invoke(
            record.tool as Parameters<typeof service.invoke>[0],
            { ...record.args, approvalId: record.id },
            {
              surface: 'mcp',
              tenantId: record.tenantId,
              userId: record.requestedBy,
            },
          ),
        ),
      model: async (record) =>
        executeSaved(record, async (run) => {
          const tool = manifest(record.tenantId).find(
            (t) => t.slug === record.tool,
          );
          if (!tool) throw new Error('Approved tool is no longer offered');
          return invokeManifestTool(run, tool, record.args, {
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
      // Conservative: replacing a template always needs owner approval. No unproven empty-data shortcut.
      isAppEmpty: async () => false,
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
          invoke: async (actor, name, args) => {
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
              () => service.invoke(name, args, { ...actor, surface: 'mcp' }),
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
    return {
      ...app,
      onboarding,
      state,
      authority,
      continuations,
      preferences,
      service,
      gate,
    };
  }
  const ready = () =>
    (starting ??= initialize().then((value) => (current = value)));
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
            await host.continuations.resume(owner, record.id);
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
  const manifest = (tenantId: string): ManifestTool[] =>
    buildManifestToolCatalog({ all: true }).filter((tool) =>
      isManifestToolEnabled(tool, tenantId),
    );
  const mcpModels = async (principal: McpAppPrincipal) => {
    const host = await ready();
    const generator = new MCPGenerator(
      {
        classNames: host.catalog.models.map((model) => model.id),
        qualifyCollidingNames: true,
      },
      {
        db: runtime.databaseConfig(),
        tenantId: principal.tenantId,
        user: { id: principal.id! },
        permissions: principal.scopes,
      },
    );
    const manifestTools = manifest(principal.tenantId!);
    const tools = await generator.generateTools();
    return tools.flatMap((descriptor) => {
      if ((COOKBOOK_TOOL_NAMES as readonly string[]).includes(descriptor.name))
        return [];
      const identity = generator.getToolIdentity(descriptor);
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
        ? [{ descriptor, tool, generator }]
        : [];
    });
  };
  const extra = async (context: AssistantRequestContext) => {
    const host = await ready();
    return (
      await host.service.assistantTools({
        surface: 'assistant',
        tenantId: context.principal.tenantId,
        userId: context.principal.userId,
      })
    ).map((tool) => ({
      ...tool,
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
  };
  const allowed = async (context: AssistantRequestContext) => [
    ...manifest(context.principal.tenantId).map((t) => t.slug),
    ...(await extra(context)).map((t) => t.slug),
  ];
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
    chatgpt: async () => ({
      connection: await chatgpt(),
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
          let tokenHash: string | undefined;
          const models = await mcpModels({
            id: context.principal.userId,
            tenantId: context.principal.tenantId,
            scopes: [...(turn.permissions ?? [])],
          });
          const names = new Map([
            ...models
              .filter((t) => turn.tools.some((v) => v.slug === t.tool.slug))
              .map((t) => [t.descriptor.name, t.tool.slug] as const),
            ...turn.extraTools.map((t) => [wireName(t.slug), t.slug] as const),
          ]);
          const credentials = tokenCredentials(async () => local.mcpTokens, {
            holder,
            scopes: [
              ...new Set(
                [...turn.tools, ...turn.extraTools].map((t) => t.slug),
              ),
            ].filter((s) => !turn.permissions || turn.permissions.includes(s)),
            label: 'Assistant turn',
          });
          return {
            mcpUrl: new URL('/mcp', context.event.url).href,
            canonicalToolName: (name) => names.get(name),
            allowTool: (name) => names.has(name),
            approvals: {
              subscribe: (listener) => {
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
                        record.context.threadId === turn.thread?.id
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
                mint: async () => {
                  const token = await credentials.mint();
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
                  turns.set(tokenHash, { context, turn });
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
  const assistant = mountAssistantRoutes({
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
    allowedTools: allowed,
    extraTools: extra,
    approvalContinuations: async () => (await ready()).continuations,
    // These tools hold in their own canonical service; never create a second chat hold.
    approvalPolicy: {
      tools: Object.fromEntries(
        COOKBOOK_TOOL_NAMES.map((name) => [name, false]),
      ),
    },
    describeTool: describeAssistantTool,
    systemPrompt:
      'Help the owner work with their business records and installed recipes. Use the provided tools. A customer is a Customer linked to their Profile name; never create a Bot for a customer.',
    ...options.assistant,
  });

  const handle: Handle = (input) =>
    runtime.handle({
      ...input,
      resolve: async (event, resolveOptions) => {
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
  const session = createSessionLayoutLoad();
  async function load(event: Parameters<typeof session>[0]): Promise<
    Awaited<ReturnType<typeof session>> & {
      dynamicDefinitions: AppModelSnapshot['webDefinitions'];
      enabledModels: string[];
      cookbookApp: CookbookAppData;
      onboarding: OnboardingState | null;
      assistantIntroduction:
        | { lists: string[]; actions: string[]; configured: boolean }
        | undefined;
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
    const offered = p ? manifest(p.tenantId) : [];
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
    return {
      ...data,
      onboarding,
      assistantIntroduction: p
        ? {
            lists:
              visible?.sections
                .filter((s) => !s.hidden)
                .flatMap((s) =>
                  s.items.filter((i) => !i.hidden).map((i) => i.label),
                ) ?? [],
            actions: [
              ...new Set(
                offered
                  .map((t) => t.action)
                  .filter((a) =>
                    ['read', 'create', 'update', 'delete'].includes(a),
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
    load,
    assistant,
    connectAi,
    inferenceSettings,
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
      const verified = bearer
        ? await runtime.verifyLocalMcpToken(bearer)
        : null;
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
              await mcpModels({ ...principal, scopes: [...scope] })
            ).filter(
              (t) =>
                !binding ||
                binding.turn.tools.some((v) => v.slug === t.tool.slug),
            );
            const recipeTools = await host.service.list({
              surface: 'mcp',
              tenantId: principal.tenantId,
              userId: principal.id,
            });
            const specs = [
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
                      summary: describeAssistantTool(spec.slug, args),
                      context: binding?.turn.thread
                        ? {
                            principal: binding.context.principal,
                            threadId: binding.turn.thread.id,
                            agentSessionId: binding.turn.thread.agentSessionId,
                            originMessageId: binding.turn.originMessageId,
                            allowedTools:
                              binding.turn.principal.allowedTools ?? [],
                            permissionCeiling: binding.turn.permissions ?? [
                              ...scope,
                            ],
                            driver: 'builtin',
                          }
                        : {},
                    };
                    const hold = binding?.turn.thread
                      ? await host.authority.request(input)
                      : await host.continuations.capture(
                          {
                            id: caller.id,
                            tenantId: caller.tenantId,
                            permissions: [...(caller.scopes ?? [])],
                            allowedTools: [spec.slug],
                          },
                          () =>
                            host.continuations
                              .adapter('model', 'continuation')
                              .request(input),
                        );
                    const result = {
                      status: 'approval_required',
                      approvalId: hold.id,
                      summary: hold.summary,
                      outcomeTool: 'owner_approval_outcome',
                    };
                    return {
                      content: [{ type: 'text', text: JSON.stringify(result) }],
                      structuredContent: result,
                    };
                  }
                  if (tool && spec.generator)
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
                        return spec.generator!.handleToolCall({
                          method: 'tools/call',
                          params: { name, arguments: args },
                        });
                      },
                    );
                  const result = await host.continuations.capture(
                    {
                      id: caller.id,
                      tenantId: caller.tenantId,
                      permissions: [...(caller.scopes ?? [])],
                      allowedTools: [spec.slug],
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
                  return {
                    content: [{ type: 'text', text: JSON.stringify(result) }],
                  };
                },
              };
            });
            if (
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
                  const record = await host.continuations.outcome(
                    { id: caller.id, tenantId: caller.tenantId },
                    String(args.id),
                  );
                  if (!caller.scopes?.includes(record.tool))
                    throw new Error('Approval outcome scope required');
                  const result = {
                    id: record.id,
                    status: record.status,
                    summary: record.summary,
                    result: record.result ?? null,
                  };
                  return {
                    content: [{ type: 'text', text: JSON.stringify(result) }],
                    structuredContent: result,
                  };
                },
              });
          },
        );
      return mountMcpAppRoute({
        runtime,
        models: [],
        requiredScopes: [],
        workflowTools: workflows,
      })({ ...event, locals: { ...event.locals } });
    },
    dispose() {
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
