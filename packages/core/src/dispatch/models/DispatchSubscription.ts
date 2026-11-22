/**
 * DispatchSubscription Model - Persistent subscription for dispatch processing
 *
 * Subscriptions are stored in _smrt_dispatch_subscriptions and define which
 * agents should receive which dispatch types. Supports wildcard patterns.
 */

import { makeId } from '@happyvertical/utils';
import { toSafeBooleanInteger } from '../../utils/safe-integer.js';
import { matchesDispatchPattern } from '../pattern.js';

/**
 * Raw subscription data as stored in the database
 */
export interface DispatchSubscriptionData {
  id: string;
  signal_type: string;
  subscriber: string;
  handler: string;
  delivery: string;
  enabled: number | string | bigint | null;
  tenant_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * DispatchSubscription model for persistent dispatch routing
 */
export class DispatchSubscription {
  /** Table name for this model */
  static readonly tableName = '_smrt_dispatch_subscriptions';

  /** Unique identifier */
  id: string;

  /** Signal type pattern (supports wildcards like 'campaign.*') */
  signalType: string;

  /** Subscriber name (usually agent name) */
  subscriber: string;

  /** Handler method name */
  handler: string;

  /** Delivery mode: 'compete' (first-to-claim) or 'fanout' (per-subscriber copy) */
  delivery: 'compete' | 'fanout';

  /** Whether subscription is active */
  enabled: boolean;

  /**
   * Tenant the subscription was registered in (server-derived). `null` for
   * global / non-tenant subscriptions. Recorded for auditing and per-tenant
   * subscription separation (S5 #1398).
   */
  tenantId: string | null;

  /** Creation timestamp */
  createdAt: Date;

  /** Last update timestamp */
  updatedAt: Date;

  constructor(data: Partial<DispatchSubscriptionData> = {}) {
    this.id = data.id || makeId();
    this.signalType = data.signal_type || '';
    this.subscriber = data.subscriber || '';
    this.handler = data.handler || 'handleDispatch';
    this.delivery = (data.delivery as 'compete' | 'fanout') || 'compete';
    this.enabled =
      data.enabled != null
        ? toSafeBooleanInteger(
            data.enabled,
            'Dispatch subscription enabled flag',
          )
        : true;
    this.tenantId = data.tenant_id ?? null;
    this.createdAt = data.created_at ? new Date(data.created_at) : new Date();
    this.updatedAt = data.updated_at ? new Date(data.updated_at) : new Date();
  }

  /**
   * Create a DispatchSubscription from a database row
   */
  static fromRow(row: DispatchSubscriptionData): DispatchSubscription {
    return new DispatchSubscription(row);
  }

  /**
   * Convert to database row format
   */
  toRow(): DispatchSubscriptionData {
    return {
      id: this.id,
      signal_type: this.signalType,
      subscriber: this.subscriber,
      handler: this.handler,
      delivery: this.delivery,
      enabled: this.enabled ? 1 : 0,
      tenant_id: this.tenantId ?? null,
      created_at: this.createdAt.toISOString(),
      updated_at: new Date().toISOString(),
    };
  }

  /**
   * Check if this subscription matches a given signal type
   *
   * Every `*` stands for one or more characters other than `.`; everything
   * else is literal and case-sensitive:
   * - 'campaign.*' matches 'campaign.started', 'campaign.completed'
   * - '*' matches any single-segment type ('deploy'), not 'a.b'
   * - 'campaign.*.completed' matches 'campaign.summer.completed'
   * - 'invoice.v*' matches 'invoice.v2', not 'invoice.v'
   *
   * Uses the shared compiler (`dispatch/pattern.ts`) that also builds the SQL
   * candidate predicate of `DispatchBus.process()`, so both always agree.
   *
   * @param signalType - The signal type to match against
   * @returns True if this subscription matches the signal type
   */
  matches(signalType: string): boolean {
    if (!this.enabled) {
      return false;
    }
    return matchesDispatchPattern(this.signalType, signalType);
  }

  /**
   * Check if this is a wildcard subscription
   */
  isWildcard(): boolean {
    return this.signalType.includes('*');
  }

  /**
   * Enable this subscription
   */
  enable(): void {
    this.enabled = true;
    this.updatedAt = new Date();
  }

  /**
   * Disable this subscription
   */
  disable(): void {
    this.enabled = false;
    this.updatedAt = new Date();
  }
}
