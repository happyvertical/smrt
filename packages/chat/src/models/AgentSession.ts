import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { AgentSessionOptions, AgentSessionStatus } from '../types.js';

/**
 * Agent conversation session. Internal model — sessions must be created via
 * {@link ChatService.createAgentSession} and their security-relevant config
 * (`allowedTools` / `systemPrompt` / `chatRoomId` / `participantProfileId`)
 * mutated only via the owner-checked {@link ChatService.updateAgentSessionConfig}
 * (S5 #1392). The generated CRUD surface is read-only (`get`/`list`);
 * `create`/`update`/`delete` are NOT generated, otherwise a `PUT` could rewrite
 * the tool allow-list or system prompt and bypass the owner check.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'agent_sessions',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class AgentSession extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ required: true })
  agentId: string = '';

  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { required: true })
  participantProfileId: string = '';

  @foreignKey('ChatRoom')
  chatRoomId: string | null = null;

  @field({ required: true })
  status: AgentSessionStatus = 'active';

  /** JSON array of tool names the consuming app has allowed for this session */
  @field()
  allowedTools: string = '[]';

  /** Conversation context/memory for multi-turn state (JSON string) */
  @field()
  sessionContext: string = '{}';

  /** System prompt override for this session */
  @field()
  systemPrompt: string = '';

  @field()
  messageCount: number = 0;
  @field()
  totalTokensUsed: number = 0;
  @field()
  maxTokens: number = 0;
  @field()
  maxMessages: number = 0;

  @field()
  lastMessageAt: Date | null = null;
  @field()
  expiresAt: Date | null = null;
  @field()
  closedAt: Date | null = null;

  constructor(options: AgentSessionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.agentId !== undefined) this.agentId = options.agentId;
    if (options.participantProfileId !== undefined)
      this.participantProfileId = options.participantProfileId;
    if (options.chatRoomId !== undefined) this.chatRoomId = options.chatRoomId;
    if (options.status !== undefined) this.status = options.status;
    if (options.allowedTools !== undefined)
      this.allowedTools = options.allowedTools;
    if (options.sessionContext !== undefined)
      this.sessionContext = options.sessionContext;
    if (options.systemPrompt !== undefined)
      this.systemPrompt = options.systemPrompt;
    if (options.messageCount !== undefined)
      this.messageCount = options.messageCount;
    if (options.totalTokensUsed !== undefined)
      this.totalTokensUsed = options.totalTokensUsed;
    if (options.maxTokens !== undefined) this.maxTokens = options.maxTokens;
    if (options.maxMessages !== undefined)
      this.maxMessages = options.maxMessages;
    if (options.lastMessageAt !== undefined)
      this.lastMessageAt = options.lastMessageAt;
    if (options.expiresAt !== undefined) this.expiresAt = options.expiresAt;
    if (options.closedAt !== undefined) this.closedAt = options.closedAt;
  }

  getAllowedTools(): string[] {
    try {
      const parsed = JSON.parse(this.allowedTools);
      return Array.isArray(parsed)
        ? parsed.filter((t): t is string => typeof t === 'string')
        : [];
    } catch {
      return [];
    }
  }

  setAllowedTools(tools: string[]): void {
    this.allowedTools = JSON.stringify(tools);
  }

  /**
   * Fail-closed authorization check for an agent tool call (S5 #1392).
   *
   * A tool may only be invoked when it appears in this session's allow-list.
   * If the allow-list is empty or unparseable, NO tools are permitted. This is
   * deliberately conservative: an empty whitelist means "no tools", never
   * "all tools".
   */
  isToolAllowed(toolName: string): boolean {
    if (typeof toolName !== 'string' || toolName.length === 0) return false;
    return this.getAllowedTools().includes(toolName);
  }

  isActive(): boolean {
    if (this.status !== 'active') return false;
    if (this.expiresAt && new Date() >= this.expiresAt) return false;
    if (this.maxMessages > 0 && this.messageCount >= this.maxMessages)
      return false;
    if (this.maxTokens > 0 && this.totalTokensUsed >= this.maxTokens)
      return false;
    return true;
  }

  isExpired(): boolean {
    return this.expiresAt !== null && new Date() >= this.expiresAt;
  }

  async close(): Promise<void> {
    this.status = 'closed';
    this.closedAt = new Date();
    await this.save();
  }

  async expire(): Promise<void> {
    this.status = 'expired';
    this.closedAt = new Date();
    await this.save();
  }

  getSessionContext(): Record<string, unknown> {
    try {
      return JSON.parse(this.sessionContext);
    } catch {
      return {};
    }
  }

  setSessionContext(ctx: Record<string, unknown>): void {
    this.sessionContext = JSON.stringify(ctx);
  }

  async updateSessionContext(updates: Record<string, unknown>): Promise<void> {
    const current = this.getSessionContext();
    this.sessionContext = JSON.stringify({ ...current, ...updates });
    await this.save();
  }

  async recordMessage(tokensUsed: number = 0): Promise<void> {
    this.messageCount++;
    this.totalTokensUsed += tokensUsed;
    this.lastMessageAt = new Date();
    await this.save();
  }
}
