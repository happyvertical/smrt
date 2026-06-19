/**
 * Internal agent-runtime surface for @happyvertical/smrt-chat (S5 #1392).
 *
 * This module is exported ONLY under the explicit `./internal/agent-runtime`
 * subpath — it is intentionally NOT part of the package index (`.`). It exists
 * so trusted, in-process agent-runtime code (e.g. a content-editor agent that
 * generates the assistant reply) can author a message AS the session's agent.
 *
 * A normal route handler / package consumer importing from
 * `@happyvertical/smrt-chat` cannot reach {@link sendAgentReply} and therefore
 * cannot post as the agent. Opting into this subpath is a deliberate signal
 * that the importer is the trusted agent runtime, not a per-request handler
 * driven by client-supplied sender/role.
 */
export {
  type AgentReplyParams,
  type AgentReplyService,
  sendAgentReply,
} from '../services/ChatService.js';
