import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { ConversationPersona } from '../persona-conversation.js';
import type { VoiceSessionOptions, VoiceSessionStatus } from '../types.js';

/**
 * Short-lived binding proving a voice gateway turn belongs to an authenticated
 * SMRT actor, persona, and chat session. Internal model: creation and turn
 * handling must go through the voice adapter, never raw generated mutations.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'voice_sessions',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class VoiceSession extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  /** Stable session id the gateway places in the top-level `session_id`. */
  @field({ required: true })
  gatewaySessionId: string = '';

  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { required: true })
  actorProfileId: string = '';

  @crossPackageRef('@happyvertical/smrt-users:User', { nullable: true })
  actorUserId: string | null = null;

  @crossPackageRef('@happyvertical/smrt-personas:AgentPersona', {
    required: true,
  })
  personaId: string = '';

  @foreignKey('AgentSession', { required: true })
  agentSessionId: string = '';

  @foreignKey('ChatRoom', { required: true })
  chatRoomId: string = '';

  @foreignKey('ChatThread')
  threadId: string | null = null;

  @field({ required: true })
  target: string = 'smrt:chat';

  @field({ required: true })
  status: VoiceSessionStatus = 'active';

  @field({ required: true })
  expiresAt: Date = new Date(Date.now() + 10 * 60 * 1000);

  @field()
  lastTurnAt: Date | null = null;

  @field()
  lastGatewayTurnId: string | null = null;

  @field()
  personaSnapshot: string = '{}';

  @field()
  metadata: string = '{}';

  @field()
  processedTurnIds: string = '[]';

  constructor(options: VoiceSessionOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.gatewaySessionId !== undefined)
      this.gatewaySessionId = options.gatewaySessionId;
    if (options.actorProfileId !== undefined)
      this.actorProfileId = options.actorProfileId;
    if (options.actorUserId !== undefined)
      this.actorUserId = options.actorUserId;
    if (options.personaId !== undefined) this.personaId = options.personaId;
    if (options.agentSessionId !== undefined)
      this.agentSessionId = options.agentSessionId;
    if (options.chatRoomId !== undefined) this.chatRoomId = options.chatRoomId;
    if (options.threadId !== undefined) this.threadId = options.threadId;
    if (options.target !== undefined) this.target = options.target;
    if (options.status !== undefined) this.status = options.status;
    if (options.expiresAt !== undefined) this.expiresAt = options.expiresAt;
    if (options.lastTurnAt !== undefined) this.lastTurnAt = options.lastTurnAt;
    if (options.lastGatewayTurnId !== undefined)
      this.lastGatewayTurnId = options.lastGatewayTurnId;
    if (options.personaSnapshot !== undefined)
      this.personaSnapshot =
        typeof options.personaSnapshot === 'string'
          ? options.personaSnapshot
          : JSON.stringify(options.personaSnapshot);
    if (options.metadata !== undefined)
      this.metadata =
        typeof options.metadata === 'string'
          ? options.metadata
          : JSON.stringify(options.metadata);
    if (options.processedTurnIds !== undefined)
      this.processedTurnIds =
        typeof options.processedTurnIds === 'string'
          ? options.processedTurnIds
          : JSON.stringify(options.processedTurnIds);
  }

  isActive(now: Date = new Date()): boolean {
    return this.status === 'active' && now < this.expiresAt;
  }

  isExpired(now: Date = new Date()): boolean {
    return now >= this.expiresAt;
  }

  async expire(): Promise<void> {
    this.status = 'expired';
    await this.save();
  }

  async revoke(): Promise<void> {
    this.status = 'revoked';
    await this.save();
  }

  getPersonaSnapshot(): ConversationPersona {
    try {
      return JSON.parse(this.personaSnapshot) as ConversationPersona;
    } catch {
      return {
        id: this.personaId,
        tenantId: this.tenantId,
        runAsUserId: '',
        allowedTools: [],
      };
    }
  }

  setPersonaSnapshot(persona: ConversationPersona): void {
    this.personaSnapshot = JSON.stringify(persona);
  }

  getMetadata(): Record<string, unknown> {
    try {
      return JSON.parse(this.metadata);
    } catch {
      return {};
    }
  }

  setMetadata(metadata: Record<string, unknown>): void {
    this.metadata = JSON.stringify(metadata);
  }

  getProcessedTurnIds(): string[] {
    try {
      const parsed = JSON.parse(this.processedTurnIds);
      return Array.isArray(parsed)
        ? parsed.filter((id): id is string => typeof id === 'string')
        : [];
    } catch {
      return [];
    }
  }

  hasProcessedTurn(turnId: string): boolean {
    return this.getProcessedTurnIds().includes(turnId);
  }

  recordGatewayTurn(turnId: string, maxRememberedTurns = 50): void {
    const ids = this.getProcessedTurnIds().filter((id) => id !== turnId);
    ids.push(turnId);
    this.processedTurnIds = JSON.stringify(ids.slice(-maxRememberedTurns));
    this.lastGatewayTurnId = turnId;
    this.lastTurnAt = new Date();
  }
}
