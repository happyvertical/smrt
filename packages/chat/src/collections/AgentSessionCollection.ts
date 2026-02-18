import { SmrtCollection } from '@happyvertical/smrt-core';
import { AgentSession } from '../models/AgentSession.js';

export class AgentSessionCollection extends SmrtCollection<AgentSession> {
  static readonly _itemClass = AgentSession;

  async findActiveByParticipant(
    participantProfileId: string,
  ): Promise<AgentSession[]> {
    const sessions = await this.list({
      where: { participantProfileId, status: 'active' },
    });
    return sessions.filter((s) => s.isActive());
  }

  async findActiveSession(
    agentId: string,
    participantProfileId: string,
  ): Promise<AgentSession | null> {
    const sessions = await this.list({
      where: { agentId, participantProfileId, status: 'active' },
    });
    const active = sessions.find((s) => s.isActive());
    return active ?? null;
  }

  async findOrCreate(params: {
    agentId: string;
    participantProfileId: string;
    tenantId?: string | null;
    allowedTools?: string[];
    chatRoomId?: string | null;
    systemPrompt?: string;
  }): Promise<AgentSession> {
    const existing = await this.findActiveSession(
      params.agentId,
      params.participantProfileId,
    );
    if (existing) return existing;

    const session = await this.create({
      agentId: params.agentId,
      participantProfileId: params.participantProfileId,
      tenantId: params.tenantId ?? null,
      allowedTools: JSON.stringify(params.allowedTools ?? []),
      chatRoomId: params.chatRoomId ?? null,
      systemPrompt: params.systemPrompt ?? '',
      status: 'active',
    });
    await session.save();
    return session;
  }

  async findByAgent(agentId: string): Promise<AgentSession[]> {
    return this.list({ where: { agentId } });
  }

  async expireStale(olderThan: Date): Promise<number> {
    const sessions = await this.list({ where: { status: 'active' } });
    let expired = 0;
    for (const session of sessions) {
      if (session.lastMessageAt && session.lastMessageAt < olderThan) {
        await session.expire();
        expired++;
      }
    }
    return expired;
  }
}
