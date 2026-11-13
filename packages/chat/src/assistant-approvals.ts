/** Server-write policy and durable hold bridge. Host code supplies authority, never model output. */
import type { PrincipalTool } from '@happyvertical/smrt-agents';
import type { OwnerApprovalAuthority } from '@happyvertical/smrt-app-runtime';
import { ObjectRegistry } from '@happyvertical/smrt-core';
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
  /** Trusted host choice for in-app chat only. Never read from tool arguments. */
  allowRemovalsInChat?: boolean;
  tools?: Readonly<Record<string, boolean>>;
  operations?: Readonly<Record<string, boolean>>;
}

export function requiresOwnerApproval(
  tool: ManifestTool | PrincipalTool,
  args: Record<string, unknown>,
  policy?: AssistantApprovalPolicy,
  destructiveHint = false,
): boolean {
  const operation =
    'action' in tool ? tool.action : (tool.slug.split('.').at(-1) ?? '');
  const destructive = (value: string) =>
    /(?:^|[._-])(delete|remove|destroy|purge|drop|truncate)(?:$|[._-])/i.test(
      value.replace(/([a-z])([A-Z])/g, '$1_$2'),
    );
  const values = [
    operation,
    tool.slug,
    String(args.operation ?? args.action ?? ''),
  ].map((value) => value.replace(/([a-z])([A-Z])/g, '$1_$2'));
  const purge = values.some((value) =>
    /(?:^|[._-])(purge|drop|truncate|destroy)(?:$|[._-])/i.test(value),
  );
  // Opt-in metadata is server-owned. Names and model arguments never classify
  // a tool as ordinary app data; extra/custom/security operations stay held.
  const identity =
    'action' in tool ? (tool.qualifiedName ?? tool.className) : undefined;
  const declaration = identity ? ObjectRegistry.getClass(identity) : undefined;
  const controlModel =
    [
      identity,
      ...(declaration
        ? ObjectRegistry.getInheritanceChain(
            declaration.qualifiedName ?? declaration.name,
          )
        : []),
      ...(declaration?.replacedQualifiedNames ?? []),
    ].some(
      (name) =>
        name &&
        [
          '@happyvertical/smrt-users',
          '@happyvertical/smrt-profiles',
          '@happyvertical/smrt-tenancy',
          '@happyvertical/smrt-secrets',
          '@happyvertical/smrt-preferences',
          '@happyvertical/smrt-config',
          '@happyvertical/smrt-features',
          '@happyvertical/smrt-app-runtime',
          '@happyvertical/smrt-app-shell',
          '@happyvertical/smrt-inference',
          '@happyvertical/smrt-approvals',
        ].includes(name.split(':')[0]),
    ) ||
    (!!declaration &&
      ObjectRegistry.getConfig(declaration.qualifiedName ?? declaration.name)
        .sensitive === true);
  const recordDeletion =
    !controlModel &&
    'action' in tool &&
    tool.action === 'delete' &&
    tool.annotations?.recordDeletion === true &&
    tool.annotations?.workProfile !== 'design' &&
    typeof args.id === 'string' &&
    args.id.trim().length > 0;
  if (purge) return true;
  // Native tools may own an independent hold (the existing explicit overrides).
  // The new chat setting itself can never waive a purge or an unknown effect.
  return (
    policy?.tools?.[tool.slug] ??
    policy?.operations?.[operation] ??
    (policy?.allowRemovalsInChat && recordDeletion
      ? false
      : destructiveHint ||
        destructive(operation) ||
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
