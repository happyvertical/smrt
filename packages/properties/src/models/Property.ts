/**
 * Property model - Digital property representation
 *
 * Represents a digital property (website, app, publication) that can contain
 * hierarchical zones for content/ad placement.
 */

import { crossPackageRef, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { resolvePrompt } from '@happyvertical/smrt-prompts';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import {
  promptMessageOptions,
  smrtPropertiesSummarizePrompt,
} from '../prompts';
import type { PropertyOptions, PropertyStatus } from '../types';

@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create'] },
  cli: true,
})
export class Property extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * Display name of the property
   */
  name: string = '';

  /**
   * Domain name (e.g., "oakcreeknews.com")
   */
  domain: string = '';

  /**
   * Full URL (e.g., "https://oakcreeknews.com")
   */
  url: string = '';

  /**
   * Property description
   */
  description: string = '';

  /**
   * Link to Repository (from smrt-projects)
   * Optional - used when property is backed by a git repository
   */
  @crossPackageRef('@happyvertical/smrt-projects:Repository')
  repositoryId: string | null = null;

  /**
   * Link to Profile (from smrt-profiles)
   * Optional - owner/publisher of the property
   */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  ownerId: string | null = null;

  /**
   * Property status
   */
  status: PropertyStatus = 'active';

  /**
   * Extensible metadata (analytics IDs, config, etc.)
   */
  metadata: Record<string, unknown> = {};

  constructor(options: PropertyOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.name !== undefined) this.name = options.name;
    if (options.domain !== undefined) this.domain = options.domain;
    if (options.url !== undefined) this.url = options.url;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.repositoryId !== undefined)
      this.repositoryId = options.repositoryId;
    if (options.ownerId !== undefined) this.ownerId = options.ownerId;
    if (options.status !== undefined) this.status = options.status;
    if (options.metadata !== undefined) this.metadata = options.metadata;
  }

  /**
   * Get all zones for this property
   */
  async getZones(): Promise<import('./Zone').Zone[]> {
    if (!this.id) return [];
    const { ZoneCollection } = await import('../collections/Zones');
    const collection = await ZoneCollection.create(this.options);
    return await collection.findByProperty(this.id);
  }

  /**
   * Get zone tree for this property
   */
  async getZoneTree(): Promise<
    import('../types').ZoneTree<import('./Zone').Zone>
  > {
    if (!this.id) return { propertyId: '', roots: [] };
    const { ZoneCollection } = await import('../collections/Zones');
    const collection = await ZoneCollection.create(this.options);
    return await collection.getTree(this.id);
  }

  /**
   * Create a zone on this property
   */
  async createZone(
    options: Omit<import('../types').ZoneOptions, 'propertyId'>,
  ): Promise<import('./Zone').Zone> {
    if (!this.id) {
      throw new Error('Property must be saved before creating zones');
    }
    const { ZoneCollection } = await import('../collections/Zones');
    const collection = await ZoneCollection.create(this.options);
    const zone = await collection.create({
      ...options,
      propertyId: this.id,
    });
    await zone.save();
    return zone;
  }

  /**
   * Check if property is active
   */
  isActive(): boolean {
    return this.status === 'active';
  }

  /**
   * AI-powered: Generate a summary of the property and its zones.
   *
   * Uses the `smrtProperties.property.summarize` prompt registered via
   * `@happyvertical/smrt-prompts`, allowing tenant- or instance-level
   * overrides of the template, model, and parameters at runtime.
   *
   * Only non-PII fields (name, domain, description, status) plus aggregate
   * zone information are sent to the AI provider. Internal foreign-key
   * fields and the extensible `metadata` blob are intentionally excluded.
   *
   * @returns Generated summary text
   */
  async summarize(): Promise<string> {
    const zones = await this.getZones();
    const topLevelZones = zones.filter((z) => z.parentId === null);

    // Resolve `db` from either the canonical `db` option or its `persistence`
    // alias. SmrtClass maps `persistence → db` lazily during `initialize()`,
    // so on a freshly-constructed Property that has not yet been initialized,
    // `this.options.db` may be undefined while `this.options.persistence` is
    // set. Falling back here ensures stored app- and tenant-level prompt
    // overrides in `_smrt_prompt_overrides` are honored on the first call —
    // before `getAiClient()` triggers full initialization further below.
    const db = this.options.db ?? this.options.persistence;

    const resolvedPrompt = await resolvePrompt(
      smrtPropertiesSummarizePrompt.key,
      {
        db,
        tenantId: this.tenantId,
        variables: {
          propertyName: this.name || '',
          propertyDomain: this.domain || '',
          propertyDescription: this.description || '',
          propertyStatus: this.status || '',
          totalZones: String(zones.length),
          topLevelZones: topLevelZones.map((z) => z.name).join(', '),
        },
      },
    );

    const ai = await this.getAiClient();
    const response = await ai.message(
      resolvedPrompt.text,
      promptMessageOptions(resolvedPrompt.ai),
    );

    return response.trim();
  }
}
