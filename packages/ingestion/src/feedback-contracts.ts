import type { DatabaseInterface } from '@happyvertical/sql';
import type { RoutingRule } from './feedback-dto.js';
import type { IngestionScope } from './server.js';
/** Trusted server configuration, never a selector supplied by a feedback caller. */
export interface RoutingProjection {
  handlerId: string;
  handlerVersion: string;
  /** Advance when the meaning of these routing preferences changes. */
  version: string;
  /** Nonempty allowlist of top-level handler argsSchema properties. */
  fields: readonly string[];
}
/** Operations `FeedbackConfiguration.authorize` is asked about; `verify` since #4504. */
export type FeedbackOperation =
  | 'capture'
  | 'retrieve'
  | 'verify'
  | 'suggest'
  | 'adopt';
export interface FeedbackConfiguration {
  version: string;
  maxExamples: number;
  maxScan: number;
  maxBytes: number;
  minimumSimilarity: number;
  /** Opt-in routing-only subsets. Omission retains exact full-argument matching. */
  routing?: readonly RoutingProjection[];
  /**
   * Live permission, same executor; host serializes grant changes at this boundary.
   *
   * `retrieve` picks new examples (analysis time) and revalidates a selection
   * at the provider boundary. `verify` re-checks stored lineage: the examples
   * an existing generation was produced with, whenever its actions are read,
   * reviewed or labelled (#4504). A host that switches learning off can refuse
   * `retrieve` and still allow `verify`, so items analysed while learning was
   * on stay loadable. Fail-safe for authorizers that predate `verify`: when
   * `verify` returns `false` the same check is asked as `retrieve`, and only a
   * refusal of both fails closed ("Feedback unavailable") as before.
   */
  authorize(input: {
    db: DatabaseInterface;
    scope: Readonly<IngestionScope>;
    itemId: string;
    operation: FeedbackOperation;
  }): Promise<boolean>;
  policy?: {
    /** Return current version and a human-readable routing preview; no mutation. */
    preview(input: {
      db: DatabaseInterface;
      scope: Readonly<IngestionScope>;
      rule: RoutingRule;
    }): Promise<{ version: string; preview: string }>;
    /** Atomic same-executor CAS and audit. May store routing preferences only, never permissions or automation. */
    adopt(input: {
      db: DatabaseInterface;
      scope: Readonly<IngestionScope>;
      rule: RoutingRule;
      expectedVersion: string;
      requestId: string;
    }): Promise<{ version: string; auditId: string }>;
  };
}
