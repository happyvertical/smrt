import { getPackageConfig } from '@happyvertical/smrt-config';
import {
  field,
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { invalidatePromptCache } from '../cache.js';
import { PromptRegistry } from '../prompt-registry.js';
import type {
  PromptLayer,
  PromptPackageConfig,
  PromptParams,
} from '../types.js';
import {
  mergePromptLayers,
  normalizePromptLayer,
  parsePromptParams,
  serializePromptParams,
  validateModelName,
  validateProfileName,
} from '../utils.js';

export interface PromptOverrideOptions extends SmrtObjectOptions {
  key?: string;
  tenantId?: string | null;
  template?: string | null;
  profile?: string | null;
  model?: string | null;
  params?: string | PromptParams | null;
}

type PromptOverrideIdentity = {
  key: string;
  tenantId: string | null;
};

type PromptTransactionHandle = DatabaseInterface & {
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

function getPromptConfig(): PromptPackageConfig {
  return getPackageConfig<PromptPackageConfig>('prompts', {
    profiles: {},
    prompts: {},
  });
}

@smrt({
  tableName: '_smrt_prompt_overrides',
  conflictColumns: ['key', 'context'],
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  cli: {
    include: ['list', 'get', 'create', 'update', 'delete'],
    exclude: ['getParams', 'setParams', 'toPromptLayer'],
  },
  mcp: { include: [] },
})
export class PromptOverride extends SmrtObject {
  @field({ required: true })
  key: string = '';

  @field({ type: 'text', nullable: true })
  tenantId: string | null = null;

  @field({ type: 'text', nullable: true })
  template: string | null = null;

  @field({ type: 'text', nullable: true })
  profile: string | null = null;

  @field({ type: 'text', nullable: true })
  model: string | null = null;

  @field({ type: 'text', nullable: true })
  params: string | null = null;

  constructor(options: PromptOverrideOptions = {}) {
    super(options);

    if (options.key !== undefined) this.key = options.key;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.template !== undefined) this.template = options.template;
    if (options.profile !== undefined) this.profile = options.profile;
    if (options.model !== undefined) this.model = options.model;
    if (options.params !== undefined) {
      if (typeof options.params === 'string' || options.params === null) {
        this.params = options.params;
      } else {
        this.params = serializePromptParams(options.params);
      }
    }
  }

  getParams(): PromptParams {
    return parsePromptParams(this.params);
  }

  setParams(params: PromptParams | null): void {
    this.params = serializePromptParams(params);
  }

  toPromptLayer(): PromptLayer {
    return {
      template: this.template,
      profile: this.profile,
      model: this.model,
      params: this.params === null ? null : this.getParams(),
    };
  }

  override async save(): Promise<this> {
    const previousIdentity = await this.getPersistedIdentity();
    this.normalizeParamsForPersistence();
    await this.validatePromptOverride();
    // Use context as the uniqueness scope so app-level rows remain unique even
    // though tenantId is nullable and would otherwise allow multiple NULL rows.
    this.context = this.tenantId ?? '__app__';
    const identityChanged =
      previousIdentity &&
      (previousIdentity.key !== this.key ||
        previousIdentity.tenantId !== this.tenantId);

    const result =
      identityChanged && previousIdentity
        ? await this.saveAfterIdentityChange()
        : await super.save();

    if (identityChanged && previousIdentity) {
      invalidatePromptCache(
        previousIdentity.key,
        previousIdentity.tenantId,
        this.db,
      );
    }
    invalidatePromptCache(this.key, this.tenantId, this.db);
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
      | PromptTransactionHandle
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
    invalidatePromptCache(key, tenantId, this.db);
  }

  private async validatePromptOverride(): Promise<void> {
    if (!this.key || this.key.trim() === '') {
      throw new Error('PromptOverride.key is required');
    }

    const definition = PromptRegistry.get(this.key);
    if (!definition) {
      throw new Error(`Unknown prompt key "${this.key}"`);
    }

    const config = getPromptConfig();
    const editable = definition.editable;

    if (this.template !== null && !editable.template) {
      throw new Error(`Prompt "${this.key}" does not allow template overrides`);
    }

    if (this.profile !== null && !editable.profile) {
      throw new Error(`Prompt "${this.key}" does not allow profile overrides`);
    }

    if (this.model !== null && !editable.model) {
      throw new Error(`Prompt "${this.key}" does not allow model overrides`);
    }

    if (this.params !== null && !editable.params) {
      throw new Error(`Prompt "${this.key}" does not allow params overrides`);
    }

    if (this.params !== null) {
      try {
        const parsed = JSON.parse(this.params);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          throw new Error('Prompt params must be a JSON object');
        }
      } catch (error) {
        throw new Error(
          `Prompt "${this.key}" has invalid params JSON: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    if (this.profile !== null) {
      validateProfileName(this.profile, config);
    }

    if (this.model !== null) {
      validateModelName(this.model, config);
    }

    const lowerLayers = await this.getLowerPrecedenceLayers();
    const currentLayer = this.toPromptLayer();
    const merged = mergePromptLayers(...lowerLayers, currentLayer);

    if (currentLayer.model && !merged.ai.profile) {
      throw new Error(
        `Prompt "${this.key}" model overrides require an effective prompt profile`,
      );
    }
  }

  private async getLowerPrecedenceLayers(): Promise<PromptLayer[]> {
    const definition = PromptRegistry.get(this.key);
    const config = getPromptConfig();
    const layers: PromptLayer[] = [];

    if (definition) {
      layers.push({
        template: definition.template,
        profile: definition.ai.profile ?? null,
        model: definition.ai.model ?? null,
        params: definition.ai.params,
      });
    }

    layers.push(normalizePromptLayer(config.prompts?.[this.key]));

    const { PromptOverrideCollection } = await import(
      '../collections/PromptOverrideCollection.js'
    );
    const collection = await (PromptOverrideCollection as any).create({
      db: this.options.db ?? this.options.persistence,
    });

    if (this.tenantId) {
      const appOverride = await collection.getAppOverride(this.key, {
        excludeId: this.id,
      });
      if (appOverride) {
        layers.push(appOverride.toPromptLayer());
      }
    }

    return layers;
  }

  private normalizeParamsForPersistence(): void {
    const rawParams = this.params as unknown;

    if (rawParams === null || rawParams === undefined) {
      this.params = null;
      return;
    }

    if (typeof rawParams === 'string') {
      this.params = rawParams;
      return;
    }

    if (typeof rawParams === 'object' && !Array.isArray(rawParams)) {
      this.params = serializePromptParams(rawParams as PromptParams);
      return;
    }

    throw new Error(
      `Prompt "${this.key}" params must be a JSON object or JSON string`,
    );
  }

  private async getPersistedIdentity(): Promise<PromptOverrideIdentity | null> {
    if (!this.id) {
      return null;
    }

    const existing = await this.db.get(this.tableName, { id: this.id });
    if (!existing) {
      return null;
    }

    return {
      key: String((existing as Record<string, unknown>).key ?? this.key),
      tenantId:
        (existing as Record<string, unknown>).tenantId !== undefined
          ? ((existing as Record<string, unknown>).tenantId as string | null)
          : (((existing as Record<string, unknown>).tenant_id as
              | string
              | null
              | undefined) ?? null),
    };
  }
}
