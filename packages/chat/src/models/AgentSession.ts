import { SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { AgentSessionOptions, AgentSessionStatus } from '../types.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'agent_sessions',
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class AgentSession extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  agentId: string = '';
  participantProfileId: string = '';
  chatRoomId: string | null = null;

  status: AgentSessionStatus = 'active';

  /** JSON array of tool names the consuming app has allowed for this session */
  allowedTools: string = '[]';

  /** Conversation context/memory for multi-turn state (JSON string) */
  sessionContext: string = '{}';

  /** System prompt override for this session */
  systemPrompt: string = '';

  messageCount: number = 0;
  totalTokensUsed: number = 0;
  maxTokens: number = 0;
  maxMessages: number = 0;

  lastMessageAt: Date | null = null;
  expiresAt: Date | null = null;
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
      return JSON.parse(this.allowedTools);
    } catch {
      return [];
    }
  }

  setAllowedTools(tools: string[]): void {
    this.allowedTools = JSON.stringify(tools);
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
