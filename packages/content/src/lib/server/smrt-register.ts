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
import { ContentCorrection } from '../../content-correction';
import { ContentReference } from '../../content-reference';
import { ContentReview } from '../../content-review';
import {
  Article,
  ContentDocument,
  FactualContent,
  Mirror,
} from '../../content-types';
import { ContentVersion } from '../../content-version';

// Re-register imported objects with explicit package names for bundled runtimes
ObjectRegistry.register(ContentCorrection, {
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
ObjectRegistry.register(FactualContent, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentVersion, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(Content, {
  packageName: '@happyvertical/smrt-content',
});
