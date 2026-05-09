/**
 * Auto-generated SMRT object registration
 * DO NOT EDIT - changes will be overwritten
 *
 * Importing these modules triggers their @smrt() decorators, which perform
 * the initial registration. The explicit re-registration below is intentional:
 * it upgrades bundled runtimes to deterministic qualified registrations.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';

import { Content } from '../../content';
import { ContentAsset } from '../../content-asset';
import { ContentContribution } from '../../content-contribution';
import { ContentContributionAttachment } from '../../content-contribution-attachment';
import { ContentContributionRevision } from '../../content-contribution-revision';
import { ContentContributionType } from '../../content-contribution-type';
import { ContentContributor } from '../../content-contributor';
import { ContentCorrection } from '../../content-correction';
import { ContentFeedSource } from '../../content-feed-source';
import { ContentGovernanceAssignment } from '../../content-governance-assignment';
import { ContentGovernancePolicy } from '../../content-governance-policy';
import { ContentGovernanceProfile } from '../../content-governance-profile';
import { ContentReference } from '../../content-reference';
import { ContentReview } from '../../content-review';
import { Article, ContentDocument, Mirror } from '../../content-types';
import { ContentVersion } from '../../content-version';
import '../../content-assets';
import '../../content-contribution-attachments';
import '../../content-contribution-revisions';
import '../../content-contribution-types';
import '../../content-contributions';
import '../../content-contributors';
import '../../content-corrections';
import '../../content-feed-sources';
import '../../content-governance-assignments';
import '../../content-governance-policies';
import '../../content-governance-profiles';
import '../../content-references';
import '../../content-reviews';
import '../../content-versions';
import '../../contents';

// Re-register imported objects with explicit package names for bundled runtimes
ObjectRegistry.register(ContentAsset, {
  name: 'ContentAsset',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentContributionAttachment, {
  name: 'ContentContributionAttachment',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentContributionRevision, {
  name: 'ContentContributionRevision',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentContributionType, {
  name: 'ContentContributionType',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentContribution, {
  name: 'ContentContribution',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentContributor, {
  name: 'ContentContributor',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentCorrection, {
  name: 'ContentCorrection',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentFeedSource, {
  name: 'ContentFeedSource',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentGovernanceAssignment, {
  name: 'ContentGovernanceAssignment',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentGovernancePolicy, {
  name: 'ContentGovernancePolicy',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentGovernanceProfile, {
  name: 'ContentGovernanceProfile',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentReference, {
  name: 'ContentReference',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentReview, {
  name: 'ContentReview',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(Article, {
  name: 'Article',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentDocument, {
  name: 'ContentDocument',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(Mirror, {
  name: 'Mirror',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentVersion, {
  name: 'ContentVersion',
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(Content, {
  name: 'Content',
  packageName: '@happyvertical/smrt-content',
});
