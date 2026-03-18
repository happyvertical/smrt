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
import { ContentReference } from '../../content-reference';
import { ContentReferences } from '../../content-references';
import { Article, ContentDocument, Mirror } from '../../content-types';
import { Contents } from '../../contents';

// Re-register imported objects with explicit package names for bundled runtimes
ObjectRegistry.register(ContentReference, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentReferences, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(Article, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(ContentDocument, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(Mirror, { packageName: '@happyvertical/smrt-content' });
ObjectRegistry.register(Content, {
  packageName: '@happyvertical/smrt-content',
});
ObjectRegistry.register(Contents, {
  packageName: '@happyvertical/smrt-content',
});
