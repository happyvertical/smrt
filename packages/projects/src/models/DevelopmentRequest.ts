import {
  foreignKey,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  DevelopmentRequestEvidence,
  DevelopmentRequestOrigin,
  DevelopmentRequestStatus,
  DevelopmentRequestType,
  DevelopmentRequestVisibility,
} from '../types';

export interface DevelopmentRequestOptions extends SmrtObjectOptions {
  tenantId?: string;
  projectId?: string;
  integrationId?: string;
  requesterId?: string;
  participantId?: string;
  type?: DevelopmentRequestType;
  description?: string;
  evidence?: DevelopmentRequestEvidence[] | string;
  visibility?: DevelopmentRequestVisibility;
  origin?: DevelopmentRequestOrigin;
  discussion?: string;
  status?: DevelopmentRequestStatus;
}

function parseEvidence(raw: unknown): DevelopmentRequestEvidence[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return normalizeEvidence(raw);
  if (typeof raw !== 'string') return [];

  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? normalizeEvidence(parsed) : [];
  } catch {
    return [];
  }
}

function normalizeEvidence(raw: unknown[]): DevelopmentRequestEvidence[] {
  return raw
    .filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object' && !Array.isArray(entry),
    )
    .map((entry) => ({
      url: typeof entry.url === 'string' ? entry.url.trim() : '',
      ...(typeof entry.label === 'string' && entry.label.trim().length > 0
        ? { label: entry.label.trim() }
        : {}),
    }))
    .filter((entry) => entry.url.length > 0);
}

function stringifyEvidence(items: DevelopmentRequestEvidence[]): string {
  return JSON.stringify(
    items.map((item) => ({
      url: item.url.trim(),
      ...(item.label?.trim() ? { label: item.label.trim() } : {}),
    })),
  );
}

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'development_requests',
  // Managed requests must flow through ManagedProjectClient so capability,
  // integration, project, and requester scoping cannot be bypassed.
  api: false,
  mcp: false,
  cli: false,
})
export class DevelopmentRequest extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  projectId: string = '';

  @foreignKey('ProjectIntegration', { required: true })
  integrationId: string = '';

  requesterId: string = '';

  participantId: string = '';

  type: DevelopmentRequestType = 'feature';

  description: string = '';

  evidence: string = '[]';

  visibility: DevelopmentRequestVisibility = 'requester';

  origin: DevelopmentRequestOrigin = 'managed-app';

  discussion: string = '';

  status: DevelopmentRequestStatus = 'submitted';

  constructor(options: DevelopmentRequestOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.projectId !== undefined) this.projectId = options.projectId;
    if (options.integrationId !== undefined)
      this.integrationId = options.integrationId;
    if (options.requesterId !== undefined)
      this.requesterId = options.requesterId;
    if (options.participantId !== undefined)
      this.participantId = options.participantId;
    if (options.type !== undefined) this.type = options.type;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.evidence !== undefined) this.setEvidence(options.evidence);
    if (options.visibility !== undefined) this.visibility = options.visibility;
    if (options.origin !== undefined) this.origin = options.origin;
    if (options.discussion !== undefined) this.discussion = options.discussion;
    if (options.status !== undefined) this.status = options.status;
  }

  public override async initialize(): Promise<this> {
    await super.initialize();
    if ((this as unknown as { evidence?: unknown }).evidence == null) {
      this.evidence = '[]';
    } else if (typeof this.evidence !== 'string') {
      this.setEvidence(
        this.evidence as unknown as DevelopmentRequestEvidence[],
      );
    }
    return this;
  }

  getEvidence(): DevelopmentRequestEvidence[] {
    return parseEvidence(this.evidence);
  }

  setEvidence(value: DevelopmentRequestEvidence[] | string): void {
    this.evidence =
      typeof value === 'string' ? value : stringifyEvidence(value);
  }
}
