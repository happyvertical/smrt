import type { DatabaseInterface } from '@happyvertical/sql';
/** Trusted signed session; never derive actor or tenant from source metadata. */
export interface FamilyIntakeRequest {
  tenantId: string;
  actorUserId: string;
}
/** Hosts decide current guardian permission, on the service's exact executor. */
export type FamilyIntakeAuthorizer = (
  request: FamilyIntakeRequest & {
    executor: DatabaseInterface;
    action:
      | 'education.family-intake.read'
      | 'education.family-intake.receive'
      | 'education.family-intake.assign';
  },
) => boolean | Promise<boolean>;
/** Advisory only: evidence and candidate identity confer no ownership. */
export interface FamilyIntakeCandidate {
  learnerId: string;
  evidence: readonly { source: string; quotation: string }[];
  confidence: 'supported' | 'uncertain';
}
export interface FamilyIntakeSource {
  sourceId: string;
  sourceVersion: string;
  deliveryKey: string;
  /** Immutable receipt evidence graph; metadata is provenance, never learner work. */
  evidence?: readonly {
    evidenceId: string;
    partId: string;
    parentEvidenceId: string | null;
    mimeType: string;
    sha256: string;
  }[];
}
export interface FamilyIntakeView {
  id: string;
  itemId: string;
  source: FamilyIntakeSource;
  revision: number;
  learnerId: string | null;
  photoIntakeId: string | null;
  originals: readonly {
    assetId: string;
    name: string;
    mimeType: string;
    sha256: string;
  }[];
}
/** A namespace, never an authorization grant. The original scope remains immutable. */
export function familyIntakeScopeId(tenantId: string): string {
  return `family-intake:${tenantId}`;
}
