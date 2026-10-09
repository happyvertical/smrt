import type { DatabaseInterface } from '@happyvertical/sql';
import type { RoutingRule } from './feedback-dto.js';
import type { IngestionScope } from './server.js';
export interface FeedbackConfiguration {
  version: string;
  maxExamples: number;
  maxScan: number;
  maxBytes: number;
  minimumSimilarity: number;
  /** Live permission, same executor; host serializes grant changes at this boundary. */
  authorize(input: {
    db: DatabaseInterface;
    scope: Readonly<IngestionScope>;
    itemId: string;
    operation: 'capture' | 'retrieve' | 'suggest' | 'adopt';
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
