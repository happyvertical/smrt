import { SmrtCollection } from '@happyvertical/smrt-core';
import type { FactContentRelationship } from '@happyvertical/smrt-facts';
import type { Content } from './content';
import type { CreateContentVersionOptions } from './content-governance';
import { resolveEffectiveContentGovernance } from './content-governance';
import { ContentVersion } from './content-version';

export class ContentVersionCollection extends SmrtCollection<ContentVersion> {
  static readonly _itemClass = ContentVersion;

  private buildSnapshotFactRelationships(
    snapshot: Record<string, unknown>,
    defaultRelationship: FactContentRelationship,
  ): Map<FactContentRelationship, string[]> {
    const byRelationship = new Map<FactContentRelationship, string[]>();
    const rawLinks: unknown[] = Array.isArray(snapshot.factLinks)
      ? snapshot.factLinks
      : [];

    for (const rawLink of rawLinks) {
      const link = rawLink as {
        factId?: unknown;
        relationship?: unknown;
      } | null;
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
      tenantId: content.tenantId ?? null,
    });
    const [references, referenceEdges, assets, factsState] = await Promise.all([
      typeof content.getReferences === 'function'
        ? content.getReferences()
        : [],
      // Capture per-edge citation pins so restore can reconstruct them.
      // `getReferences()` resolves to Content objects and loses targetVersion.
      typeof content.getReferenceEdges === 'function'
        ? content.getReferenceEdges()
        : Promise.resolve([]),
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
      // Full edges with citation pins; `referenceIds` retained for back-compat
      // with snapshots written before pin-aware restore (#1387 #3).
      referenceEdges: referenceEdges.filter((edge) => Boolean(edge.targetId)),
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

    // Restore snapshot values onto the live Content instance by field name.
    // Indexing a class instance by an arbitrary string key requires a record
    // view; the keys are a fixed, known set of Content fields.
    const writableContent = content as unknown as Record<string, unknown>;
    for (const key of keysToRestore) {
      if (snapshot[key] !== undefined) {
        writableContent[key] = snapshot[key];
      }
    }

    // Reference edges with citation pins (#1387 #3). Newer snapshots carry
    // `referenceEdges` ({ targetId, targetVersion }); older ones only have
    // `referenceIds`. Either way, seed the pending `referenceIds` from the
    // target ids so `save()` reconciles the set (adds missing, removes extra),
    // then re-apply the saved pins below so restoring "to vN" reconstructs the
    // citation pins that existed at vN instead of dropping them to unpinned.
    const snapshotEdges: Array<{
      targetId: string;
      targetVersion: number | null;
    }> = Array.isArray(snapshot.referenceEdges)
      ? (snapshot.referenceEdges as unknown[])
          .filter(
            (edge): edge is { targetId: string; targetVersion?: unknown } =>
              !!edge &&
              typeof edge === 'object' &&
              typeof (edge as { targetId?: unknown }).targetId === 'string' &&
              (edge as { targetId: string }).targetId.length > 0,
          )
          .map((edge) => ({
            targetId: edge.targetId,
            targetVersion:
              typeof edge.targetVersion === 'number'
                ? edge.targetVersion
                : null,
          }))
      : Array.isArray(snapshot.referenceIds)
        ? snapshot.referenceIds
            .filter(
              (id: unknown): id is string =>
                typeof id === 'string' && id.length > 0,
            )
            .map((targetId: string) => ({ targetId, targetVersion: null }))
        : [];

    if (
      Array.isArray(snapshot.referenceEdges) ||
      Array.isArray(snapshot.referenceIds)
    ) {
      writableContent.referenceIds = snapshotEdges.map((edge) => edge.targetId);
    }

    if (Array.isArray(snapshot.assetIds)) {
      writableContent.assetIds = [...snapshot.assetIds];
    }

    await content.save();

    // Re-apply the citation pin of EVERY snapshot edge — including UNPINNED
    // ones (`targetVersion: null`). `save()` only reconciles the target-id set
    // (adds missing / removes extra edges) and leaves the pin of an edge that
    // already existed untouched. So restoring an *unpinned* snapshot over an
    // edge that is currently *pinned* must explicitly clear that pin, otherwise
    // the live pin survives the restore and drift never resets. Passing
    // `addReference(target, { targetVersion: null })` clears the pin in place
    // (the junction's `attach` updates the row when `null !== existing`), while
    // a non-null value (re)sets it — so "restore to vN" reconstructs exactly
    // the pins that existed at vN.
    //
    // We pass the resolved Content object (not the raw id) because
    // `addReference(string)` treats the string as a URL, not a content id.
    // `addReference` is idempotent on (source, target) and only adjusts
    // targetVersion.
    if (
      snapshotEdges.length > 0 &&
      typeof content.getReferences === 'function' &&
      typeof content.addReference === 'function'
    ) {
      const resolvedReferences = await content.getReferences();
      const resolvedById = new Map(
        resolvedReferences
          .filter((reference) => reference.id)
          .map((reference) => [reference.id as string, reference]),
      );
      for (const edge of snapshotEdges) {
        const target = resolvedById.get(edge.targetId);
        if (target) {
          await content.addReference(target, {
            targetVersion: edge.targetVersion,
          });
        }
      }
    }

    const governance = await resolveEffectiveContentGovernance({
      contentType: content.type,
      contentVariant: content.variant,
      db: this.db,
      tenantId: content.tenantId ?? null,
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
          (link) =>
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
