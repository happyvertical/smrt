/** Append-only evidence of one verified provider webhook event. */

import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type {
  AgreementExecutionEventOptions,
  AgreementExecutionStatus,
} from '../types.js';
import { coerceAgreementDate } from '../types.js';

const persistedEventState = new WeakMap<AgreementExecutionEvent, string>();

@TenantScoped({ mode: 'required' })
@smrt({
  conflictColumns: ['tenant_id', 'dedupe_key'],
  api: false,
  mcp: false,
  cli: false,
})
export class AgreementExecutionEvent extends SmrtObject {
  @tenantId()
  tenantId: string = '';

  @foreignKey('AgreementExecution', { required: true })
  executionId: string = '';

  provider: string = '';
  providerEventId: string = '';
  eventOrigin: string = 'provider_webhook';
  operationId: string = '';

  @field({ required: true })
  dedupeKey: string = '';

  orderingKey: string = '';
  eventType: string = '';
  status: AgreementExecutionStatus = 'prepared';
  occurredAt: Date = new Date();
  receivedAt: Date = new Date();
  payloadSha256: string = '';
  signerEvidence: string = '[]';
  payload: string = '{}';

  constructor(options: AgreementExecutionEventOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.executionId !== undefined)
      this.executionId = options.executionId;
    if (options.provider !== undefined) this.provider = options.provider;
    if (options.providerEventId !== undefined)
      this.providerEventId = options.providerEventId;
    if (options.eventOrigin !== undefined)
      this.eventOrigin = options.eventOrigin;
    if (options.operationId !== undefined)
      this.operationId = options.operationId;
    if (options.dedupeKey !== undefined) this.dedupeKey = options.dedupeKey;
    if (options.orderingKey !== undefined)
      this.orderingKey = options.orderingKey;
    if (options.eventType !== undefined) this.eventType = options.eventType;
    if (options.status !== undefined) this.status = options.status;
    if (options.occurredAt !== undefined)
      this.occurredAt = coerceAgreementDate(options.occurredAt) ?? new Date();
    if (options.receivedAt !== undefined)
      this.receivedAt = coerceAgreementDate(options.receivedAt) ?? new Date();
    if (options.payloadSha256 !== undefined)
      this.payloadSha256 = options.payloadSha256;
    if (options.signerEvidence !== undefined)
      this.signerEvidence = options.signerEvidence;
    if (options.payload !== undefined) this.payload = options.payload;
  }

  override async initialize(): Promise<this> {
    await super.initialize();
    this.occurredAt = coerceAgreementDate(this.occurredAt) ?? new Date();
    this.receivedAt = coerceAgreementDate(this.receivedAt) ?? new Date();
    if (this.isPersisted) persistedEventState.set(this, this.serializeState());
    return this;
  }

  override async save(): Promise<this> {
    const captured = persistedEventState.get(this);
    if (captured !== undefined && captured !== this.serializeState()) {
      throw new Error(
        `AgreementExecutionEvent ${this.id ?? '<new>'}: verified events are immutable`,
      );
    }
    if (captured === undefined && !this.isPersisted) this.requireInsertOnSave();
    const result = (await super.save()) as this;
    persistedEventState.set(this, this.serializeState());
    return result;
  }

  private serializeState(): string {
    return JSON.stringify({
      tenantId: this.tenantId,
      executionId: this.executionId,
      provider: this.provider,
      providerEventId: this.providerEventId,
      eventOrigin: this.eventOrigin,
      operationId: this.operationId,
      dedupeKey: this.dedupeKey,
      orderingKey: this.orderingKey,
      eventType: this.eventType,
      status: this.status,
      occurredAt: this.occurredAt.toISOString(),
      receivedAt: this.receivedAt.toISOString(),
      payloadSha256: this.payloadSha256,
      signerEvidence: this.signerEvidence,
      payload: this.payload,
    });
  }
}

export default AgreementExecutionEvent;
