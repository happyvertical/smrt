/** Immutable intent/result audit for seller governance operations. */
import {
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

import { assertGovernanceWrite } from '../services/governance-write.js';

export interface SalesGovernanceEventOptions extends SmrtObjectOptions {
  tenantId?: string;
  intent?: string;
  result?: string;
}
const snapshots = new WeakMap<SalesGovernanceEvent, string>();

/** UUID replay fence and immutable audit; no generated mutation surface. */
@TenantScoped({ mode: 'required' })
@smrt({ api: false, mcp: false, cli: false })
export class SalesGovernanceEvent extends SmrtObject {
  @tenantId()
  tenantId: string = '';
  intent: string = '';
  result: string = '';

  constructor(options: SalesGovernanceEventOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.intent !== undefined) this.intent = options.intent;
    if (options.result !== undefined) this.result = options.result;
  }

  override async initialize(): Promise<this> {
    await super.initialize();
    if (await this.isSaved()) snapshots.set(this, this.snapshot());
    return this;
  }

  override async save(): Promise<this> {
    const previous = snapshots.get(this);
    if (previous !== undefined && previous !== this.snapshot()) {
      throw new Error('Sales governance events are immutable');
    }
    assertGovernanceWrite(this.db);
    await super.save();
    snapshots.set(this, this.snapshot());
    return this;
  }

  override async delete(): Promise<void> {
    throw new Error('Sales governance events cannot be deleted');
  }

  private snapshot(): string {
    return JSON.stringify([this.tenantId, this.intent, this.result]);
  }
}
