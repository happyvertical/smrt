export const RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME =
  'smrt.runtime.diagnostics.read';

interface RuntimeDiagnosticsTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations: {
    readonly readOnlyHint: true;
    readonly destructiveHint: false;
    readonly idempotentHint: true;
    readonly openWorldHint: false;
  };
  readonly execute: (args: Record<string, unknown>) => Promise<string>;
}

interface RuntimeDiagnosticsModelContext {
  registerTool(
    tool: RuntimeDiagnosticsTool,
    options: { signal: AbortSignal },
  ): void | Promise<void>;
}

export interface RuntimeDiagnosticsWebMcpOwner {
  readonly dispose: () => void;
}

export interface RegisterRuntimeDiagnosticsWebMcpOptions {
  readonly fetchFn?: typeof fetch;
  readonly modelContext?: RuntimeDiagnosticsModelContext;
}

/** Register exactly one page-user, read-only diagnostics tool for its owner. */
export function registerRuntimeDiagnosticsWebMcp(
  options: RegisterRuntimeDiagnosticsWebMcpOptions = {},
): RuntimeDiagnosticsWebMcpOwner | null {
  const modelContext =
    options.modelContext ??
    (globalThis as {
      document?: { modelContext?: RuntimeDiagnosticsModelContext };
    }).document?.modelContext;
  if (!modelContext || typeof modelContext.registerTool !== 'function') {
    return null;
  }

  const controller = new AbortController();
  const tool = createRuntimeDiagnosticsWebMcpTool(options.fetchFn ?? fetch);
  try {
    const registration = modelContext.registerTool(tool, {
      signal: controller.signal,
    });
    void Promise.resolve(registration).catch(() => controller.abort());
  } catch {
    controller.abort();
  }
  return Object.freeze({ dispose: () => controller.abort() });
}

export function createRuntimeDiagnosticsWebMcpTool(
  fetchFn: typeof fetch,
): RuntimeDiagnosticsTool {
  return Object.freeze({
    name: RUNTIME_DIAGNOSTICS_WEBMCP_TOOL_NAME,
    description:
      'Read the authenticated, redacted application runtime diagnostics.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({}),
      additionalProperties: false,
    }),
    annotations: Object.freeze({
      readOnlyHint: true as const,
      destructiveHint: false as const,
      idempotentHint: true as const,
      openWorldHint: false as const,
    }),
    async execute() {
      let response: Response;
      try {
        response = await fetchFn('/api/_runtime/diagnostics', {
          method: 'GET',
          credentials: 'same-origin',
          headers: { accept: 'application/json' },
        });
      } catch {
        return stableToolError('diagnostics_unavailable');
      }
      if (!response.ok) {
        return stableToolError(
          response.status === 401
            ? 'authentication_required'
            : response.status === 403
              ? 'authorization_denied'
              : 'diagnostics_unavailable',
        );
      }
      try {
        return JSON.stringify(await response.json());
      } catch {
        return stableToolError('diagnostics_unavailable');
      }
    },
  });
}

function stableToolError(code: string): string {
  return JSON.stringify({ ok: false, error: { code } });
}
