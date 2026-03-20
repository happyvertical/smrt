/**
 * Auto-generated SMRT object registration
 * DO NOT EDIT - changes will be overwritten
 *
 * Importing these modules triggers their @smrt() decorators, which performs
 * the initial registration. The explicit re-registration below is intentional:
 * it upgrades bundled runtimes to deterministic qualified registrations.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';

import { ContentCorrection } from '../../content-correction';
import '../../content-corrections';
import { ContentGovernanceAssignment } from '../../content-governance-assignment';
import '../../content-governance-assignments';
import '../../content-governance-policies';
import { ContentGovernancePolicy } from '../../content-governance-policy';
import { ContentGovernanceProfile } from '../../content-governance-profile';
import '../../content-governance-profiles';
import { ContentReference } from '../../content-reference';
import '../../content-references';
import { ContentReview } from '../../content-review';
import '../../content-reviews';
import { Article, ContentDocument, Mirror } from '../../content-types';
import { ContentVersion } from '../../content-version';
import '../../content-versions';
import { Content } from '../../content';
import '../../contents';

// Re-register imported objects with explicit package names for bundled runtimes
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
