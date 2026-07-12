import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { AssistanceClassification, DeliveryEventType } from '../types.js';

export function parseProjectJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const INTERNAL_SURFACES = {
  api: false,
  cli: false,
  mcp: false,
} as const;

/** Provider-neutral connection from a Development Request to canonical work. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'development_request_work_links',
  conflictColumns: ['request_id', 'work_item_type', 'work_item_id'],
  ...INTERNAL_SURFACES,
})
export class DevelopmentRequestWorkLink extends SmrtObject {
  @tenantId() tenantId: string = '';
  @foreignKey('DevelopmentRequest', { required: true }) requestId: string = '';
  @field({ type: 'text' }) workItemType: string = '';
  @field({ type: 'text' }) workItemId: string = '';
  @field({ type: 'text' }) canonicalStatus: string = '';
  @field({ type: 'text' }) providerRef: string = '';
  @field({ type: 'text' }) metadata: string = '{}';
  lastProjectedAt: Date | null = null;
}

/** Ordered, idempotent delivery update emitted by the control plane. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'project_delivery_events',
  conflictColumns: ['integration_id', 'idempotency_key'],
  ...INTERNAL_SURFACES,
})
export class ProjectDeliveryEvent extends SmrtObject {
  @tenantId() tenantId: string = '';
  @foreignKey('ProjectIntegration', { required: true })
  integrationId: string = '';
  @foreignKey('DevelopmentRequest', { required: true }) requestId: string = '';
  @field({ type: 'text' }) idempotencyKey: string = '';
  sequence: number = 0;
  @field({ type: 'text' }) type: DeliveryEventType = 'work_linked';
  @field({ type: 'text' }) payload: string = '{}';
  occurredAt: Date = new Date();
  deliveredAt: Date | null = null;
  deliveryAttempts: number = 0;
  @field({ type: 'text' }) lastDeliveryError: string = '';
}

/** Client decision state for one preview produced during delivery. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'preview_approvals',
  conflictColumns: ['request_id', 'preview_id'],
  ...INTERNAL_SURFACES,
})
export class PreviewApproval extends SmrtObject {
  @tenantId() tenantId: string = '';
  @foreignKey('DevelopmentRequest', { required: true }) requestId: string = '';
  @field({ type: 'text' }) previewId: string = '';
  @field({ type: 'text' }) previewUrl: string = '';
  @field({ type: 'text' }) status:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'stale' = 'pending';
  @field({ type: 'text' }) decidedByRef: string = '';
  @field({ type: 'text' }) reason: string = '';
  createdAt: Date = new Date();
  decidedAt: Date | null = null;
  staleAt: Date | null = null;
}

/** Lossless conversational intake before support/development classification. */
@TenantScoped({ mode: 'required' })
@smrt({ tableName: 'assistance_requests', ...INTERNAL_SURFACES })
export class AssistanceRequest extends SmrtObject {
  @tenantId() tenantId: string = '';
  @foreignKey('ProjectIntegration', { required: true })
  integrationId: string = '';
  @field({ type: 'text' }) requesterId: string = '';
  @field({ type: 'text' }) subject: string = '';
  @field({ type: 'text' }) applicationContext: string = '{}';
  @field({ type: 'text' }) conversation: string = '[]';
  @field({ type: 'text' }) evidence: string = '[]';
  @field({ type: 'text' }) classification: AssistanceClassification =
    'unclassified';
  @field({ type: 'text' }) supportCaseId: string = '';
  @field({ type: 'text' }) developmentRequestId: string = '';
  deliveryHandoffLinkedAt: Date | null = null;
  createdAt: Date = new Date();
}

/** Append-only explanation of Assistance Request routing decisions. */
@TenantScoped({ mode: 'required' })
@smrt({ tableName: 'assistance_request_events', ...INTERNAL_SURFACES })
export class AssistanceRequestEvent extends SmrtObject {
  @tenantId() tenantId: string = '';
  @foreignKey('AssistanceRequest', { required: true })
  assistanceRequestId: string = '';
  @field({ type: 'text' }) priorClassification: AssistanceClassification =
    'unclassified';
  @field({ type: 'text' }) resultingClassification: AssistanceClassification =
    'unclassified';
  @field({ type: 'text' }) actorRef: string = '';
  @field({ type: 'text' }) reason: string = '';
  @field({ type: 'text' }) resultingLinks: string = '{}';
  occurredAt: Date = new Date();
}

export class DevelopmentRequestWorkLinkCollection extends SmrtCollection<DevelopmentRequestWorkLink> {
  static readonly _itemClass = DevelopmentRequestWorkLink;
}
export class ProjectDeliveryEventCollection extends SmrtCollection<ProjectDeliveryEvent> {
  static readonly _itemClass = ProjectDeliveryEvent;
}
export class PreviewApprovalCollection extends SmrtCollection<PreviewApproval> {
  static readonly _itemClass = PreviewApproval;
}
export class AssistanceRequestCollection extends SmrtCollection<AssistanceRequest> {
  static readonly _itemClass = AssistanceRequest;
}
export class AssistanceRequestEventCollection extends SmrtCollection<AssistanceRequestEvent> {
  static readonly _itemClass = AssistanceRequestEvent;
}
