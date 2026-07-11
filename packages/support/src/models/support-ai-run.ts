/**
 * SupportAiRun — the auditable record of one Automated Support Response phase
 * (FR-28a): what the AI attempted (acknowledge / classify / answer /
 * troubleshoot / resolve), with confidence, classification output, knowledge
 * references, attempted tool calls, and outcome. This is the "prior automated
 * work" a Human Handoff transfers losslessly (FR-28b).
 *
 * Append-only: generated surface is `list`/`get`; the workflow writes each
 * run once and never rewrites history.
 */

import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  parseJsonField,
  type SupportAiRunOutcome,
  type SupportAiRunPhase,
} from '../types.js';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'support_ai_runs',
  api: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
})
export class SupportAiRun extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('SupportCase', { required: true })
  caseId: string = '';

  /** Inbound interaction that triggered this run, when applicable. */
  @foreignKey('SupportInteraction')
  interactionId: string | null = null;

  @field({ type: 'text' })
  phase: SupportAiRunPhase = 'acknowledge';

  @field({ type: 'text' })
  outcome: SupportAiRunOutcome = 'completed';

  /**
   * Model-reported confidence in [0, 1] for answer/classify/resolve phases;
   * null when the phase has no confidence semantics (e.g. acknowledge).
   */
  @field({ type: 'decimal', nullable: true })
  confidence: number | null = null;

  /** Classification output JSON: severity, category, sentiment, sensitive. */
  @field({ type: 'text' })
  classification: string = '{}';

  /** Outbound interaction holding the posted/drafted response, if any. */
  @foreignKey('SupportInteraction')
  responseInteractionId: string | null = null;

  /** Knowledge sources consulted (JSON array of `{kind, ref, label?}`). */
  @field({ type: 'text' })
  knowledgeRefs: string = '[]';

  /** Tool calls attempted during troubleshooting (JSON array). */
  @field({ type: 'text' })
  toolCalls: string = '[]';

  /** Error detail when `outcome === 'failed'`. */
  @field({ type: 'text' })
  error: string = '';

  /** Correlation id tying this run to AI-call telemetry / feedback signals. */
  @field({ type: 'text' })
  correlationId: string = '';

  /** Model identifier used, when known. */
  @field({ type: 'text' })
  model: string = '';

  startedAt: Date = new Date();

  completedAt: Date | null = null;

  @field({ type: 'text' })
  metadata: string = '{}';

  getClassification(): Record<string, unknown> {
    return parseJsonField(this.classification, {});
  }

  setClassification(value: Record<string, unknown>): void {
    this.classification = JSON.stringify(value ?? {});
  }

  getKnowledgeRefs(): Array<Record<string, unknown>> {
    return parseJsonField(this.knowledgeRefs, []);
  }

  setKnowledgeRefs(refs: Array<Record<string, unknown>>): void {
    this.knowledgeRefs = JSON.stringify(refs ?? []);
  }

  getToolCalls(): Array<Record<string, unknown>> {
    return parseJsonField(this.toolCalls, []);
  }

  setToolCalls(calls: Array<Record<string, unknown>>): void {
    this.toolCalls = JSON.stringify(calls ?? []);
  }
}

export class SupportAiRunCollection extends SmrtCollection<SupportAiRun> {
  static readonly _itemClass = SupportAiRun;

  /** All AI runs for a case, oldest first. */
  async forCase(caseId: string): Promise<SupportAiRun[]> {
    return this.list({ where: { caseId }, orderBy: 'started_at ASC' });
  }
}

export default SupportAiRun;
