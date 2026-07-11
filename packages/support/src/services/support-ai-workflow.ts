/**
 * SupportAiWorkflow — the Automated Support Response pipeline (FR-28a, issue
 * #1928): on intake a case is immediately acknowledged, classified, and
 * answered from scoped knowledge; only when the resolved {@link SupportPolicy}
 * explicitly allows it may the workflow resolve a low-risk case autonomously.
 * Every phase — run or skipped — writes an append-only {@link SupportAiRun}
 * audit row, and every risk signal (client request, low confidence,
 * sensitivity, high severity, boundary failure, attempt cap) routes through
 * {@link HumanHandoffService} so a Support Specialist takes over with the
 * complete context (FR-28b).
 *
 * The AI call is an injected {@link SupportAiBoundary} and knowledge
 * retrieval an injected {@link SupportKnowledgeProvider} (the `smrt-personas`
 * `ReflectionRunner` injected-boundary idiom) — tests mock only these seams,
 * and the package stays dependency-free: apps plug `smrt-facts` /
 * `smrt-content`-backed providers.
 */

import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  type SupportAiRun,
  SupportAiRunCollection,
} from '../models/support-ai-run.js';
import type { SupportCase } from '../models/support-case.js';
import { SupportInteractionCollection } from '../models/support-interaction.js';
import {
  DEFAULT_SUPPORT_POLICY,
  SupportPolicyCollection,
} from '../models/support-policy.js';
import {
  DEFAULT_SEVERITY_DEFINITIONS,
  type HumanHandoffTrigger,
  type SupportAiRunOutcome,
  type SupportAiRunPhase,
  type SupportChannelKind,
} from '../types.js';
import { HumanHandoffService } from './human-handoff-service.js';
import { SupportCaseService } from './support-case-service.js';
import type { IntakeResult } from './support-intake-service.js';

/** One knowledge source consulted while drafting an automated answer. */
export interface KnowledgeSnippet {
  /** Source kind, e.g. `fact`, `article`, `document`. */
  kind: string;
  /** Source reference (id, slug, or URL) for the audit trail. */
  ref: string;
  label?: string;
  content: string;
}

/** Classification returned by {@link SupportAiBoundary.classify}. */
export interface SupportAiClassifyResult {
  /** One of the offered severity keys, or `''` when undetermined. */
  severity: string;
  /** Short free-vocabulary category, or `''` when undetermined. */
  category: string;
  /** Whether the matter is sensitive (always triggers a Human Handoff). */
  sensitive: boolean;
  /** Confidence in `[0, 1]`. */
  confidence: number;
  /** Model identifier, when the boundary knows it. */
  model?: string;
}

/** Draft answer returned by {@link SupportAiBoundary.answer}. */
export interface SupportAiAnswerResult {
  reply: string;
  /** Confidence in `[0, 1]`; below the policy threshold → Human Handoff. */
  confidence: number;
  /** Whether the reply would fully resolve the request (FR-28a). */
  proposedResolution: boolean;
  /** Model identifier, when the boundary knows it. */
  model?: string;
}

/**
 * THE AI seam: the only thing tests mock. The default implementation
 * ({@link createDefaultAiBoundary}) delegates to the case's own `do()` AI
 * operation from `smrt-core`.
 */
export interface SupportAiBoundary {
  classify(input: {
    subject: string;
    body: string;
    severityKeys: string[];
    sensitiveCategories: string[];
  }): Promise<SupportAiClassifyResult>;
  answer(input: {
    subject: string;
    body: string;
    knowledge: KnowledgeSnippet[];
    caseSummary: string;
  }): Promise<SupportAiAnswerResult>;
}

/**
 * The knowledge seam: retrieve the snippets an automated answer may cite.
 * The default provider returns nothing, keeping this package dependency-free
 * — apps plug `smrt-facts` / `smrt-content`-backed providers.
 */
export interface SupportKnowledgeProvider {
  retrieve(input: {
    subject: string;
    body: string;
    projectId: string | null;
    tenantId: string | null;
  }): Promise<KnowledgeSnippet[]>;
}

/** Notification passed to `onHandoff` after each handoff attempt. */
export interface SupportHandoffNotice {
  supportCase: SupportCase;
  trigger: HumanHandoffTrigger;
  /** True when the no-repeat guarantee deduped this trigger. */
  alreadyActive: boolean;
}

/** Options for {@link SupportAiWorkflow.create}. */
export interface SupportAiWorkflowOptions extends SmrtObjectOptions {
  /** The AI seam; omitted → {@link createDefaultAiBoundary} per case. */
  boundary?: SupportAiBoundary;
  /** The knowledge seam; omitted → a no-op provider. */
  knowledge?: SupportKnowledgeProvider;
  /** Handoff engine to share; omitted → one is created lazily. */
  handoffService?: HumanHandoffService;
  /** Called after every handoff attempt (app notification seam). */
  onHandoff?: (notice: SupportHandoffNotice) => Promise<void>;
}

/** The resolved policy shape a pass runs under (row or built-in defaults). */
interface EffectiveSupportPolicy {
  policyId: string | null;
  autoAcknowledge: boolean;
  autoClassify: boolean;
  autoAnswer: boolean;
  autoTroubleshoot: boolean;
  autoResolve: boolean;
  autoResolveMaxSeverity: string;
  confidenceThreshold: number;
  maxAutoAttempts: number;
  autoSendEmailReplies: boolean;
  sensitiveCategories: string[];
  allowedTools: string[];
}

/** Severity ranks at or below this are `high_severity` handoff triggers. */
const HIGH_SEVERITY_MAX_RANK = 2;

/**
 * Numeric rank of a severity key by its numeric suffix (`sev1` → 1; lower is
 * more severe). Returns `NaN` for keys without a numeric suffix, which makes
 * every comparison false — auto-resolution fails closed and the
 * high-severity trigger stays quiet for unknown vocabularies.
 */
export function severityRank(severityKey: string | null | undefined): number {
  const match = /(\d+)\s*$/.exec((severityKey ?? '').trim());
  return match ? Number.parseInt(match[1] ?? '', 10) : Number.NaN;
}

/**
 * The Automated Support Response pipeline. Construct with
 * {@link SupportAiWorkflow.create}; wire {@link processIntake} into
 * `SupportIntakeService`'s `onCaseIntake` hook.
 */
export class SupportAiWorkflow {
  readonly caseService: SupportCaseService;
  readonly policies: SupportPolicyCollection;
  readonly aiRuns: SupportAiRunCollection;
  readonly interactions: SupportInteractionCollection;
  readonly handoffs: HumanHandoffService;
  private readonly boundary: SupportAiBoundary | null;
  private readonly knowledge: SupportKnowledgeProvider;
  private readonly onHandoff?: (notice: SupportHandoffNotice) => Promise<void>;

  protected constructor(deps: {
    caseService: SupportCaseService;
    policies: SupportPolicyCollection;
    aiRuns: SupportAiRunCollection;
    interactions: SupportInteractionCollection;
    handoffs: HumanHandoffService;
    boundary: SupportAiBoundary | null;
    knowledge: SupportKnowledgeProvider;
    onHandoff?: (notice: SupportHandoffNotice) => Promise<void>;
  }) {
    this.caseService = deps.caseService;
    this.policies = deps.policies;
    this.aiRuns = deps.aiRuns;
    this.interactions = deps.interactions;
    this.handoffs = deps.handoffs;
    this.boundary = deps.boundary;
    this.knowledge = deps.knowledge;
    this.onHandoff = deps.onHandoff;
  }

  static async create(
    options: SupportAiWorkflowOptions,
  ): Promise<SupportAiWorkflow> {
    const [caseService, policies, aiRuns, interactions, handoffs] =
      await Promise.all([
        SupportCaseService.create(options),
        SupportPolicyCollection.create(options),
        SupportAiRunCollection.create(options),
        SupportInteractionCollection.create(options),
        options.handoffService
          ? Promise.resolve(options.handoffService)
          : HumanHandoffService.create(options),
      ]);
    return new SupportAiWorkflow({
      caseService,
      policies,
      aiRuns,
      interactions,
      handoffs,
      boundary: options.boundary ?? null,
      knowledge: options.knowledge ?? createNoopKnowledgeProvider(),
      onHandoff: options.onHandoff,
    });
  }

  /**
   * Entry point for `SupportIntakeService.onCaseIntake`: run one automated
   * pass over the case an inbound interaction created or joined.
   */
  async processIntake(result: IntakeResult): Promise<SupportAiRun[]> {
    const caseId = result.supportCase?.id;
    if (!caseId || result.outcome === 'skipped') {
      return [];
    }
    return this.processCase(caseId, {
      interactionId: result.interaction?.id ?? null,
    });
  }

  /**
   * Run one Automated Support Response pass over a case: acknowledge →
   * classify → answer → troubleshoot → resolve, each gated by the resolved
   * policy and audited as a {@link SupportAiRun}. Cases with `aiEnabled`
   * off, or no longer open, are left untouched.
   */
  async processCase(
    caseId: string,
    opts: { interactionId?: string | null } = {},
  ): Promise<SupportAiRun[]> {
    const supportCase = await this.caseService.getCase(caseId);
    if (supportCase.aiEnabled === false || !supportCase.isOpen()) {
      return [];
    }

    const policy = await this.resolveEffectivePolicy(supportCase);
    const boundary =
      this.boundary ?? createDefaultAiBoundary(() => supportCase);
    const interactionId = opts.interactionId ?? null;
    const body = await this.requestBodyOf(supportCase, interactionId);
    const runs: SupportAiRun[] = [];

    // Phase: acknowledge (FR-28a — the client hears back immediately).
    runs.push(await this.runAcknowledge(supportCase, policy, interactionId));

    // Phase: classify (severity / category / sensitivity triage).
    if (!policy.autoClassify) {
      runs.push(
        await this.writeRun(supportCase, {
          phase: 'classify',
          outcome: 'skipped',
          interactionId,
          metadata: { reason: 'policy-disabled' },
        }),
      );
    } else {
      const startedAt = new Date();
      let classification: SupportAiClassifyResult;
      try {
        classification = await boundary.classify({
          subject: supportCase.subject,
          body,
          severityKeys: this.severityKeysOf(supportCase),
          sensitiveCategories: policy.sensitiveCategories,
        });
      } catch (error) {
        runs.push(
          await this.writeRun(supportCase, {
            phase: 'classify',
            outcome: 'failed',
            interactionId,
            startedAt,
            error: errorMessage(error),
          }),
        );
        await this.triggerHandoff(
          supportCase,
          'failed_resolution',
          `AI classification failed: ${errorMessage(error)}`,
        );
        return runs;
      }
      const classifiedSensitive =
        classification.sensitive ||
        (classification.category !== '' &&
          policy.sensitiveCategories.includes(classification.category));
      // Persist triage only into empty fields — a human's triage is never
      // overwritten by the model.
      let caseDirty = false;
      if (!supportCase.severity && classification.severity) {
        supportCase.severity = classification.severity;
        caseDirty = true;
      }
      if (!supportCase.category && classification.category) {
        supportCase.category = classification.category;
        caseDirty = true;
      }
      if (!supportCase.sensitive && classifiedSensitive) {
        supportCase.sensitive = true;
        caseDirty = true;
      }
      if (caseDirty) {
        await supportCase.save();
      }
      runs.push(
        await this.writeRun(supportCase, {
          phase: 'classify',
          outcome: 'completed',
          interactionId,
          startedAt,
          confidence: classification.confidence,
          classification: {
            severity: classification.severity,
            category: classification.category,
            sensitive: classifiedSensitive,
            confidence: classification.confidence,
          },
          model: classification.model,
        }),
      );
    }

    // Always-on triggers (FR-28b): sensitivity stops autonomous answering;
    // high severity routes a human while answering continues in parallel.
    const sensitive = supportCase.sensitive;
    if (sensitive) {
      await this.triggerHandoff(
        supportCase,
        'sensitive',
        'Case involves a sensitive matter',
      );
    }
    const rank = severityRank(supportCase.severity);
    if (Number.isFinite(rank) && rank <= HIGH_SEVERITY_MAX_RANK) {
      await this.triggerHandoff(
        supportCase,
        'high_severity',
        `Severity ${supportCase.severity} requires a Support Specialist`,
      );
    }

    // Phase: answer (knowledge-grounded reply above the confidence floor).
    let answer: SupportAiAnswerResult | null = null;
    let answerPosted = false;
    if (!policy.autoAnswer) {
      runs.push(
        await this.writeRun(supportCase, {
          phase: 'answer',
          outcome: 'skipped',
          interactionId,
          metadata: { reason: 'policy-disabled' },
        }),
      );
    } else if (sensitive) {
      runs.push(
        await this.writeRun(supportCase, {
          phase: 'answer',
          outcome: 'handed_off',
          interactionId,
          metadata: { reason: 'sensitive' },
        }),
      );
    } else if (supportCase.humanRequestedAt) {
      runs.push(
        await this.writeRun(supportCase, {
          phase: 'answer',
          outcome: 'handed_off',
          interactionId,
          metadata: { reason: 'human-requested' },
        }),
      );
      await this.triggerHandoff(
        supportCase,
        'client_request',
        'Client explicitly requested a human',
      );
    } else {
      const priorAttempts = await this.countAnswerAttempts(caseId);
      if (priorAttempts >= policy.maxAutoAttempts) {
        runs.push(
          await this.writeRun(supportCase, {
            phase: 'answer',
            outcome: 'skipped',
            interactionId,
            metadata: {
              reason: 'max-attempts',
              attempts: priorAttempts,
              maxAutoAttempts: policy.maxAutoAttempts,
            },
          }),
        );
        await this.triggerHandoff(
          supportCase,
          'policy',
          `Automated answer attempts exhausted (${priorAttempts}/${policy.maxAutoAttempts})`,
        );
      } else {
        const startedAt = new Date();
        let snippets: KnowledgeSnippet[] = [];
        try {
          snippets = await this.knowledge.retrieve({
            subject: supportCase.subject,
            body,
            projectId: supportCase.projectId,
            tenantId: supportCase.tenantId,
          });
          answer = await boundary.answer({
            subject: supportCase.subject,
            body,
            knowledge: snippets,
            caseSummary: this.caseSummaryOf(supportCase),
          });
        } catch (error) {
          runs.push(
            await this.writeRun(supportCase, {
              phase: 'answer',
              outcome: 'failed',
              interactionId,
              startedAt,
              knowledgeRefs: snippets,
              error: errorMessage(error),
            }),
          );
          await this.triggerHandoff(
            supportCase,
            'failed_resolution',
            `AI answer failed: ${errorMessage(error)}`,
          );
          return runs;
        }
        if (answer.confidence >= policy.confidenceThreshold) {
          const attemptNumber = priorAttempts + 1;
          const draft =
            supportCase.channelKind === 'email' && !policy.autoSendEmailReplies;
          const interaction = await this.caseService.recordInteraction(
            supportCase,
            {
              direction: 'outbound',
              channelKind: (supportCase.channelKind ||
                'chat') as SupportChannelKind,
              actorKind: 'agent',
              body: answer.reply,
              sourceKey: `ai:answer:${caseId}:${attemptNumber}`,
              metadata: { draft },
            },
          );
          runs.push(
            await this.writeRun(supportCase, {
              phase: 'answer',
              outcome: 'completed',
              interactionId,
              startedAt,
              confidence: answer.confidence,
              knowledgeRefs: snippets,
              responseInteractionId: interaction.id ?? null,
              model: answer.model,
              metadata: { attempt: attemptNumber, draft },
            }),
          );
          // A drafted email was never delivered to the client — it must not
          // count as a posted answer, so autonomous resolution stays gated
          // until the reply actually goes out (codex P1, PR #1943).
          answerPosted = !draft;
        } else {
          runs.push(
            await this.writeRun(supportCase, {
              phase: 'answer',
              outcome: 'handed_off',
              interactionId,
              startedAt,
              confidence: answer.confidence,
              knowledgeRefs: snippets,
              model: answer.model,
              // The unsent draft travels in the audit metadata so the
              // Specialist still sees the automated work (FR-28b).
              metadata: { reason: 'low-confidence', unsentReply: answer.reply },
            }),
          );
          await this.triggerHandoff(
            supportCase,
            'low_confidence',
            `Answer confidence ${answer.confidence} below threshold ${policy.confidenceThreshold}`,
          );
        }
      }
    }

    // Phase: troubleshoot — tool execution ships behind `allowedTools` in a
    // later slice; #1928 always records the gate decision.
    runs.push(
      await this.writeRun(supportCase, {
        phase: 'troubleshoot',
        outcome: 'skipped',
        interactionId,
        metadata: {
          reason: policy.autoTroubleshoot
            ? 'not-implemented'
            : 'policy-disabled',
        },
      }),
    );

    // Phase: resolve — autonomous only when the policy explicitly allows it
    // and every risk gate passes.
    const skipReason = this.resolveSkipReason(supportCase, policy, {
      answer,
      answerPosted,
      sensitive,
    });
    if (skipReason !== null || !answer) {
      runs.push(
        await this.writeRun(supportCase, {
          phase: 'resolve',
          outcome: 'skipped',
          interactionId,
          metadata: { reason: skipReason ?? 'no-answer' },
        }),
      );
    } else {
      await this.caseService.resolve(supportCase, {
        actorKind: 'agent',
        summary: answer.reply,
        resolutionKind: 'automated',
      });
      runs.push(
        await this.writeRun(supportCase, {
          phase: 'resolve',
          outcome: 'completed',
          interactionId,
          confidence: answer.confidence,
        }),
      );
    }

    return runs;
  }

  /** Acknowledge phase: post the templated receipt once per case. */
  private async runAcknowledge(
    supportCase: SupportCase,
    policy: EffectiveSupportPolicy,
    interactionId: string | null,
  ): Promise<SupportAiRun> {
    if (!policy.autoAcknowledge) {
      return this.writeRun(supportCase, {
        phase: 'acknowledge',
        outcome: 'skipped',
        interactionId,
        metadata: { reason: 'policy-disabled' },
      });
    }
    if (supportCase.acknowledgedAt) {
      return this.writeRun(supportCase, {
        phase: 'acknowledge',
        outcome: 'skipped',
        interactionId,
        metadata: { reason: 'already-acknowledged' },
      });
    }
    const caseId = this.caseIdOf(supportCase);
    // Email receipts are drafts unless the policy sends automated mail — an
    // undelivered receipt must not stamp `acknowledgedAt` or satisfy the
    // acknowledgement Service Target.
    const draft =
      supportCase.channelKind === 'email' && !policy.autoSendEmailReplies;
    const interaction = await this.caseService.recordInteraction(supportCase, {
      direction: 'outbound',
      channelKind: (supportCase.channelKind || 'chat') as SupportChannelKind,
      actorKind: 'agent',
      body: `Thanks for reaching out — we've opened case ${supportCase.caseNumber} and are looking into it now.`,
      sourceKey: `ai:ack:${caseId}`,
      // A templated receipt is an acknowledgement only — it must not satisfy
      // response Service Targets or stamp `firstRespondedAt` (the substantive
      // answer does that).
      metadata: { acknowledgement: true, draft },
    });
    return this.writeRun(supportCase, {
      phase: 'acknowledge',
      outcome: 'completed',
      interactionId,
      responseInteractionId: interaction.id ?? null,
    });
  }

  /** Why autonomous resolution must not run, or `null` when it may. */
  private resolveSkipReason(
    supportCase: SupportCase,
    policy: EffectiveSupportPolicy,
    outcome: {
      answer: SupportAiAnswerResult | null;
      answerPosted: boolean;
      sensitive: boolean;
    },
  ): string | null {
    if (!policy.autoResolve) {
      return 'policy-disabled';
    }
    const caseRank = severityRank(supportCase.severity);
    const maxRank = severityRank(policy.autoResolveMaxSeverity);
    if (
      !Number.isFinite(caseRank) ||
      !Number.isFinite(maxRank) ||
      caseRank < maxRank
    ) {
      return 'severity-ineligible';
    }
    if (!outcome.answerPosted || !outcome.answer) {
      return 'no-answer';
    }
    if (outcome.answer.confidence < policy.confidenceThreshold) {
      return 'low-confidence';
    }
    if (!outcome.answer.proposedResolution) {
      return 'no-proposed-resolution';
    }
    if (outcome.sensitive) {
      return 'sensitive';
    }
    if (supportCase.humanRequestedAt) {
      return 'human-requested';
    }
    return null;
  }

  /** Resolve the governing policy: matching row, else built-in defaults. */
  private async resolveEffectivePolicy(
    supportCase: SupportCase,
  ): Promise<EffectiveSupportPolicy> {
    const policy = await this.policies.resolveForScope({
      planId: supportCase.planId,
      projectId: supportCase.projectId,
    });
    if (!policy) {
      return {
        policyId: null,
        ...DEFAULT_SUPPORT_POLICY,
        sensitiveCategories: [...DEFAULT_SUPPORT_POLICY.sensitiveCategories],
        allowedTools: [...DEFAULT_SUPPORT_POLICY.allowedTools],
      };
    }
    return {
      policyId: policy.id ?? null,
      autoAcknowledge: policy.autoAcknowledge,
      autoClassify: policy.autoClassify,
      autoAnswer: policy.autoAnswer,
      autoTroubleshoot: policy.autoTroubleshoot,
      autoResolve: policy.autoResolve,
      autoResolveMaxSeverity: policy.autoResolveMaxSeverity,
      confidenceThreshold: policy.confidenceThreshold,
      maxAutoAttempts: policy.maxAutoAttempts,
      autoSendEmailReplies: policy.autoSendEmailReplies,
      sensitiveCategories: policy.getSensitiveCategories(),
      allowedTools: policy.getAllowedTools(),
    };
  }

  /**
   * Prior boundary-consuming answer attempts. Low-confidence answers consume
   * the boundary too (`handed_off`), so they count toward the attempt budget
   * — only `skipped` runs (which never called the boundary) are free.
   */
  private async countAnswerAttempts(caseId: string): Promise<number> {
    const runs = await this.aiRuns.forCase(caseId);
    return runs.filter(
      (run) => run.phase === 'answer' && run.outcome !== 'skipped',
    ).length;
  }

  /** The request text a pass reasons over: triggering interaction, else the
   * case description. */
  private async requestBodyOf(
    supportCase: SupportCase,
    interactionId: string | null,
  ): Promise<string> {
    if (interactionId) {
      const interaction = await this.interactions.get({ id: interactionId });
      if (interaction?.body) {
        return interaction.body;
      }
    }
    return supportCase.description;
  }

  /** Severity vocabulary: the case's plan snapshot, else the defaults. */
  private severityKeysOf(supportCase: SupportCase): string[] {
    const defs = supportCase.getPlanSnapshot().severityDefinitions;
    if (defs && typeof defs === 'object' && !Array.isArray(defs)) {
      const keys = Object.keys(defs as Record<string, unknown>);
      if (keys.length > 0) {
        return keys;
      }
    }
    return Object.keys(DEFAULT_SEVERITY_DEFINITIONS);
  }

  /** One-line case summary handed to the answer boundary. */
  private caseSummaryOf(supportCase: SupportCase): string {
    const parts = [
      `Case ${supportCase.caseNumber}`,
      `status ${supportCase.status}`,
    ];
    if (supportCase.severity) {
      parts.push(`severity ${supportCase.severity}`);
    }
    if (supportCase.category) {
      parts.push(`category ${supportCase.category}`);
    }
    return `${parts.join(', ')} — ${supportCase.subject}`;
  }

  /** Route a trigger through the handoff engine and notify the app seam. */
  private async triggerHandoff(
    supportCase: SupportCase,
    trigger: HumanHandoffTrigger,
    note: string,
  ): Promise<void> {
    const { alreadyActive } = await this.handoffs.handoff(supportCase, {
      trigger,
      note,
    });
    if (this.onHandoff) {
      await this.onHandoff({ supportCase, trigger, alreadyActive });
    }
  }

  /** Append one audit run plus its `ai_run` case event. */
  private async writeRun(
    supportCase: SupportCase,
    input: {
      phase: SupportAiRunPhase;
      outcome: SupportAiRunOutcome;
      interactionId?: string | null;
      confidence?: number | null;
      classification?: Record<string, unknown>;
      responseInteractionId?: string | null;
      knowledgeRefs?: KnowledgeSnippet[];
      error?: string;
      model?: string;
      startedAt?: Date;
      metadata?: Record<string, unknown>;
    },
  ): Promise<SupportAiRun> {
    const run = await this.aiRuns.create({
      tenantId: supportCase.tenantId,
      caseId: this.caseIdOf(supportCase),
      interactionId: input.interactionId ?? null,
      phase: input.phase,
      outcome: input.outcome,
      confidence: input.confidence ?? null,
      classification: JSON.stringify(input.classification ?? {}),
      responseInteractionId: input.responseInteractionId ?? null,
      knowledgeRefs: JSON.stringify(input.knowledgeRefs ?? []),
      error: input.error ?? '',
      correlationId: crypto.randomUUID(),
      model: input.model ?? '',
      startedAt: input.startedAt ?? new Date(),
      completedAt: new Date(),
      metadata: JSON.stringify(input.metadata ?? {}),
    });
    await this.caseService.recordEvent(supportCase, 'ai_run', {
      actorKind: 'agent',
      summary: `AI ${input.phase} → ${input.outcome}`,
      payload: {
        runId: run.id,
        phase: input.phase,
        outcome: input.outcome,
        confidence: input.confidence ?? null,
      },
    });
    return run;
  }

  /** The persisted id of a saved case. */
  private caseIdOf(supportCase: SupportCase): string {
    if (!supportCase.id) {
      throw new Error('SupportCase has no id — was it saved?');
    }
    return supportCase.id;
  }
}

/**
 * The default knowledge provider: retrieves nothing. Keeps the package
 * dependency-free; apps supply providers backed by `smrt-facts`,
 * `smrt-content`, or their own corpus.
 */
export function createNoopKnowledgeProvider(): SupportKnowledgeProvider {
  return {
    retrieve: () => Promise.resolve([]),
  };
}

/**
 * The default AI boundary: delegates to the case's own `do()` AI operation
 * (smrt-core) asking for strict JSON, parsed defensively — a malformed
 * classification comes back sensitive with zero confidence, failing toward
 * the human.
 */
export function createDefaultAiBoundary(
  getCase: () => SupportCase,
): SupportAiBoundary {
  return {
    async classify(input) {
      const raw = String(await getCase().do(buildClassifyInstructions(input)));
      const parsed = extractJsonObject(raw);
      if (!parsed) {
        return { severity: '', category: '', sensitive: true, confidence: 0 };
      }
      return {
        severity: typeof parsed.severity === 'string' ? parsed.severity : '',
        category: typeof parsed.category === 'string' ? parsed.category : '',
        sensitive: parsed.sensitive === true,
        confidence: clampConfidence(parsed.confidence),
      };
    },
    async answer(input) {
      const raw = String(await getCase().do(buildAnswerInstructions(input)));
      const parsed = extractJsonObject(raw);
      if (!parsed || typeof parsed.reply !== 'string' || !parsed.reply.trim()) {
        return { reply: '', confidence: 0, proposedResolution: false };
      }
      return {
        reply: parsed.reply,
        confidence: clampConfidence(parsed.confidence),
        proposedResolution: parsed.proposedResolution === true,
      };
    },
  };
}

/** Build the strict-JSON classification instructions for `do()`. */
function buildClassifyInstructions(input: {
  subject: string;
  body: string;
  severityKeys: string[];
  sensitiveCategories: string[];
}): string {
  const sensitiveList =
    input.sensitiveCategories.length > 0
      ? input.sensitiveCategories.join(', ')
      : '(none configured)';
  return [
    'You are triaging a client support request.',
    `Severity keys, most severe first: ${input.severityKeys.join(', ')}.`,
    `Sensitive categories: ${sensitiveList}.`,
    `Subject: ${input.subject}`,
    'Request:',
    input.body,
    '',
    'Respond with ONLY a strict JSON object:',
    '{"severity": "<one severity key>", "category": "<short-kebab-case>",',
    '"sensitive": <true when the matter touches a sensitive category, legal',
    'or security exposure, or personal data>, "confidence": <number 0..1>}',
  ].join('\n');
}

/** Build the strict-JSON answer instructions for `do()`. */
function buildAnswerInstructions(input: {
  subject: string;
  body: string;
  knowledge: KnowledgeSnippet[];
  caseSummary: string;
}): string {
  const knowledgeBlock =
    input.knowledge.length > 0
      ? input.knowledge
          .map(
            (snippet) =>
              `- [${snippet.kind}:${snippet.ref}]${
                snippet.label ? ` ${snippet.label}:` : ''
              } ${snippet.content}`,
          )
          .join('\n')
      : '(no knowledge available)';
  return [
    'You are drafting a support reply grounded ONLY in the knowledge below.',
    `Context: ${input.caseSummary}`,
    `Subject: ${input.subject}`,
    'Request:',
    input.body,
    'Knowledge:',
    knowledgeBlock,
    '',
    'Respond with ONLY a strict JSON object:',
    '{"reply": "<the reply to send>", "confidence": <number 0..1>,',
    '"proposedResolution": <true when the reply fully resolves the request>}',
  ].join('\n');
}

/** Best-effort strict-JSON extraction from a raw model response. */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.trim();
  const candidates = [text];
  const embedded = /\{[\s\S]*\}/.exec(text);
  if (embedded && embedded[0] !== text) {
    candidates.push(embedded[0]);
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Clamp a model-reported confidence into `[0, 1]` (non-numbers → 0). */
function clampConfidence(value: unknown): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.min(1, Math.max(0, num));
}

/** Normalise an unknown thrown value into an audit-friendly message. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default SupportAiWorkflow;
