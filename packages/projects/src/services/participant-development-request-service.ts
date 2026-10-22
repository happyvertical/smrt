import { createHash } from 'node:crypto';
import type { SmrtClassOptions } from '@happyvertical/smrt-core';
import {
  assertTenantReadAllowed,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { DevelopmentRequestCollection } from '../collections/DevelopmentRequests.js';
import type { DevelopmentRequest } from '../models/DevelopmentRequest.js';
import type { DevelopmentRequestVisibility } from '../types.js';

export interface ParticipantDevelopmentRequestInput {
  tenantId: string;
  projectId: string;
  /** Trusted identity supplied after the host authorizes project participation. */
  requesterId: string;
  requestKey: string;
  type: 'bug' | 'feature' | 'task';
  description: string;
  visibility?: DevelopmentRequestVisibility;
}

export class ParticipantDevelopmentRequestConflictError extends Error {
  constructor() {
    super(
      'This request key has already been used for different request details.',
    );
    this.name = 'ParticipantDevelopmentRequestConflictError';
  }
}

/** Human participant intake, separate from credential-authenticated managed ingress. */
export class ParticipantDevelopmentRequestService {
  private constructor(
    private readonly requests: DevelopmentRequestCollection,
  ) {}

  static async create(
    options: SmrtClassOptions = {},
  ): Promise<ParticipantDevelopmentRequestService> {
    return new ParticipantDevelopmentRequestService(
      await DevelopmentRequestCollection.create(options),
    );
  }

  async submit(
    input: ParticipantDevelopmentRequestInput,
  ): Promise<DevelopmentRequest> {
    for (const value of [
      input.tenantId,
      input.projectId,
      input.requesterId,
      input.requestKey,
    ]) {
      if (typeof value !== 'string' || !value.trim() || value.length > 200) {
        throw new TypeError(
          'A tenant, project, participant and request key are required.',
        );
      }
    }
    assertTenantReadAllowed(
      input.tenantId,
      'ParticipantDevelopmentRequestService',
    );
    if (!['bug', 'feature', 'task'].includes(input.type))
      throw new TypeError('Choose a valid request type.');
    const description = input.description?.trim();
    if (!description || description.length > 8000)
      throw new TypeError('Describe the request in at most 8000 characters.');
    const visibility = input.visibility ?? 'requester';
    if (
      ![
        'requester',
        'project_team',
        'workspace',
        'public',
        'internal',
      ].includes(visibility)
    ) {
      throw new TypeError('Choose a valid request visibility.');
    }
    const identity = JSON.stringify([
      input.tenantId,
      input.projectId,
      input.requesterId,
      input.requestKey,
    ]);
    const id = stableId(`participant-request:${identity}`);
    const historyId = stableId(`participant-request-history:${identity}`);
    const db = this.requests.db;
    if (!db.transaction)
      throw new Error('Participant request intake requires transactions.');
    const transaction = db.transaction.bind(db);
    return withTenant({ tenantId: input.tenantId }, () =>
      transaction(async (tx) => {
        // Primary-key conflict serialization protects concurrent retries across runtimes.
        // Never UPSERT mutable payload: a reused key cannot replace accepted work.
        await tx.query(
          `INSERT INTO development_requests
          (id, slug, context, tenant_id, project_id, integration_id, requester_id,
           participant_id, type, description, evidence, visibility, origin, discussion, status)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, '[]', ?, 'participant', '', 'submitted')
         ON CONFLICT (id) DO NOTHING`,
          id,
          `participant-${id}`,
          '',
          input.tenantId,
          input.projectId,
          input.requesterId,
          input.requesterId,
          input.type,
          description,
          visibility,
        );
        const requests = await DevelopmentRequestCollection.create({ db: tx });
        const request = await requests.findOne({
          where: { id, tenantId: input.tenantId, projectId: input.projectId },
        });
        if (
          !request ||
          request.requesterId !== input.requesterId ||
          request.description !== description ||
          request.type !== input.type ||
          request.visibility !== visibility ||
          request.integrationId ||
          request.origin !== 'participant'
        ) {
          throw new ParticipantDevelopmentRequestConflictError();
        }
        await tx.query(
          `INSERT INTO development_request_histories
          (id, slug, context, tenant_id, request_id, from_status, to_status, actor_type, actor_id, note)
         VALUES (?, ?, '', ?, ?, '', 'submitted', 'participant', ?, '')
         ON CONFLICT (id) DO NOTHING`,
          historyId,
          `participant-${historyId}`,
          input.tenantId,
          id,
          input.requesterId,
        );
        return request;
      }),
    );
  }
}

function stableId(value: string): string {
  const hash = createHash('sha256').update(value).digest('hex');
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
