import {
  FactCollection,
  FactSourceCollection,
} from '@happyvertical/smrt-facts';
import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Content } from './content';
import {
  configureContentGovernance,
  resetContentGovernanceConfig,
} from './content-governance';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres(
  'fact audit provenance replacement on PostgreSQL (#3401)',
  () => {
    let isolated: IsolatedTestDbResult | undefined;
    let db: DatabaseInterface;

    beforeEach(async () => {
      isolated = await createIsolatedTestDbFromManifest({
        includeObjects: [
          'Content',
          'ContentGovernanceAssignment',
          'ContentGovernancePolicy',
          'ContentGovernanceProfile',
          'ContentReference',
          'ContentReview',
          'Fact',
          'FactContent',
          'FactEvidence',
          'FactSource',
          'PromptOverride',
        ],
      });
      db = isolated.baseDb;
      configureContentGovernance({
        assignments: [
          {
            contentType: 'article',
            enabled: true,
            factLinkingEnabled: true,
            transparencyEnabled: true,
            defaultFactRelationship: 'supports',
          },
        ],
      });
    });

    afterEach(async () => {
      resetContentGovernanceConfig();
      vi.restoreAllMocks();
      await isolated?.cleanup();
      isolated = undefined;
    });

    it('replaces only selected generated provenance in the content tenant', async () => {
      const tenantA = '20000000-0000-4000-8000-000000000001';
      const tenantB = '20000000-0000-4000-8000-000000000002';
      const message = vi.fn(async () =>
        JSON.stringify({
          facts: [
            {
              statement: 'Council approved the capital plan.',
              type: 'event',
              sourceExcerpt: 'Council approved the capital plan.',
              confidence: 0.9,
            },
          ],
        }),
      );
      const article = new Content({
        name: 'capital-plan-story',
        title: 'Capital plan story',
        body: 'Council approved the capital plan.',
        type: 'article',
        status: 'draft',
        tenantId: tenantA,
        db,
        ai: { message, embed: vi.fn().mockRejectedValue(new Error('offline')) },
      });
      await article.initialize();
      await article.save();
      const reference = new Content({
        name: 'capital-plan-minutes',
        title: 'Capital plan minutes',
        body: 'Council approved the capital plan.',
        type: 'minutes',
        status: 'published',
        tenantId: tenantA,
        db,
      });
      await reference.initialize();
      await reference.save();
      await article.addReference(reference);

      const facts = await FactCollection.create({ db });
      const sources = await FactSourceCollection.create({ db });
      const otherTenantFact = await facts.create({
        textRefined: 'Other tenant fact',
        textRaw: 'Other tenant fact',
        type: 'event',
        domain: 'content-audit',
        status: 'active',
        tenantId: tenantB,
      });
      const otherTenantSource = await sources.create({
        factId: otherTenantFact.id as string,
        sourceType: 'content-reference',
        sourceTitle: 'Other tenant source',
        tenantId: tenantB,
        metadata: {
          generatedBy: 'content.factAudit',
          contentId: article.id,
          sourceId: reference.id,
          auditRunId: 'other-tenant-run',
        },
      });
      const manualFact = await facts.create({
        textRefined: 'Manual tenant A fact',
        textRaw: 'Manual tenant A fact',
        type: 'event',
        domain: 'content-audit',
        status: 'active',
        tenantId: tenantA,
      });
      const manualSource = await sources.create({
        factId: manualFact.id as string,
        sourceType: 'content-reference',
        sourceTitle: 'Manual source',
        tenantId: tenantA,
        metadata: { sourceId: reference.id, manual: true },
      });

      const selection = [
        {
          sourceKind: 'content-reference' as const,
          sourceId: reference.id as string,
        },
      ];
      await article.repairFactEvidence({ sources: selection });
      await article.repairFactEvidence({ sources: selection });

      const tenantAGenerated = (
        await sources.list({ where: { tenantId: tenantA } })
      ).filter(
        (source) =>
          source.getMetadata().generatedBy === 'content.factAudit' &&
          source.getMetadata().contentId === article.id,
      );
      expect(tenantAGenerated).toHaveLength(1);
      expect(await sources.get({ id: manualSource.id })).not.toBeNull();
      expect(await sources.get({ id: otherTenantSource.id })).not.toBeNull();
    });
  },
);
