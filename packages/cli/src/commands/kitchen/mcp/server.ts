/**
 * `smrt kitchen mcp` (#3752): the Kitchen tools served over stdio. stdout
 * carries the protocol only; everything else goes to stderr.
 */

import { Server } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { cliVersion } from '../../cookbook/shared.js';
import { startKitchenPreview } from './preview.js';
import {
  KITCHEN_TOOLS,
  KitchenSession,
  type KitchenToolsOptions,
} from './tools.js';
import { KITCHEN_UI_CONTENT, KITCHEN_UI_URI, loadPlannerUi } from './ui.js';

export const SERVER_NAME = 'smrt-kitchen';

/** The tool catalog changes only with a release. */
const CATALOG_CACHE_HINT = {
  ttlMs: 86_400_000,
  cacheScope: 'private' as const,
};

/** Build the MCP server; one {@link KitchenSession} (plans, catalog) per server. */
export function createKitchenMcpServer(options: KitchenToolsOptions): {
  server: Server;
  session: KitchenSession;
} {
  const session = new KitchenSession(options);
  let plannerUi: ReturnType<typeof loadPlannerUi> | undefined;
  if (options.plannerUi) {
    try {
      plannerUi = loadPlannerUi(options.plannerUi);
    } catch {
      console.error(
        `[${SERVER_NAME}] Planner UI is unavailable; planning tools remain active.`,
      );
    }
  }
  const resources = [
    ...(options.uiSmoke ? [KITCHEN_UI_CONTENT] : []),
    ...(plannerUi ? [plannerUi] : []),
  ];
  const getPlanTool = KITCHEN_TOOLS.find((tool) => tool.name === 'get_plan');
  if (!getPlanTool) throw new Error('Kitchen get_plan tool is missing');
  const server = new Server(
    { name: SERVER_NAME, version: cliVersion() },
    {
      capabilities: {
        tools: {},
        ...(resources.length ? { resources: {} } : {}),
      },
      cacheHints: { 'tools/list': CATALOG_CACHE_HINT },
    },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: [
      ...KITCHEN_TOOLS.map((tool) => ({
        name: tool.name,
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema as never,
        outputSchema: tool.outputSchema as never,
        annotations: tool.annotations,
      })),
      ...(plannerUi
        ? [
            {
              name: 'planner_ui_update',
              title: 'Check Planner UI build',
              description:
                'Check whether the local Planner UI artifact has changed.',
              inputSchema: {
                type: 'object' as const,
                properties: {
                  version: { type: 'string' as const },
                  planId: { type: 'string' as const },
                },
                required: ['version'],
                additionalProperties: false,
              } as never,
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
              _meta: { ui: { visibility: ['app'] } },
            },
            {
              ...getPlanTool,
              inputSchema: getPlanTool.inputSchema as never,
              outputSchema: getPlanTool.outputSchema as never,
              name: 'render_plan',
              title: 'Open the Planner',
              description:
                'Open the interactive Planner for an existing plan. Call start_plan first, then pass its planId. Data tools keep working without the UI.',
              _meta: {
                ui: { resourceUri: plannerUi.uri },
                'openai/ui': { entrypoints: [{ type: 'thread' }] },
              },
            },
          ]
        : []),
      ...(options.uiSmoke
        ? [
            {
              name: 'kitchen_ui_smoke',
              title: 'Check local Kitchen UI',
              description:
                'Render a static local MCP Apps capability check. Does not edit or display the Planner.',
              inputSchema: {
                type: 'object' as const,
                properties: {},
                additionalProperties: false,
              },
              annotations: {
                readOnlyHint: true,
                destructiveHint: false,
                idempotentHint: true,
                openWorldHint: false,
              },
              _meta: { ui: { resourceUri: KITCHEN_UI_URI } },
            },
          ]
        : []),
    ],
  }));

  if (resources.length) {
    server.setRequestHandler('resources/list', async () => ({
      resources: resources.map(({ uri, name, mimeType }) => ({
        uri,
        name,
        mimeType,
      })),
    }));
    server.setRequestHandler('resources/read', async (request) => {
      const resource = resources.find(
        (item) => item.uri === request.params.uri,
      );
      if (!resource) {
        throw new Error(`Unknown Kitchen resource: ${request.params.uri}`);
      }
      return { contents: [resource] };
    });
  }

  server.setRequestHandler('tools/call', async (request) => {
    const { name, arguments: args } = request.params;
    if (plannerUi && options.plannerUi && name === 'planner_ui_update') {
      const version = typeof args?.version === 'string' ? args.version : '';
      const planId = typeof args?.planId === 'string' ? args.planId : undefined;
      let current: ReturnType<typeof loadPlannerUi>;
      try {
        current = loadPlannerUi(options.plannerUi, planId);
      } catch {
        return {
          content: [{ type: 'text', text: 'Planner UI build is not ready.' }],
          structuredContent: {
            changed: false,
            version,
            error: {
              code: 'unavailable',
              message: 'Planner UI build is not ready.',
            },
          },
        };
      }
      const currentVersion = current.uri.slice(
        'ui://smrt-kitchen/planner-'.length,
        -'.html'.length,
      );
      const changed = currentVersion !== version;
      const data = changed
        ? { changed, version: currentVersion, html: current.text }
        : { changed, version: currentVersion };
      return {
        content: [
          {
            type: 'text',
            text: changed ? 'Planner UI updated.' : 'Planner UI unchanged.',
          },
        ],
        structuredContent: data,
      };
    }
    if (options.uiSmoke && name === 'kitchen_ui_smoke') {
      return {
        content: [
          {
            type: 'text',
            text: 'Local MCP Apps capability check. Confirm whether the host displays the SMRT Kitchen card.',
          },
        ],
      };
    }
    const result = await session.call(
      plannerUi && name === 'render_plan' ? 'get_plan' : name,
      args ?? {},
    );
    return {
      content: [{ type: 'text', text: result.text }],
      structuredContent: result.data,
      ...(result.data.ok ? {} : { isError: true }),
    };
  });

  return { server, session };
}

/** Serve on this process's stdio until the host closes it or the process is stopped. */
export async function runKitchenMcp(
  options: KitchenToolsOptions,
): Promise<void> {
  const { server, session } = createKitchenMcpServer(options);
  const preview =
    options.previewPort !== undefined
      ? await startKitchenPreview(
          session,
          options.previewPort,
          options.previewOrigin ?? '',
        )
      : undefined;
  session.previewUrl = preview?.url;
  if (preview)
    console.error(`[${SERVER_NAME}] Live preview bridge: ${preview.url}`);
  const handle = serveStdio(() => server, {
    onerror: (error) => console.error(`[${SERVER_NAME}] ${error.message}`),
  });
  await new Promise<void>((resolve) => {
    const done = () => {
      void handle.close().finally(() => {
        preview?.server.close();
        resolve();
      });
    };
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    process.stdin.once('end', done);
    process.stdin.once('close', done);
  });
}
