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
} from '@happyvertical/smrt-app-runtime';
import {
  createOwnerLinkHandler,
  createSessionLayoutLoad,
  type SmrtRuntimeLocals,
  type SmrtSvelteKitRuntime,
} from '@happyvertical/smrt-app-runtime/sveltekit';
import {
  buildManifestToolCatalog,
  describeAssistantTool,
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
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { validateCookbook } from '@happyvertical/smrt-core/cookbook';
import {
  COOKBOOK_TOOL_NAMES,
  type CookbookToolOptions,
  createCookbookToolService,
  setCookbookToolService,
} from '@happyvertical/smrt-core/cookbook/tools';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
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
  registerPreferenceKind,
} from '@happyvertical/smrt-preferences';
import { mountConnectAiRoutes } from '@happyvertical/smrt-svelte/connect-ai/server';
import {
  type CookbookAppData,
  catalogFromManifests,
  readInstalledManifests,
} from '@happyvertical/smrt-svelte/cookbook/server';
import type { Cookbook } from '@happyvertical/smrt-types';
import {
  PermissionResolver,
  registerPermissionDefinitions,
} from '@happyvertical/smrt-users';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { createCookbookHostState } from './state.js';

export interface CookbookHostOptions {
  runtime: SmrtSvelteKitRuntime;
  root?: string;
  /** Inject a validated installed catalog/document in tests or generated hosts. */
  app?: { cookbook: Cookbook; catalog: CookbookToolOptions['catalog'] };
  title?: string;
  assistant?: Pick<
    MountAssistantRoutesOptions,
    'ai' | 'systemPrompt' | 'onError'
  >;
  /** In-process test/host seams; inference still owns vendor discovery and credentials. */
  cli?: ReturnType<typeof createAgentCliService>;
  chatgpt?: ChatGPTPlanConnection;
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
  const wireName = (slug: string) => slug.replace(/[^a-z0-9_]/g, '_');
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
    const root = options.root ?? process.cwd();
    const app =
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
      })());
    const state = await createCookbookHostState(db, app.catalog, app.cookbook);
    const authority = new OwnerApprovalAuthority(
      await createSqliteOwnerApprovalStore(db),
      (actor) => isApprovalOwner(db, actor),
    );
    const preferences = createPrebuiltComponentsPreference({
      store: createPreferenceStore({ db }),
      isOwner: (p) => isOwner(p.tenantId, p.userId),
    });
    const service = createCookbookToolService({
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
      approvals: authority,
      // Conservative: replacing a template always needs owner approval. No unproven empty-data shortcut.
      isAppEmpty: async () => false,
      commit: state.commit,
      audit: state.audit,
    });
    const gate = createCookbookRuntimeExposure({
      catalog: app.catalog,
      engineFor: state.engineFor,
      predicate: (_model, c) => preferences.isEnabled(c.tenantId),
    });
    setCookbookToolService(service);
    setRuntimeExposureGate(gate);
    return { ...app, state, authority, preferences, service, gate };
  }
  const ready = () =>
    (starting ??= initialize().then((value) => (current = value)));
  const prepare = async (tenantId: string) => {
    const host = await ready();
    await host.state.refresh(tenantId);
    await host.preferences.read();
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
      { classNames: host.catalog.models.map((model) => model.id) },
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
  const extra = async (context: AssistantRequestContext) =>
    (await ready()).service.assistantTools({
      surface: 'assistant',
      tenantId: context.principal.tenantId,
      userId: context.principal.userId,
    });
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
        if (locals.tenantId) await prepare(locals.tenantId);
        return input.resolve(event, resolveOptions);
      },
    });
  const session = createSessionLayoutLoad();
  async function load(event: Parameters<typeof session>[0]) {
    const data = await session(event);
    const host = await ready();
    const tenantId = (event.locals as SmrtRuntimeLocals).tenantId;
    const engine = tenantId ? host.state.engineFor({ tenantId }) : undefined;
    const snapshot = engine?.snapshot();
    const visible = snapshot
      ? filterRuntimeCookbookSnapshot(snapshot, host.catalog, { tenantId })
      : undefined;
    return {
      ...data,
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
                })),
            ];
            const names = new Set<string>();
            workflows = specs.map((spec) => {
              const name = spec.name;
              if (names.has(name))
                throw new Error('Conflicting MCP tool aliases');
              names.add(name);
              const destructive =
                !!spec.model && requiresOwnerApproval(spec.model, {});
              return {
                name,
                description: spec.ai.function.description ?? spec.slug,
                inputSchema: spec.ai.function.parameters ?? { type: 'object' },
                outputSchema: { type: 'object', additionalProperties: true },
                effect: destructive
                  ? 'destructive'
                  : /\.(read|search|describe|listTemplates)$/.test(spec.slug)
                    ? 'read'
                    : 'write',
                idempotent: false,
                openWorld: false,
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
                  if (tool && requiresOwnerApproval(tool, args)) {
                    if (!binding?.turn.thread)
                      throw new Error(
                        'Destructive MCP tools require a bound assistant turn',
                      );
                    const hold = await host.authority.request({
                      tenantId: caller.tenantId,
                      requestedBy: caller.id,
                      tool: spec.slug,
                      callId: randomUUID(),
                      args,
                      summary: describeAssistantTool(spec.slug, args),
                      context: {
                        principal: binding.context.principal,
                        threadId: binding.turn.thread.id,
                        agentSessionId: binding.turn.thread.agentSessionId,
                        originMessageId: binding.turn.originMessageId,
                        allowedTools: binding.turn.principal.allowedTools ?? [],
                        permissionCeiling: binding.turn.permissions ?? [
                          ...scope,
                        ],
                        driver: 'builtin',
                      },
                    });
                    const result = {
                      status: 'approval_required',
                      approvalId: hold.id,
                      summary: hold.summary,
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
                  const result = await host.service.invoke(
                    spec.slug as Parameters<typeof host.service.invoke>[0],
                    args,
                    {
                      surface: 'mcp',
                      tenantId: caller.tenantId,
                      userId: caller.id,
                    },
                  );
                  return {
                    content: [{ type: 'text', text: JSON.stringify(result) }],
                  };
                },
              };
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
      current?.gate.dispose();
      setRuntimeExposureGate(undefined);
      setCookbookToolService(undefined);
      turns.clear();
    },
  };
}
