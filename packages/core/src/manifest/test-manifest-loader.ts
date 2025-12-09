/**
 * Test manifest loader with fallback
 * Uses the committed stub file, which is kept in sync with test objects
 */

import type { SmartObjectManifest } from '../scanner/types';
import { testManifest as stubManifest } from './test-manifest-stub.js';

export const testManifest: SmartObjectManifest = stubManifest;
