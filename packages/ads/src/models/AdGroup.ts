/**
 * AdGroup model - Campaign targeting and creative organization
 * @packageDocumentation
 */

import { foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { AdGroupStatus } from '../types/index.js';
import { AdDeliveryTier } from './AdDeliveryTier.js';

/**
 * AdGroup organizes ad creatives with targeting and budget controls.
 *
 * References:
 * - tierId: FK to AdDeliveryTier (within package)
 * - contractId: String reference to smrt-commerce Contract (cross-package)
 * - zoneIds: JSON array of allowed smrt-properties Zone IDs (cross-package)
 * - verticalSlug: Tag slug from smrt-tags (cross-package)
 *
 * @example
 * ```typescript
 * const adGroup = await groups.create({
 *   contractId: 'contract-uuid',
 *   tierId: tier.id,
 *   name: 'Summer Sale - Desktop',
 *   verticalSlug: 'retail',
 *   targeting: JSON.stringify({ device: 'desktop' }),
 *   zoneIds: JSON.stringify(['zone-1', 'zone-2']),
 *   dailyBudget: 100.00,
 *   totalBudget: 3000.00,
 *   startDate: new Date('2024-06-01'),
 *   endDate: new Date('2024-08-31')
 * });
 * ```
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class AdGroup extends SmrtObject {
  /**
   * Tenant ID for multi-tenancy support
   */
  tenantId = tenantId({ nullable: true });

  /**
   * Contract ID (FK to smrt-commerce Contract, cross-package)
   */
  contractId: string = '';

  /**
   * Delivery tier ID (FK to AdDeliveryTier)
   */
  tierId = foreignKey(AdDeliveryTier);

  /**
   * Display name (e.g., "Summer Sale - Desktop")
   */
  name: string = '';

  /**
   * Vertical/category tag slug from smrt-tags (context="advertising")
   */
  verticalSlug: string = '';

  /**
   * Targeting rules as JSON string
   */
  targeting: string = '';

  /**
   * Allowed Zone IDs as JSON array string (FK to smrt-properties Zone)
   */
  zoneIds: string = '';

  /**
   * Campaign start date
   */
  startDate: Date | null = null;

  /**
   * Campaign end date
   */
  endDate: Date | null = null;

  /**
   * Daily budget limit
   */
  dailyBudget: number = 0.0;

  /**
   * Total campaign budget
   */
  totalBudget: number = 0.0;

  /**
   * Current status
   */
  status: AdGroupStatus = AdGroupStatus.DRAFT;

  constructor(options: any = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.contractId !== undefined) this.contractId = options.contractId;
    if (options.tierId !== undefined) this.tierId = options.tierId;
    if (options.name !== undefined) this.name = options.name;
    if (options.verticalSlug !== undefined)
      this.verticalSlug = options.verticalSlug;
    if (options.targeting !== undefined) this.targeting = options.targeting;
    if (options.zoneIds !== undefined) this.zoneIds = options.zoneIds;
    if (options.startDate !== undefined) this.startDate = options.startDate;
    if (options.endDate !== undefined) this.endDate = options.endDate;
    if (options.dailyBudget !== undefined)
      this.dailyBudget = options.dailyBudget;
    if (options.totalBudget !== undefined)
      this.totalBudget = options.totalBudget;
    if (options.status !== undefined) this.status = options.status;
  }

  /**
   * Get zone IDs as array
   */
  getZoneIds(): string[] {
    if (!this.zoneIds) return [];
    try {
      return JSON.parse(this.zoneIds);
    } catch {
      return [];
    }
  }

  /**
   * Set zone IDs from array
   */
  setZoneIds(ids: string[]): void {
    this.zoneIds = JSON.stringify(ids);
  }

  /**
   * Add a zone ID
   */
  addZoneId(zoneId: string): void {
    const ids = this.getZoneIds();
    if (!ids.includes(zoneId)) {
      ids.push(zoneId);
      this.setZoneIds(ids);
    }
  }

  /**
   * Remove a zone ID
   */
  removeZoneId(zoneId: string): void {
    const ids = this.getZoneIds().filter((id) => id !== zoneId);
    this.setZoneIds(ids);
  }

  /**
   * Check if zone ID is allowed
   */
  hasZoneId(zoneId: string): boolean {
    return this.getZoneIds().includes(zoneId);
  }

  /**
   * Get targeting rules as object
   */
  getTargeting(): Record<string, any> {
    if (!this.targeting) return {};
    try {
      return JSON.parse(this.targeting);
    } catch {
      return {};
    }
  }

  /**
   * Set targeting rules from object
   */
  setTargeting(rules: Record<string, any>): void {
    this.targeting = JSON.stringify(rules);
  }

  /**
   * Check if ad group is currently active
   */
  isActive(): boolean {
    if (this.status !== AdGroupStatus.ACTIVE) return false;
    const now = new Date();
    if (this.startDate && now < this.startDate) return false;
    if (this.endDate && now > this.endDate) return false;
    return true;
  }

  /**
   * Check if ad group is in draft state
   */
  isDraft(): boolean {
    return this.status === AdGroupStatus.DRAFT;
  }

  /**
   * Check if ad group is paused
   */
  isPaused(): boolean {
    return this.status === AdGroupStatus.PAUSED;
  }

  /**
   * Check if ad group is completed
   */
  isCompleted(): boolean {
    return this.status === AdGroupStatus.COMPLETED;
  }

  /**
   * Check if ad group has ended (past end date)
   */
  hasEnded(): boolean {
    if (!this.endDate) return false;
    return new Date() > this.endDate;
  }

  /**
   * Check if ad group has started
   */
  hasStarted(): boolean {
    if (!this.startDate) return true;
    return new Date() >= this.startDate;
  }
}

export default AdGroup;
