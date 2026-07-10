import { SmrtCollection } from '@happyvertical/smrt-core';
import { VoiceSession } from '../models/VoiceSession.js';

export class VoiceSessionCollection extends SmrtCollection<VoiceSession> {
  static readonly _itemClass = VoiceSession;

  async getActiveById(
    id: string,
    target = 'smrt:chat',
  ): Promise<VoiceSession | null> {
    const session = await this.get({ id, target });
    if (!session?.isActive()) return null;
    return session;
  }

  async expireStale(
    olderThan: Date = new Date(),
    scope?: { tenantId?: string; target?: string },
  ): Promise<number> {
    const where: Record<string, unknown> = {
      status: 'active',
      'expiresAt <': olderThan,
    };
    if (scope?.tenantId !== undefined) where.tenantId = scope.tenantId;
    if (scope?.target !== undefined) where.target = scope.target;

    const stale = await this.list({ where });
    let expired = 0;
    for (const session of stale) {
      await session.expire();
      expired++;
    }
    return expired;
  }
}
