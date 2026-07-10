import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  VoiceGatewayTurnOptions,
  VoiceGatewayTurnStatus,
} from '../types.js';

/**
 * Durable reservation for a gateway turn. The natural key makes `turn_id`
 * replay checks concurrency-safe before transcript messages are written.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'voice_gateway_turns',
  conflictColumns: ['voice_session_id', 'gateway_turn_id'],
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: false,
})
export class VoiceGatewayTurn extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('VoiceSession', { required: true })
  voiceSessionId: string = '';

  @field({ required: true })
  gatewaySessionId: string = '';

  @field({ required: true })
  gatewayTurnId: string = '';

  @field({ required: true })
  target: string = 'smrt:chat';

  @field({ required: true })
  status: VoiceGatewayTurnStatus = 'processing';

  @field()
  completedAt: Date | null = null;

  @field()
  failedAt: Date | null = null;

  constructor(options: VoiceGatewayTurnOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.voiceSessionId !== undefined)
      this.voiceSessionId = options.voiceSessionId;
    if (options.gatewaySessionId !== undefined)
      this.gatewaySessionId = options.gatewaySessionId;
    if (options.gatewayTurnId !== undefined)
      this.gatewayTurnId = options.gatewayTurnId;
    if (options.target !== undefined) this.target = options.target;
    if (options.status !== undefined) this.status = options.status;
    if (options.completedAt !== undefined)
      this.completedAt = options.completedAt;
    if (options.failedAt !== undefined) this.failedAt = options.failedAt;
  }

  async complete(now: Date = new Date()): Promise<void> {
    this.status = 'completed';
    this.completedAt = now;
    this.failedAt = null;
    await this.save();
  }

  async fail(now: Date = new Date()): Promise<void> {
    this.status = 'failed';
    this.failedAt = now;
    await this.save();
  }
}
