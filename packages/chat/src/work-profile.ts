/** Host-owned work selection. A profile never changes execution authority. */
import type { AIInterface, AIMessage } from '@happyvertical/ai';
import type {
  ResolvedWorkProfile,
  WorkProfileName,
  WorkRunMetadata,
} from '@happyvertical/smrt-inference';
import type { AssistantTurnDriver } from './assistant-turn-driver.js';

/** Internal control flow: the requested tool has NOT executed. */
export class WorkProfileEscalation extends Error {
  messages?: AIMessage[];
  workRun?: WorkRunMetadata;
  constructor(readonly tool: string) {
    super('Thinking this through');
    this.name = 'WorkProfileEscalation';
  }
}

/** Turn-local accounting survives profile/engine changes. Never serialized as authority. */
export const WORK_RUN_ACCOUNTING = Symbol('workRunAccounting');
export interface WorkRunAccounting {
  model?: string;
  startedAt: number;
  tokens: number;
  usageKnown: boolean;
  toolCalls: number;
}

/** Server configuration only; never read these values from tool arguments. */
export interface AssistantWorkProfileOptions {
  [WORK_RUN_ACCOUNTING]?: WorkRunAccounting;
  workProfile?: ResolvedWorkProfile;
  /** Known design flow: enqueue through the host before any model call. */
  deferDesignTurn?: boolean;
  resolveWorkProfile?(name: WorkProfileName): Promise<ResolvedWorkProfile>;
  /** App-owned structural tools; annotation-based selection is also supported. */
  designTools?: readonly string[];
  /** Rebind the engine on escalation, preserving this turn's authority. */
  resolveWorkProfileRuntime?(profile: ResolvedWorkProfile): Promise<{
    ai?: Pick<AIInterface, 'chat'>;
    turnDriver?: AssistantTurnDriver;
  }>;
  onWorkRun?(metadata: WorkRunMetadata): void;
  /** Trusted host presentation of structured pass output, before storing the reply. */
  formatAssistantReply?(content: string): {
    content: string;
    metadata?: Record<string, unknown>;
  };
  /** Host may enqueue a durable run instead of continuing inline. The intercepted call never runs. */
  onDesignEscalation?(input: {
    tool: string;
    history: readonly AIMessage[];
    userMessage?: string;
    thread?: { id: string; roomId?: string; agentSessionId: string };
    originMessageId?: string;
  }): Promise<{ runId: string; message?: string }>;
}

/** Check before execution and before approval creation, using only trusted tool metadata. */
export function assertWorkProfileTool(
  options: AssistantWorkProfileOptions,
  tool: { slug: string; annotations?: { workProfile?: string } },
): void {
  if (
    (options.workProfile?.name ?? 'assist') === 'assist' &&
    options.workProfile?.autoEscalate !== false &&
    (options.designTools?.includes(tool.slug) ||
      tool.annotations?.workProfile === 'design')
  ) {
    throw new WorkProfileEscalation(tool.slug);
  }
}
