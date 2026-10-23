import type {
  ParticipationAuthorizer,
  ParticipationTarget,
} from '@happyvertical/smrt-comments/participation';

/** Host authenticates both IDs and verifies that the profile belongs to this user. */
export interface ParticipationActor {
  tenantId: string;
  userId: string;
  profileId: string;
}
export interface RecordAccess extends ParticipationActor, ParticipationTarget {
  action: 'read' | 'react' | 'vote' | 'manage';
}
/** Owned supported connection configuration; arbitrary executors are not accepted. */
export interface ParticipationDatabaseConfig {
  type: 'sqlite' | 'postgres';
  url: string;
  cache?: false;
  dbid?: string;
  authToken?: string;
  encryptionKey?: string;
  transactionQueueTimeout?: number;
  max?: number;
  connectionTimeoutMillis?: number;
  idleTimeoutMillis?: number;
}
export interface ServiceOptions {
  database: ParticipationDatabaseConfig;
  actor: ParticipationActor;
  authorizeRecord: (access: RecordAccess) => Promise<boolean>;
  /** Required: hosts compose their subscriptions and eligibility/record-date hooks here. */
  participation: ParticipationAuthorizer;
  now?: () => Date;
}
export type ReactionKind =
  | 'like'
  | 'love'
  | 'celebrate'
  | 'insightful'
  | 'support';
export const REACTION_KINDS: readonly ReactionKind[] = [
  'like',
  'love',
  'celebrate',
  'insightful',
  'support',
];
export interface PollOption {
  id: string;
  label: string;
}
export type PollVisibility = 'always' | 'after_vote' | 'after_close';
export interface CreatePollInput {
  recordType: string;
  recordId: string;
  question: string;
  options: readonly PollOption[];
  opensAt?: Date | null;
  closesAt?: Date | null;
  visibility?: PollVisibility;
  anonymousTally?: boolean;
}
export interface PollProjection {
  id: string;
  question: string;
  options: PollOption[];
  closed: boolean;
  selectedOptionId: string | null;
  results: Record<string, number> | null;
  totalVotes: number | null;
}
export interface ReactionTally {
  kind: ReactionKind;
  count: number;
  selected: boolean;
}
