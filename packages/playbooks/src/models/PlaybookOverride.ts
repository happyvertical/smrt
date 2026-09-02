import { getPackageConfig } from '@happyvertical/smrt-config';
import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { invalidatePlaybookCache } from '../cache.js';
import { PlaybookRegistry } from '../playbook-registry.js';
import type {
  PlaybookConfigOverrideInput,
  PlaybookFailurePolicy,
  PlaybookLayer,
  PlaybookMetadata,
  PlaybookOverrideOptions as PlaybookOverrideFieldOptions,
  PlaybookPackageConfig,
  PlaybookPlane,
} from '../types.js';
import {
  mergePlaybookLayers,
  normalizePlaybookLayer,
  parseMetadata,
  parsePlanes,
  serializeMetadata,
  serializePlanes,
} from '../utils.js';

export interface PlaybookOverrideOptions
  extends SmrtObjectOptions,
    PlaybookOverrideFieldOptions {}

type PlaybookOverrideIdentity = {
  key: string;
  tenantId: string | null;
};

type PlaybookTransactionHandle = DatabaseInterface & {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

function getPlaybookConfig(): PlaybookPackageConfig {
  return getPackageConfig<PlaybookPackageConfig>('playbooks', {
    playbooks: {},
  });
}

/**
 * Stored app-level (`tenantId = null`) and tenant-level playbook overrides.
 *
 * There is deliberately **no `steps` column**. `steps` is structurally
 * non-editable: an override layer has nowhere to put a step list, and
 * assigning one is rejected in `save()` rather than silently dropped. That is
 * the description-behavior guarantee from epic #2585 — an agent announcing
 * "checking out your cart" must not be following a rewritten script.
 */
@smrt({
  tableName: '_smrt_playbook_overrides',
  conflictColumns: ['key', 'context'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: {
    include: ['list', 'get', 'create', 'update', 'delete'],
    exclude: [
      'getMetadata',
      'setMetadata',
      'getPlanes',
      'setPlanes',
      'toPlaybookLayer',
    ],
  },
  mcp: { include: [] },
})
export class PlaybookOverride extends SmrtObject {
  @field({ required: true })
  key: string = '';

  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text', nullable: true })
  title: string | null = null;

  @field({ type: 'text', nullable: true })
  description: string | null = null;

  /** JSON array of plane names; null inherits the lower layer. */
  @field({ type: 'text', nullable: true })
  planes: string | null = null;

  @field({ type: 'text', nullable: true })
  onStepFailure: string | null = null;

  /** Tri-state: null inherits, false disables. True can never widen. */
  @field({ type: 'boolean', nullable: true })
  enabled: boolean | null = null;

  /** JSON object; stored as a string with guarded get/set helpers. */
  @field({ type: 'text', nullable: true })
  metadata: string | null = null;

  constructor(options: PlaybookOverrideOptions = {}) {
    super(options);

    // `SmrtCollection.create()` spreads its caller's option bag straight into
    // the constructor, so this is the entry point a `steps` key actually
    // reaches. Reject it loudly instead of letting it be silently dropped:
    // step lists are never editable through any path.
    if ((options as Record<string, unknown>).steps !== undefined) {
      throw new Error(
        'Playbook step lists are never editable; PlaybookOverride cannot carry steps',
      );
    }

    if (options.key !== undefined) this.key = options.key;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.title !== undefined) this.title = options.title;
    if (options.description !== undefined)
      this.description = options.description;
    if (options.onStepFailure !== undefined)
      this.onStepFailure = options.onStepFailure;
    if (options.enabled !== undefined) this.enabled = options.enabled;
    if (options.planes !== undefined) {
      this.planes =
        typeof options.planes === 'string' || options.planes === null
          ? options.planes
          : serializePlanes(options.planes);
    }
    if (options.metadata !== undefined) {
      this.metadata =
        typeof options.metadata === 'string' || options.metadata === null
          ? options.metadata
          : serializeMetadata(options.metadata);
    }
  }

  getMetadata(): PlaybookMetadata {
    return parseMetadata(this.metadata);
  }

  setMetadata(metadata: PlaybookMetadata | null): void {
    this.metadata = serializeMetadata(metadata);
  }

  getPlanes(): readonly PlaybookPlane[] | null {
    return parsePlanes(this.planes);
  }

  setPlanes(planes: readonly PlaybookPlane[] | null): void {
    this.planes = serializePlanes(planes);
  }

  toPlaybookLayer(): PlaybookLayer {
    return {
      title: this.title,
      description: this.description,
      planes: this.getPlanes(),
      onStepFailure: (this.onStepFailure ??
        null) as PlaybookFailurePolicy | null,
      // The database boundary is where coercion is legitimate: SQLite hydrates
      // a boolean column as 0/1. Everywhere above this, enablement is
      // validated rather than coerced.
      enabled:
        this.enabled === null || this.enabled === undefined
          ? null
          : Boolean(this.enabled),
      metadata: this.metadata === null ? null : this.getMetadata(),
    };
  }

  override async save(): Promise<this> {
    const previousIdentity = await this.getPersistedIdentity();
    this.normalizeForPersistence();
    await this.validatePlaybookOverride();
    // `context` is the conflictColumn-friendly scope: '__app__' for a nullable
    // tenant, tenantId otherwise. Mirrors PromptOverride / LanguageOverride so
    // app-level rows stay unique on PostgreSQL, SQLite, and DuckDB alike,
    // where multiple NULLs would otherwise all satisfy a unique index.
    this.context = this.tenantId ?? '__app__';

    const identityChanged =
      !!previousIdentity &&
      (previousIdentity.key !== this.key ||
        previousIdentity.tenantId !== this.tenantId);

    const result =
      identityChanged && previousIdentity
        ? await this.saveAfterIdentityChange()
        : await super.save();

    if (identityChanged && previousIdentity) {
      invalidatePlaybookCache(
        previousIdentity.key,
        previousIdentity.tenantId,
        this.db,
      );
    }
    invalidatePlaybookCache(this.key, this.tenantId, this.db);
    return result;
  }

  private async saveAfterIdentityChange(): Promise<this> {
    if (typeof this.db.beginTransaction === 'function') {
      return this.saveAfterIdentityChangeInTransaction();
    }

    return this.saveAfterIdentityChangeWithDeferredDelete();
  }

  private async saveAfterIdentityChangeInTransaction(): Promise<this> {
    const originalDb = this._db;
    const originalOptionsDb = this.options.db;
    const tx = (await this.db.beginTransaction?.()) as
      | PlaybookTransactionHandle
      | undefined;

    if (!tx) {
      return this.saveAfterIdentityChangeWithDeferredDelete();
    }

    try {
      this._db = tx;
      this.options.db = tx;
      await super.delete();
      const result = await super.save();
      await tx.commit();
      return result;
    } catch (error) {
      try {
        await tx.rollback();
      } catch {
        // Preserve the original save error; rollback failures are secondary.
      }
      throw error;
    } finally {
      this._db = originalDb;
      this.options.db = originalOptionsDb;
    }
  }

  private async saveAfterIdentityChangeWithDeferredDelete(): Promise<this> {
    const previousId = this.id;
    if (!previousId) {
      return super.save();
    }

    const replacementId = crypto.randomUUID();
    let replacementSaved = false;
    this.id = replacementId;

    try {
      const result = await super.save();
      replacementSaved = true;
      await this.db.delete(this.tableName, { id: previousId });
      return result;
    } catch (error) {
      if (replacementSaved) {
        try {
          await this.db.delete(this.tableName, { id: replacementId });
        } catch {
          // Best effort cleanup keeps the original row as the source of truth.
        }
      }

      this.id = previousId;
      throw error;
    }
  }

  override async delete(): Promise<void> {
    const key = this.key;
    const tenantId = this.tenantId;
    await super.delete();
    invalidatePlaybookCache(key, tenantId, this.db);
  }

  private async validatePlaybookOverride(): Promise<void> {
    if (!this.key || this.key.trim() === '') {
      throw new Error('PlaybookOverride.key is required');
    }

    // Structural, not merely defaulted-false: there is no `steps` column, and
    // a caller assigning one through the untyped option bag is rejected here
    // rather than having the value silently dropped by persistence.
    const assignedSteps = (this as unknown as Record<string, unknown>).steps;
    if (assignedSteps !== undefined) {
      throw new Error(
        `Playbook "${this.key}" step lists are never editable; PlaybookOverride cannot carry steps`,
      );
    }

    const definition = PlaybookRegistry.get(this.key);
    if (!definition) {
      throw new Error(`Unknown playbook key "${this.key}"`);
    }

    const editable = definition.editable;

    if (this.title !== null && !editable.title) {
      throw new Error(`Playbook "${this.key}" does not allow title overrides`);
    }

    if (this.description !== null && !editable.description) {
      throw new Error(
        `Playbook "${this.key}" does not allow description overrides`,
      );
    }

    if (this.planes !== null && !editable.planes) {
      throw new Error(`Playbook "${this.key}" does not allow planes overrides`);
    }

    if (this.onStepFailure !== null && !editable.onStepFailure) {
      throw new Error(
        `Playbook "${this.key}" does not allow onStepFailure overrides`,
      );
    }

    if (this.enabled !== null && !editable.enabled) {
      throw new Error(
        `Playbook "${this.key}" does not allow enablement overrides`,
      );
    }

    if (this.metadata !== null && !editable.metadata) {
      throw new Error(
        `Playbook "${this.key}" does not allow metadata overrides`,
      );
    }

    if (this.metadata !== null) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(this.metadata);
      } catch (error) {
        throw new Error(
          `Playbook "${this.key}" has invalid metadata JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }

      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(
          `Playbook "${this.key}" metadata must be a JSON object`,
        );
      }
    }

    if (this.planes !== null) {
      const parsedPlanes = parsePlanes(this.planes);
      if (!parsedPlanes || parsedPlanes.length === 0) {
        throw new Error(
          `Playbook "${this.key}" planes must be a non-empty JSON array of plane names`,
        );
      }
    }

    if (
      this.onStepFailure !== null &&
      this.onStepFailure !== 'abort' &&
      this.onStepFailure !== 'continue'
    ) {
      throw new Error(
        `Playbook "${this.key}" onStepFailure must be "abort" or "continue"`,
      );
    }

    const lowerLayers = await this.getLowerPrecedenceLayers();
    const currentLayer = this.toPlaybookLayer();
    const lowerMerged = mergePlaybookLayers(definition, ...lowerLayers);

    // Enablement is one-directional: a layer may disable, never re-enable
    // something a lower layer disabled.
    if (this.enabled === true && !lowerMerged.enabled) {
      throw new Error(
        `Playbook "${this.key}" is disabled by a lower layer and cannot be re-enabled by an override`,
      );
    }

    // Plane validity narrows only; an override cannot claim a plane the lower
    // layers never declared.
    if (currentLayer.planes) {
      const widened = currentLayer.planes.filter(
        (plane) => !lowerMerged.planes.includes(plane),
      );
      if (widened.length > 0) {
        throw new Error(
          `Playbook "${this.key}" cannot add plane(s) ${widened.join(', ')} that no lower layer declares`,
        );
      }
    }
  }

  private async getLowerPrecedenceLayers(): Promise<PlaybookLayer[]> {
    const config = getPlaybookConfig();
    const layers: PlaybookLayer[] = [
      normalizePlaybookLayer(
        config.playbooks?.[this.key] as PlaybookConfigOverrideInput | undefined,
        `Playbook "${this.key}" config override`,
      ),
    ];

    const { PlaybookOverrideCollection } = await import(
      '../collections/PlaybookOverrideCollection.js'
    );
    const collection = await PlaybookOverrideCollection.create({
      db: this.options.db ?? this.options.persistence,
    });

    if (this.tenantId) {
      const appOverride = await collection.getAppOverride(this.key, {
        excludeId: this.id ?? undefined,
      });
      if (appOverride) {
        layers.push(appOverride.toPlaybookLayer());
      }
    }

    return layers;
  }

  private normalizeForPersistence(): void {
    const rawMetadata = this.metadata as unknown;
    if (rawMetadata === undefined) {
      this.metadata = null;
    } else if (
      rawMetadata !== null &&
      typeof rawMetadata === 'object' &&
      !Array.isArray(rawMetadata)
    ) {
      this.metadata = serializeMetadata(rawMetadata as PlaybookMetadata);
    } else if (rawMetadata !== null && typeof rawMetadata !== 'string') {
      throw new Error(
        `Playbook "${this.key}" metadata must be a JSON object or JSON string`,
      );
    }

    const rawPlanes = this.planes as unknown;
    if (rawPlanes === undefined) {
      this.planes = null;
    } else if (Array.isArray(rawPlanes)) {
      this.planes = serializePlanes(rawPlanes as PlaybookPlane[]);
    } else if (rawPlanes !== null && typeof rawPlanes !== 'string') {
      throw new Error(
        `Playbook "${this.key}" planes must be an array or JSON string`,
      );
    }

    if (this.enabled === undefined) {
      this.enabled = null;
    }
  }

  private async getPersistedIdentity(): Promise<PlaybookOverrideIdentity | null> {
    if (!this.id) {
      return null;
    }

    const existing = await this.db.get(this.tableName, { id: this.id });
    if (!existing) {
      return null;
    }

    const row = existing as Record<string, unknown>;
    return {
      key: String(row.key ?? this.key),
      tenantId:
        row.tenantId !== undefined
          ? (row.tenantId as string | null)
          : ((row.tenant_id as string | null | undefined) ?? null),
    };
  }
}
