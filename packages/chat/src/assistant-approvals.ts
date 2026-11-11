/** Server-write policy and durable hold bridge. Host code supplies authority, never model output. */
import type { PrincipalTool } from '@happyvertical/smrt-agents';
import type { OwnerApprovalAuthority } from '@happyvertical/smrt-app-runtime';
import type { AssistantApprovalWaiter } from './assistant-turn-driver.js';
import type { AssistantApprovalRequest } from './assistant-turn-events.js';
import type { ManifestTool } from './tool-loop.js';

export interface AssistantApprovalCall {
  id: string;
  originMessageId?: string;
  permissions?: readonly string[];
  tool: ManifestTool | PrincipalTool;
  args: Record<string, unknown>;
}

/** Tool override, then operation override, then destructive-name default. */
export interface AssistantApprovalPolicy {
  tools?: Readonly<Record<string, boolean>>;
  operations?: Readonly<Record<string, boolean>>;
}

export function requiresOwnerApproval(
  tool: ManifestTool | PrincipalTool,
  args: Record<string, unknown>,
  policy?: AssistantApprovalPolicy,
): boolean {
  const operation =
    'action' in tool ? tool.action : (tool.slug.split('.').at(-1) ?? '');
  const destructive = (value: string) =>
    /(?:^|[._-])(delete|remove|destroy|purge|drop|truncate)(?:$|[._-])/i.test(
      value.replace(/([a-z])([A-Z])/g, '$1_$2'),
    );
  return (
    policy?.tools?.[tool.slug] ??
    policy?.operations?.[operation] ??
    (destructive(operation) ||
      destructive(tool.slug) ||
      destructive(String(args.operation ?? args.action ?? '')))
  );
}

export interface AssistantApprovalBridge {
  policy?: AssistantApprovalPolicy;
  request(call: AssistantApprovalCall): Promise<AssistantApprovalRequest>;
  wait?: AssistantApprovalWaiter;
  complete?: (
    request: AssistantApprovalRequest,
    ok: boolean,
    result: unknown,
  ) => Promise<void>;
}

/** Creates requests from server-supplied snapshots and canonical calls, never an engine's id/summary. */
export function createAssistantApprovalBridge(options: {
  authority: OwnerApprovalAuthority;
  tenantId: string;
  requestedBy: string;
  context: Record<string, unknown>;
  policy?: AssistantApprovalPolicy;
  summary?: (call: AssistantApprovalCall) => string;
}): AssistantApprovalBridge {
  return {
    policy: options.policy,
    async request(call) {
      const record = await options.authority.request({
        tenantId: options.tenantId,
        requestedBy: options.requestedBy,
        tool: call.tool.slug,
        callId: call.id,
        args: call.args,
        summary:
          options.summary?.(call) ??
          `Allow ${call.tool.slug}${typeof call.args.id === 'string' ? ` for ${call.args.id.slice(0, 200)}` : ''}?`,
        context: {
          ...options.context,
          ...(call.permissions
            ? { permissionCeiling: [...call.permissions] }
            : {}),
          ...(call.originMessageId
            ? { originMessageId: call.originMessageId }
            : {}),
        },
      });
      return {
        id: record.id,
        tool: record.tool,
        callId: record.callId,
        summary: record.summary,
      };
    },
    async complete(request, ok, result) {
      await options.authority.complete(
        options.tenantId,
        request.id,
        ok,
        result,
      );
    },
    async wait(request, context) {
      const record = await options.authority.wait(
        options.tenantId,
        request.id,
        context.signal,
      );
      if (context.signal.aborted || record?.status !== 'approved')
        return { approved: false, reason: record?.status ?? 'cancelled' };
      await options.authority.consume(options.tenantId, request.id);
      return { approved: true };
    },
  };
}

/** Observe a host-executed durable hold without deciding, consuming or replaying it. */
export async function observeAssistantApproval(options: {
  authority: OwnerApprovalAuthority;
  tenantId: string;
  id: string;
  signal: AbortSignal;
  timeoutMs: number;
}) {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), options.timeoutMs);
  try {
    return await options.authority.wait(
      options.tenantId,
      options.id,
      AbortSignal.any([options.signal, timeout.signal]),
      { settled: true },
    );
  } finally {
    clearTimeout(timer);
  }
}
