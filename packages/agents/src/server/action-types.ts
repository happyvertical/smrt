/**
 * Agent Action Handler Types
 *
 * Types for agent-specific action handlers that packages export via
 * their `/actions` subpath. The dashboard dynamically imports these
 * handlers and dispatches requests to them.
 *
 * @example
 * ```typescript
 * // In an agent package (e.g., @happyvertical/histrio/actions)
 * import type { AgentActionMap, AgentActionContext } from '@happyvertical/smrt-agents/server';
 *
 * const referenceImage: AgentActionHandler = async (ctx) => {
 *   const formData = await ctx.request.formData();
 *   // ... process the upload
 *   return Response.json({ data: result });
 * };
 *
 * export const actions: AgentActionMap = {
 *   'performers/reference-image': referenceImage,
 * };
 * ```
 *
 * @module @happyvertical/smrt-agents/server
 */

/**
 * Context passed to an agent action handler.
 *
 * Handlers receive the raw Request and return a standard Response,
 * so they can handle any content type (JSON, multipart, streaming)
 * without the dashboard needing to know.
 */
export interface AgentActionContext {
  /** Raw HTTP request (may be multipart, JSON, etc.) */
  request: Request;
  /** Resource path segment (e.g., 'performers') */
  resourcePath: string;
  /** Resource ID from URL */
  id: string;
  /** Action name from URL (e.g., 'reference-image') */
  action: string;
  /** Database configuration */
  db: { type: string; url: string };
  /** Current tenant ID */
  tenantId: string;
  /** Authenticated user ID */
  userId?: string;
  /** Agent instance UUID (from URL path) */
  agentId: string;
  /** Lazy-loaded service config from agent_configs table (slotId='services'). Cached per request. */
  getServiceConfig: () => Promise<Record<string, unknown>>;
  /** Retrieve a per-tenant encrypted secret by name */
  getSecret: (name: string) => Promise<string | null>;
}

/** A single action handler function */
export type AgentActionHandler = (ctx: AgentActionContext) => Promise<Response>;

/**
 * Map of action keys to handlers.
 * Keys use the format '{resourcePath}/{action}' (e.g., 'performers/reference-image').
 */
export type AgentActionMap = Record<string, AgentActionHandler>;
