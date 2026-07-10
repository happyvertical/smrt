/**
 * Persona-bound conversation — the bridge from an {@link AgentSession} (a
 * conversation) to an `AgentPersona`/`TenantAgent` (a tenant-scoped, principal-
 * bound behavioural profile) (L3 of the learning-agents epic, #1891).
 *
 * This is the new, acyclic `chat → personas` edge. A conversation bound this way
 * runs under the persona's **principal** (its `runAsUserId`, via
 * {@link runToolLoop} → `executeAsPrincipal`), offers only the persona's
 * **tools** (its `allowedTools`, narrowing the manifest operation surface),
 * speaks with the persona's **instructions**, and draws on its **recalled
 * learning memory** — so the assistant behaves like it knows the tenant's job.
 *
 * The persona's `allowedTools` is mirrored onto the `AgentSession` so the chat
 * layer's own fail-closed tool gate (S5 #1392) agrees with the loop's — one
 * allow-list, enforced at both the loop's side door and the message-authoring
 * seam.
 *
 * @module
 */

import type { AIInterface, AIMessage } from '@happyvertical/ai';
import type {
  PrincipalAuditSink,
  PrincipalBinding,
  PrincipalTool,
} from '@happyvertical/smrt-agents';
import type {
  LearningMemoryRecord,
  LearningSemanticSearch,
  SmrtClassOptions,
} from '@happyvertical/smrt-core';
import {
  personaLearningMemory,
  resolvePersonaInstructions,
} from '@happyvertical/smrt-personas';
import { getDatabase } from '@happyvertical/sql';
import type { AgentSession } from './models/AgentSession.js';
import type { ChatMessage } from './models/ChatMessage.js';
import {
  buildManifestToolCatalog,
  type ManifestTool,
  runToolLoop,
  type ToolLoopResult,
} from './tool-loop.js';

/**
 * The structural persona shape the conversation binding needs. Both a
 * `ResolvedPersona` (from `PersonaResolver.resolve()`) and a raw `AgentPersona`
 * satisfy it via the adapters below.
 */
export interface ConversationPersona {
  /** Persona id — required to scope learning memory and prompt overrides. */
  id?: string | null;
  /** Owning tenant. */
  tenantId: string | null;
  /** Canonical agent class the persona configures. */
  agentClass?: string;
  /** The user whose live permissions bound the conversation. */
  runAsUserId: string;
  /** Optional acting `Bot` profile id (identity/audit). */
  actsAsProfileId?: string | null;
  /** The persona's tool allow-list (already capped by the class ceiling). */
  allowedTools: string[];
  /** Behavioural instructions / system prompt. */
  instructions?: string;
  /** Learning memory partition key. */
  memoryScope?: string;
}

/** Adapt a `PersonaResolver.resolve()` result into a {@link ConversationPersona}. */
export function conversationPersonaFromResolved(resolved: {
  personaId?: string;
  tenantId: string;
  agentClass: string;
  runAsUserId?: string;
  actsAsProfileId?: string | null;
  allowedTools: string[];
  instructions: string;
  memoryScope: string;
}): ConversationPersona {
  return {
    id: resolved.personaId ?? null,
    tenantId: resolved.tenantId,
    agentClass: resolved.agentClass,
    runAsUserId: resolved.runAsUserId ?? '',
    actsAsProfileId: resolved.actsAsProfileId ?? null,
    allowedTools: resolved.allowedTools,
    instructions: resolved.instructions,
    memoryScope: resolved.memoryScope,
  };
}

/** Adapt a raw `AgentPersona` row into a {@link ConversationPersona}. */
export function conversationPersonaFromAgentPersona(persona: {
  id?: string | null;
  tenantId: string;
  agentClass: string;
  runAsUserId: string;
  actsAsProfileId?: string | null;
  instructions: string;
  memoryScope?: string;
  getAllowedTools: () => string[];
}): ConversationPersona {
  return {
    id: persona.id ?? null,
    tenantId: persona.tenantId,
    agentClass: persona.agentClass,
    runAsUserId: persona.runAsUserId,
    actsAsProfileId: persona.actsAsProfileId ?? null,
    allowedTools: persona.getAllowedTools(),
    instructions: persona.instructions,
    memoryScope: persona.memoryScope,
  };
}

/**
 * Project a {@link ConversationPersona} into the {@link PrincipalBinding} the
 * tool loop runs as. The persona's `allowedTools` is the fail-closed whitelist
 * (absent/empty ⇒ no tools).
 */
export function principalBindingFor(
  persona: ConversationPersona,
): PrincipalBinding {
  return {
    runAsUserId: persona.runAsUserId,
    tenantId: persona.tenantId,
    allowedTools: persona.allowedTools,
    actsAsProfileId: persona.actsAsProfileId ?? null,
  };
}

/** How to recall a persona's learning memory into the conversation context. */
export interface PersonaRecallOptions {
  /** Learning scope to recall (defaults to `'chat'`). */
  scope?: string;
  /** Exact episode key within the scope (omit for a scope-wide recall). */
  key?: string;
  /** Free-text query for the semantic arm (needs a `semanticSearch`). */
  query?: string;
  /** Max recalled records injected into context. Default 5. */
  limit?: number;
  /** Override the reuse floor for this recall. */
  minConfidence?: number;
  /** Optional embedding search for the semantic recall arm. */
  semanticSearch?: LearningSemanticSearch;
}

/**
 * Recall the persona's confidence-filtered learning memory.
 *
 * Isolated per persona by `memoryScope`, so what the "Support" persona learned
 * never bleeds into "Sales". Returns `[]` for a persona with no memory scope /
 * id (nothing to partition on).
 */
export async function recallPersonaMemory(
  db: SmrtClassOptions['db'],
  persona: ConversationPersona,
  options: PersonaRecallOptions = {},
): Promise<LearningMemoryRecord[]> {
  if (!persona.memoryScope && !persona.id) {
    return [];
  }
  // LearningMemory operates on a resolved DB handle; `getDatabase` accepts a
  // config or a handle and returns a handle (idempotent for a handle).
  const memory = personaLearningMemory({
    db: await getDatabase(db as Parameters<typeof getDatabase>[0]),
    persona,
    semanticSearch: options.semanticSearch,
  });
  return memory.recall(options.scope ?? 'chat', {
    key: options.key,
    query: options.query,
    limit: options.limit ?? 5,
    minConfidence: options.minConfidence,
  });
}

/**
 * Format recalled memory into a system-context block. Empty string when there
 * is nothing to inject (so it can be unconditionally concatenated).
 */
export function formatRecalledMemory(records: LearningMemoryRecord[]): string {
  if (records.length === 0) {
    return '';
  }
  const lines = records.map((record) => {
    const value =
      typeof record.value === 'string'
        ? record.value
        : JSON.stringify(record.value);
    return `- [confidence ${record.confidence.toFixed(2)}] ${record.key}: ${value}`;
  });
  return `What you have learned about this organisation:\n${lines.join('\n')}`;
}

/**
 * Resolve the persona's effective instructions.
 *
 * Prefers the prompt-system resolution (`resolvePersonaInstructions`, which
 * layers any approved learned-directive override) when the persona is persisted;
 * falls back to the inline `persona.instructions`. This is how a conversation
 * "uses its instructions (`applyPersonaInstructions`)".
 */
export async function resolveConversationInstructions(
  db: SmrtClassOptions['db'],
  persona: ConversationPersona,
): Promise<string> {
  if (persona.id) {
    try {
      const resolved = await resolvePersonaInstructions({
        persona: { id: persona.id, tenantId: persona.tenantId },
        db: db as Parameters<typeof resolvePersonaInstructions>[0]['db'],
      });
      if (resolved) {
        return resolved;
      }
    } catch {
      // Fall through to the inline instructions.
    }
  }
  return persona.instructions ?? '';
}

/** The minimal AgentSession surface the turn needs. */
type SessionLike = Pick<AgentSession, 'id' | 'chatRoomId' | 'systemPrompt'>;

/** The minimal ChatService surface the turn needs to author the reply. */
export interface ConversationReplyService {
  initialize(): Promise<void>;
}

/**
 * Options for {@link runPersonaConversationTurn}.
 */
export interface PersonaConversationTurnOptions {
  /** The AI boundary. */
  ai: AIInterface;
  /** The database handle side-door operations run against. */
  db: SmrtClassOptions['db'];
  /** The persona the conversation is bound to. */
  persona: ConversationPersona;
  /** The user's message this turn. */
  userMessage: string;
  /** Tenant the turn runs within. */
  tenantId: string;
  /** Prior conversation turns (assistant/user), oldest first. */
  history?: AIMessage[];
  /**
   * The bound agent session. When provided together with `chatService`, the
   * agent reply is authored into the session's room and each executed tool is
   * recorded as a `tool_result` message (gated by the session allow-list).
   */
  session?: SessionLike | null;
  /** Chat service used to author the agent reply. */
  chatService?: ConversationReplyService | null;
  /** Thread to attach authored messages to. */
  threadId?: string | null;
  /** Recall configuration, or `false` to skip memory recall. */
  recall?: PersonaRecallOptions | false;
  /** Pre-built tool catalog (else derived from the persona's `allowedTools`). */
  tools?: ManifestTool[];
  /**
   * Non-manifest tools to offer this turn — e.g. the agent-orchestration
   * `invoke-agent` tool (#1892). Each is filtered by the persona's
   * `allowedTools` before being offered, so orchestration is gated exactly like
   * any other tool: a persona that does not allow-list `agents.invoke` never
   * sees it.
   */
  extraTools?: PrincipalTool[];
  /** Max tool-executing rounds. */
  maxSteps?: number;
  /** Model id. */
  model?: string;
  /** Sampling temperature. */
  temperature?: number;
  /** Max tokens per completion. */
  maxTokens?: number;
  /** Originating user the turn runs on behalf of (audited). */
  onBehalfOfUserId?: string | null;
  /** Audit sink for the on-behalf-of entry (forwarded to `executeAsPrincipal`). */
  audit?: PrincipalAuditSink;
  /** Opt into Postgres RLS transaction wrapping. */
  postgresRls?: boolean;
  /** Correlation id for the turn (feedback ties back to it). Auto-generated when omitted. */
  correlationId?: string;
}

/** The outcome of a persona-bound conversation turn. */
export interface PersonaConversationTurnResult {
  /** The tool-loop result (final text, invocations, transcript). */
  result: ToolLoopResult;
  /** The correlation id feedback on this turn should reference. */
  correlationId: string;
  /** The memory recalled into the turn's context. */
  recalled: LearningMemoryRecord[];
  /** The system prompt assembled for the turn. */
  systemPrompt: string;
  /** Persisted messages authored by this turn when a chat service was supplied. */
  authoredMessages?: AuthoredConversationMessages;
}

/** Persisted assistant/tool messages emitted for a persona turn. */
export interface AuthoredConversationMessages {
  toolMessages: ChatMessage[];
  assistantMessage: ChatMessage | null;
}

function assembleSystemPrompt(
  instructions: string,
  memoryBlock: string,
  sessionPrompt: string | undefined,
): string {
  // De-duplicate identical blocks: `bindPersonaToSession()` sets
  // `session.systemPrompt` to the persona instructions, so without this the
  // instruction block would appear twice (wasted tokens + confusion) once a
  // conversation runs on a bound session.
  const blocks = [sessionPrompt, instructions, memoryBlock]
    .map((part) => part?.trim())
    .filter((part): part is string => Boolean(part));
  return [...new Set(blocks)].join('\n\n');
}

/**
 * Run one turn of a persona-bound conversation.
 *
 * Binds the conversation to the persona: recalls its learning memory, resolves
 * its instructions, offers only its allow-listed manifest operations, and runs
 * the bounded tool loop as its principal. When a `chatService` + `session` are
 * given the assistant reply (and each executed tool) is authored into the room,
 * exercising the chat layer's own fail-closed tool gate.
 *
 * @returns The loop result, the turn's correlation id, and the recalled memory.
 */
export async function runPersonaConversationTurn(
  options: PersonaConversationTurnOptions,
): Promise<PersonaConversationTurnResult> {
  const { ai, db, persona, userMessage, tenantId } = options;
  // A conversation must run as a concrete principal. A default/unbound persona
  // (e.g. a `PersonaResolver` default fallback) has no `runAsUserId`; fail fast
  // with a clear error rather than building an empty-string PrincipalBinding
  // that would silently resolve to zero permissions downstream.
  if (!persona.runAsUserId) {
    throw new Error(
      'runPersonaConversationTurn requires a persona bound to a run-as user ' +
        '(runAsUserId); an unbound/default persona cannot operate the app.',
    );
  }
  const correlationId = options.correlationId ?? crypto.randomUUID();

  const recalled =
    options.recall === false
      ? []
      : await recallPersonaMemory(db, persona, options.recall ?? {});

  const instructions = await resolveConversationInstructions(db, persona);
  const memoryBlock = formatRecalledMemory(recalled);
  const systemPrompt = assembleSystemPrompt(
    instructions,
    memoryBlock,
    options.session?.systemPrompt,
  );

  const messages: AIMessage[] = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  if (options.history) {
    messages.push(...options.history);
  }
  messages.push({ role: 'user', content: userMessage });

  const tools =
    options.tools ??
    buildManifestToolCatalog({ db, allowedTools: persona.allowedTools });

  // Offer gate for non-manifest tools: only those the persona allow-lists (e.g.
  // `agents.invoke`) are offered, mirroring how the manifest catalog is
  // narrowed by `allowedTools`.
  const extraTools = (options.extraTools ?? []).filter((tool) =>
    persona.allowedTools.includes(tool.slug),
  );

  const result = await runToolLoop({
    ai,
    messages,
    tools,
    extraTools,
    principal: principalBindingFor(persona),
    db,
    maxSteps: options.maxSteps,
    model: options.model,
    temperature: options.temperature,
    maxTokens: options.maxTokens,
    onBehalfOfUserId: options.onBehalfOfUserId,
    agentClass: persona.agentClass,
    postgresRls: options.postgresRls,
    audit: options.audit,
  });

  let authoredMessages: AuthoredConversationMessages | undefined;
  if (options.chatService && options.session?.id) {
    authoredMessages = await authorConversationReply({
      chatService: options.chatService,
      session: options.session,
      tenantId,
      threadId: options.threadId ?? null,
      result,
    });
  }

  return { result, correlationId, recalled, systemPrompt, authoredMessages };
}

/**
 * Options for {@link bindPersonaToSession}.
 */
export interface BindPersonaToSessionOptions {
  /** Chat service exposing the owner-checked `updateAgentSessionConfig`. */
  chatService: {
    updateAgentSessionConfig(params: {
      agentSessionId: string;
      actorProfileId: string;
      tenantId: string | null;
      allowedTools?: string[];
      systemPrompt?: string;
    }): Promise<AgentSession>;
  };
  /** The session to bind. */
  session: Pick<AgentSession, 'id'>;
  /** The session owner (the update is owner-checked, S5 #1392). */
  actorProfileId: string;
  /** Tenant the session belongs to. */
  tenantId: string | null;
  /** The persona to bind the session to. */
  persona: ConversationPersona;
  /** Instructions to set as the session system prompt (else resolved). */
  instructions?: string;
  /** Database handle used to resolve instructions when not supplied. */
  db?: SmrtClassOptions['db'];
}

/**
 * Bind an {@link AgentSession} to a persona: mirror the persona's `allowedTools`
 * and instructions onto the session so the chat layer's own fail-closed tool
 * gate (S5 #1392) agrees with the loop's, and the session's system prompt speaks
 * the persona's voice. This is the durable side of the `chat → personas` bridge:
 * once bound, the session's authoring gate and the loop's offer gate share one
 * allow-list.
 */
export async function bindPersonaToSession(
  options: BindPersonaToSessionOptions,
): Promise<AgentSession> {
  const instructions =
    options.instructions ??
    (options.db
      ? await resolveConversationInstructions(options.db, options.persona)
      : (options.persona.instructions ?? ''));
  return options.chatService.updateAgentSessionConfig({
    agentSessionId: options.session.id as string,
    actorProfileId: options.actorProfileId,
    tenantId: options.tenantId,
    allowedTools: options.persona.allowedTools,
    systemPrompt: instructions,
  });
}

/**
 * Author the agent's turn into the chat room: one `tool_result` message per
 * executed tool (gated fail-closed by the session allow-list), then the final
 * assistant text. Uses the trusted in-package agent-reply bridge, so messages
 * are authored AS the session's agent.
 */
async function authorConversationReply(input: {
  chatService: ConversationReplyService;
  session: SessionLike;
  tenantId: string;
  threadId: string | null;
  result: ToolLoopResult;
}): Promise<AuthoredConversationMessages> {
  const { sendAgentReply } = await import('./services/ChatService.js');
  const toolMessages: ChatMessage[] = [];
  for (const invocation of input.result.invocations) {
    if (!invocation.ok) {
      continue;
    }
    const message = await sendAgentReply(input.chatService, {
      tenantId: input.tenantId,
      agentSessionId: input.session.id as string,
      threadId: input.threadId,
      content: JSON.stringify(invocation.observation),
      kind: 'tool',
      messageType: 'tool_result',
      toolCallData: { name: invocation.slug, args: invocation.args },
    });
    toolMessages.push(message);
  }
  const assistantMessage = await sendAgentReply(input.chatService, {
    tenantId: input.tenantId,
    agentSessionId: input.session.id as string,
    threadId: input.threadId,
    content: input.result.content,
    kind: 'assistant',
  });
  return { toolMessages, assistantMessage };
}
