import { SmrtCollection } from '@happyvertical/smrt-core';
import type { FactContentRelationship } from '@happyvertical/smrt-facts';
import type { Content } from './content';
import type { CreateContentVersionOptions } from './content-governance';
import { resolveEffectiveContentGovernance } from './content-governance';
import { ContentVersion } from './content-version';

export class ContentVersionCollection extends SmrtCollection<ContentVersion> {
  static readonly _itemClass = ContentVersion;

  private buildSnapshotFactRelationships(
    snapshot: Record<string, any>,
    defaultRelationship: FactContentRelationship,
  ): Map<FactContentRelationship, string[]> {
    const byRelationship = new Map<FactContentRelationship, string[]>();
    const rawLinks = Array.isArray(snapshot.factLinks)
      ? snapshot.factLinks
      : [];

    for (const link of rawLinks) {
      const factId =
        typeof link?.factId === 'string' && link.factId.length > 0
          ? link.factId
          : null;
      const relationship =
        typeof link?.relationship === 'string' && link.relationship.length > 0
          ? (link.relationship as FactContentRelationship)
          : defaultRelationship;

      if (!factId) {
        continue;
      }

      byRelationship.set(relationship, [
        ...(byRelationship.get(relationship) || []),
        factId,
      ]);
    }

    if (
      byRelationship.size === 0 &&
      Array.isArray(snapshot.factIds) &&
      snapshot.factIds.length > 0
    ) {
      byRelationship.set(
        defaultRelationship,
        snapshot.factIds.filter(
          (factId: unknown): factId is string =>
            typeof factId === 'string' && factId.length > 0,
        ),
      );
    }

    return byRelationship;
  }

  async listForContent(contentId: string): Promise<ContentVersion[]> {
    return this.list({
      where: { contentId },
      orderBy: 'version ASC',
    });
  }

  async getLatestForContent(contentId: string): Promise<ContentVersion | null> {
    const versions = await this.listForContent(contentId);
    return versions.length > 0 ? versions[versions.length - 1] : null;
  }

  async getLatestPublishedForContent(
    contentId: string,
  ): Promise<ContentVersion | null> {
    const versions = await this.list({
      where: {
        contentId,
        kind: 'publication',
      },
      orderBy: 'version DESC',
    });

    return versions[0] || null;
  }

  async getVersion(
    contentId: string,
    versionNumber: number,
  ): Promise<ContentVersion | null> {
    return this.get({
      contentId,
      version: versionNumber,
    });
  }

  async getNextVersionNumber(contentId: string): Promise<number> {
    const latest = await this.getLatestForContent(contentId);
    return latest ? latest.version + 1 : 1;
  }

  async createSnapshot(
    content: Content,
    options: CreateContentVersionOptions = {},
  ): Promise<ContentVersion> {
    if (!content.id) {
      throw new Error('Cannot create a version for unsaved content');
    }

    const version = await this.getNextVersionNumber(content.id as string);
    const governance = await resolveEffectiveContentGovernance({
      contentType: content.type,
      contentVariant: content.variant,
      db: this.db,
    });
    const [references, assets, factsState] = await Promise.all([
      typeof content.getReferences === 'function'
        ? content.getReferences()
        : [],
      typeof content.getAssets === 'function' ? content.getAssets() : [],
      typeof content.getFactsState === 'function' &&
      governance.factLinkingEnabled
        ? content.getFactsState()
        : {
            factIds: [],
            facts: [],
            factLinks: [],
          },
    ]);

    const baseSnapshot = {
      id: content.id,
      slug: content.slug,
      context: content.context,
      name: content.name,
      type: content.type,
      variant: content.variant,
      fileKey: content.fileKey,
      author: content.author,
      title: content.title,
      description: content.description,
      body: content.body,
      bodyFormat: content.bodyFormat,
      publish_date: content.publish_date,
      url: content.url,
      source: content.source,
      original_url: content.original_url,
      language: content.language,
      tags: [...content.tags],
      category: content.category,
      status: content.status,
      state: content.state,
      metadata: content.metadata,
      thumbnailAssetId: content.thumbnailAssetId,
      referenceIds: references.map((reference) => reference.id).filter(Boolean),
      assetIds: assets.map((asset) => asset.id).filter(Boolean),
      factIds: factsState.factIds,
      factLinks: factsState.factLinks,
      tenantId: content.tenantId,
      _meta_type: content.toJSON()._meta_type,
    };
    const snapshot = {
      ...baseSnapshot,
      ...(options.snapshot || {}),
    };
    const versionSlugBase =
      snapshot.slug ||
      content.slug ||
      content.name ||
      content.title ||
      content.id;
    const versionSlug = `${versionSlugBase}-v${version}`;

    return this.create({
      slug: versionSlug,
      context: content.context || '',
      contentId: content.id as string,
      version,
      kind: options.kind || 'manual',
      title: snapshot.title || '',
      description: snapshot.description || '',
      body: snapshot.body || '',
      status: snapshot.status || 'draft',
      summary: options.summary || '',
      snapshot: JSON.stringify(snapshot),
      metadata: JSON.stringify(options.metadata || {}),
      tenantId: content.tenantId,
    });
  }

  async restoreIntoContent(
    content: Content,
    versionNumber: number,
  ): Promise<Content> {
    if (!content.id) {
      throw new Error('Cannot restore an unsaved content item');
    }

    const version = await this.getVersion(content.id as string, versionNumber);
    if (!version) {
      throw new Error(
        `Content version ${versionNumber} not found for content ${content.id}`,
      );
    }

    const snapshot = version.getSnapshot();
    const keysToRestore = [
      'name',
      'type',
      'variant',
      'fileKey',
      'author',
      'title',
      'description',
      'body',
      'bodyFormat',
      'publish_date',
      'url',
      'source',
      'original_url',
      'language',
      'tags',
      'category',
      'status',
      'state',
      'metadata',
      'thumbnailAssetId',
    ];

    for (const key of keysToRestore) {
      if (snapshot[key] !== undefined) {
        (content as any)[key] = snapshot[key];
      }
    }

    if (Array.isArray(snapshot.referenceIds)) {
      (content as any).referenceIds = [...snapshot.referenceIds];
    }

    if (Array.isArray(snapshot.assetIds)) {
      (content as any).assetIds = [...snapshot.assetIds];
    }

    await content.save();

    const governance = await resolveEffectiveContentGovernance({
      contentType: content.type,
      contentVariant: content.variant,
      db: this.db,
    });

    if (
      governance.isGoverned &&
      governance.factLinkingEnabled &&
      typeof content.getFactLinks === 'function' &&
      typeof content.syncFacts === 'function'
    ) {
      const desiredByRelationship = this.buildSnapshotFactRelationships(
        snapshot,
        governance.defaultFactRelationship,
      );
      const currentLinks = await content.getFactLinks();
      const currentRelationships = new Set(
        currentLinks.map(
          (link: any) =>
            (link.relationship as FactContentRelationship) ||
            governance.defaultFactRelationship,
        ),
      );
      const relationshipsToSync = new Set<FactContentRelationship>([
        ...currentRelationships,
        ...desiredByRelationship.keys(),
      ]);

      for (const relationship of relationshipsToSync) {
        await content.syncFacts(
          desiredByRelationship.get(relationship) || [],
          relationship,
        );
      }
    }

    return content;
  }
}
