/** Provider-neutral agreement execution contracts. */

import type {
  SignatureAuthenticationMethod,
  SignatureDocument,
  SignatureRequestStatus,
  SignatureSigner,
  SignatureSignerInput,
} from '@happyvertical/signatures';
import type { SmrtObjectOptions } from '@happyvertical/smrt-core';

export const AGREEMENT_EXECUTION_STATUSES = [
  'prepared',
  'sent',
  'delivered',
  'viewed',
  'partially_signed',
  'completed',
  'declined',
  'cancelled',
  'expired',
  'failed',
] as const satisfies readonly SignatureRequestStatus[];

export type AgreementExecutionStatus =
  (typeof AGREEMENT_EXECUTION_STATUSES)[number];

export interface AgreementSignerIntent {
  name: string;
  email: string;
  role?: string;
  order?: number;
  authenticationMethod: SignatureAuthenticationMethod;
}

export interface AgreementExecutionOptions extends SmrtObjectOptions {
  tenantId?: string;
  provider?: string;
  providerAccountRef?: string;
  credentialRef?: string;
  idempotencyKey?: string;
  sourceKind?: string;
  sourceId?: string;
  sourceVersion?: number;
  sourceAssetId?: string;
  sourceSha256?: string;
  sourceSizeBytes?: number;
  requestIntentSha256?: string;
  title?: string;
  signerIntent?: string;
  providerRequestId?: string;
  providerRequestKey?: string | null;
  status?: AgreementExecutionStatus;
  expiresAt?: Date | string | number | null;
  cancellationReason?: string;
  lastProviderEventAt?: Date | string | number | null;
  lastReconciledAt?: Date | string | number | null;
  completedAt?: Date | string | number | null;
  effectiveFrom?: Date | string | number | null;
  effectiveTo?: Date | string | number | null;
  supersedesExecutedAgreementId?: string;
  signedDocumentAssetId?: string;
  signedDocumentSha256?: string;
  signedDocumentSizeBytes?: number;
  signedDocumentMediaType?: string;
  signedDocumentFilename?: string;
  auditTrailAssetId?: string;
  auditTrailSha256?: string;
  auditTrailSizeBytes?: number;
  auditTrailMediaType?: string;
  auditTrailFilename?: string;
  attemptCount?: number;
  createLeaseId?: string;
  createLeaseExpiresAt?: Date | string | number | null;
  lastError?: string;
  metadata?: string;
}

export interface AgreementExecutionEventOptions extends SmrtObjectOptions {
  tenantId?: string;
  executionId?: string;
  provider?: string;
  providerEventId?: string;
  eventOrigin?: string;
  operationId?: string;
  dedupeKey?: string;
  orderingKey?: string;
  eventType?: string;
  status?: AgreementExecutionStatus;
  occurredAt?: Date | string | number;
  receivedAt?: Date | string | number;
  payloadSha256?: string;
  signerEvidence?: string;
  payload?: string;
}

export type VerifiedAgreementExecutionEventOptions =
  AgreementExecutionEventOptions &
    Required<
      Pick<
        AgreementExecutionEventOptions,
        'dedupeKey' | 'occurredAt' | 'receivedAt'
      >
    >;

export interface ExecutedAgreementOptions extends SmrtObjectOptions {
  tenantId?: string;
  executionId?: string;
  sourceKind?: string;
  sourceId?: string;
  sourceVersion?: number;
  sourceAssetId?: string;
  sourceSha256?: string;
  sourceSizeBytes?: number;
  signedDocumentAssetId?: string;
  signedDocumentSha256?: string;
  signedDocumentSizeBytes?: number;
  signedDocumentMediaType?: string;
  signedDocumentFilename?: string;
  auditTrailAssetId?: string;
  auditTrailSha256?: string;
  auditTrailSizeBytes?: number;
  auditTrailMediaType?: string;
  auditTrailFilename?: string;
  signerEvidence?: string;
  acceptedAt?: Date | string | number;
  effectiveFrom?: Date | string | number | null;
  effectiveTo?: Date | string | number | null;
  supersedesExecutedAgreementId?: string | null;
  metadata?: string;
}

export interface CreateAgreementExecutionInput {
  tenantId: string;
  idempotencyKey: string;
  sourceKind: string;
  sourceId: string;
  sourceVersion: number;
  title: string;
  document: SignatureDocument;
  signers: readonly SignatureSignerInput[];
  message?: string;
  signingOrder?: boolean;
  expiresInDays?: number;
  providerAccountRef?: string;
  /** Secret-store reference only. Credential values must stay in the provider. */
  credentialRef?: string;
  effectiveFrom?: Date | string | number | null;
  effectiveTo?: Date | string | number | null;
  supersedesExecutedAgreementId?: string;
  metadata?: Readonly<Record<string, string>>;
  signal?: AbortSignal;
}

export interface IngestAgreementWebhookInput {
  tenantId: string;
  payload: string;
  signature: string;
}

export interface AgreementExecutionResult {
  executionId: string;
  /** Absent only while another idempotent create caller owns the remote attempt. */
  providerRequestId?: string;
  status: AgreementExecutionStatus;
  replayed: boolean;
}

export interface AgreementWebhookIngestionResult {
  executionId: string;
  eventId: string;
  replayed: boolean;
  executedAgreementId?: string;
}

export function sanitizeSignerIntent(
  signers: readonly SignatureSignerInput[],
): AgreementSignerIntent[] {
  return signers.map((signer) => ({
    name: signer.name,
    email: signer.email,
    ...(signer.role ? { role: signer.role } : {}),
    ...(signer.order !== undefined ? { order: signer.order } : {}),
    authenticationMethod: signer.authentication?.method ?? 'none',
  }));
}

export function sanitizeSignerEvidence(
  signers: readonly SignatureSigner[],
): SignatureSigner[] {
  return signers.map((signer) => ({
    ...(signer.id ? { id: signer.id } : {}),
    name: signer.name,
    email: signer.email,
    ...(signer.role ? { role: signer.role } : {}),
    ...(signer.order !== undefined ? { order: signer.order } : {}),
    status: signer.status,
    ...(signer.authenticationMethod
      ? { authenticationMethod: signer.authenticationMethod }
      : {}),
    ...(signer.viewed !== undefined ? { viewed: signer.viewed } : {}),
    ...(signer.deliveryFailed !== undefined
      ? { deliveryFailed: signer.deliveryFailed }
      : {}),
  }));
}

export function coerceAgreementDate(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}
