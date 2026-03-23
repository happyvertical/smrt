/**
 * Auto-generated SMRT object registration
 * DO NOT EDIT - changes will be overwritten
 *
 * Importing these modules triggers their @smrt() decorators, which performs
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
import '../../content-governance-assignments';
import '../../content-governance-policies';
import '../../content-governance-profiles';
import '../../content-references';
import '../../content-reviews';
import '../../content-versions';
import '../../contents';

// Re-register imported objects with explicit package names for bundled runtimes
ObjectRegistry.register(ContentAsset, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentContributionAttachment, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentContributionRevision, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentContributionType, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentContribution, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentContributor, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentCorrection, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentGovernanceAssignment, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentGovernancePolicy, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentGovernanceProfile, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentReference, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentReview, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(Article, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentDocument, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(Mirror, { packageName: '@happyvertical/smrt-content' });
ObjectRegistry.register(ContentVersion, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(Content, {
  packageName: '@happyvertical/smrt-content',
});
