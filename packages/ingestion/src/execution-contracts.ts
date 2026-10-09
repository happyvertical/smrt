import type { PrincipalRun } from '@happyvertical/smrt-agents';
import type { CapabilityDeclaration } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { ExecutionCeiling, IntakeValues } from './execution-dto.js';
import type { IntakePolicy, IntakePolicyLayer } from './policy.js';
import type { HandlerDiscovery } from './proposal-contracts.js';
import type { IngestionScope } from './server.js';

export type * from './execution-dto.js';
export interface HandlerContext {
  db: DatabaseInterface;
  scope: Readonly<IngestionScope>;
  itemId: string;
  principal?: PrincipalRun;
  policy: Readonly<IntakePolicy>;
  /** Must check current tenant/confidential ownership and optionally CAS revision. */
  assertTarget(model: string, id: string, revision?: string): Promise<void>;
}
export interface HandlerPreview {
  display: IntakeValues;
  normalizedArgs: IntakeValues;
  targetPreconditions: Array<{ model: string; id: string; revision: string }>;
}
interface HandlerBase {
  /** Optional proposal discovery on this same authoritative execution catalog. */
  discovery?: HandlerDiscovery;
  id: string;
  version: string;
  description: string;
  argsSchema: IntakeValues;
  resultSchema: IntakeValues;
  /** Schema-allowlisted record-ID fields, never arbitrary expression values. */
  resultModels: Record<string, string>;
  preview(args: IntakeValues, context: HandlerContext): Promise<HandlerPreview>;
  validate(
    args: IntakeValues,
    context: HandlerContext,
  ): Promise<{ ok: boolean }>;
}
export interface OperationHandler extends HandlerBase {
  operation: { model: string; action: string; version: string };
  /** Explicit application adapter declaration; checked against registered model. */
  capability: CapabilityDeclaration;
  execution:
    | {
        kind: 'database';
        apply(
          args: IntakeValues,
          context: HandlerContext,
        ): Promise<IntakeValues>;
      }
    | {
        kind: 'external';
        submit(
          args: IntakeValues,
          context: HandlerContext,
          idempotencyKey: string,
        ): Promise<IntakeValues>;
        reconcile(
          context: HandlerContext,
          idempotencyKey: string,
        ): Promise<
          | { kind: 'succeeded'; result: IntakeValues }
          | { kind: 'not_applied' }
          | { kind: 'unknown' }
        >;
      };
}
export interface PlanHandler extends HandlerBase {
  operation: { playbookKey: string; definitionHash: string };
  expand(
    args: IntakeValues,
    definition: unknown,
  ): Promise<
    Array<{
      stepIndex: number;
      handlerId: string;
      handlerVersion: string;
      args: IntakeValues;
      resultBindings: Record<
        string,
        { stepIndex: number; resultField: string; expectedModel: string }
      >;
    }>
  >;
}
export type IntakeHandler = OperationHandler | PlanHandler;
export interface ExecutionAccessInput {
  db: DatabaseInterface;
  scope: Readonly<IngestionScope>;
  itemId: string;
  capturedCeiling: Readonly<ExecutionCeiling>;
  operation: 'preview' | 'review' | 'execute' | 'read' | 'reconcile';
  handlerId: string;
}
/** Every callback is server configuration. It must never be deserialized from input. */
export interface IntakeExecutionOptions {
  handlers: readonly IntakeHandler[];
  /** Resolve current policy and grants using this exact executor. */
  authorize(input: ExecutionAccessInput): Promise<{
    allowed: boolean;
    reviewer: boolean;
    principalId: string;
    permissions: string[];
    policy: [
      IntakePolicyLayer,
      IntakePolicyLayer,
      IntakePolicyLayer,
      ...IntakePolicyLayer[],
    ];
    /** Host serializes/revalidates grant changes within this mutation boundary. */
    mutationBoundary: 'serialized';
  }>;
  evaluateAutomatic?(input: {
    bindingHash: string;
    handlerId: string;
    context: HandlerContext;
  }): Promise<{
    eligible: boolean;
    evaluationVersion: string;
    certainty: number;
  }>;
  /** Lock/serialize target ownership and revision checks with writers on this executor. */
  assertTarget(input: {
    db: DatabaseInterface;
    scope: Readonly<IngestionScope>;
    itemId: string;
    model: string;
    id: string;
    revision?: string;
  }): Promise<{ revision: string }>;
}
