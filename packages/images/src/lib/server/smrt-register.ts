/**
 * Auto-generated SMRT object registration
 * DO NOT EDIT - changes will be overwritten
 *
 * Importing these modules triggers their @smrt() decorators, which perform
 * the initial registration. The explicit re-registration below is intentional:
 * it upgrades bundled runtimes to deterministic qualified registrations.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';

import { Image } from '../../image';
import '../../images';

// Re-register imported objects with explicit package names for bundled runtimes
ObjectRegistry.register(Image, { packageName: '@happyvertical/smrt-images' });
