import type { McpVerifiedIdentity, McpPrincipalMapping } from '@happyvertical/smrt-app-mcp/auth';

/**
 * Deployments must replace this binding with a database-backed current-account
 * and active-membership lookup. Token claims never select a tenant.
 */
export type HostedMcpPrincipalResolver = (
  identity: McpVerifiedIdentity,
) => Promise<McpPrincipalMapping | null>;

export const resolveHostedMcpPrincipal: HostedMcpPrincipalResolver | undefined =
  undefined;
