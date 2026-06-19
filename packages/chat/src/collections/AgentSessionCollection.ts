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
    return session;
  }

  async findByAgent(agentId: string): Promise<AgentSession[]> {
    return this.list({ where: { agentId } });
  }

  /**
   * Expire active sessions whose last activity predates `olderThan`.
   *
   * Caller-scoping (S5 #1392): pass `scope` to restrict the sweep to a single
   * tenant and/or agent. Without a scope this expires stale sessions across the
   * whole (tenant-filtered) collection — only safe for trusted maintenance
   * callers, never for a per-tenant request handler.
   *
   * The candidate set is narrowed in SQL (status + activity timestamp) rather
   * than loading every active session into memory and filtering in JS
   * (DoS hardening). `lastMessageAt < olderThan` is applied server-side; rows
   * that never recorded a message fall back to `created_at`.
   */
  async expireStale(
    olderThan: Date,
    scope?: { tenantId?: string | null; agentId?: string },
  ): Promise<number> {
    const baseWhere: Record<string, unknown> = { status: 'active' };
    if (scope?.tenantId !== undefined) baseWhere.tenantId = scope.tenantId;
    if (scope?.agentId !== undefined) baseWhere.agentId = scope.agentId;

    // Sessions stale by their last message timestamp.
    const byLastMessage = await this.list({
      where: { ...baseWhere, 'lastMessageAt <': olderThan },
    });

    // Sessions that never recorded a message: judge by creation time.
    const neverMessaged = await this.list({
      where: { ...baseWhere, lastMessageAt: null, 'created_at <': olderThan },
    });

    const seen = new Set<string>();
    let expired = 0;
    for (const session of [...byLastMessage, ...neverMessaged]) {
      const id = session.id as string;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      await session.expire();
      expired++;
    }
    return expired;
  }
}
