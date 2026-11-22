/**
 * Type-only fixture, compiled by `pnpm --filter @happyvertical/smrt-core
 * typecheck` and never imported: an external implementer of the exported
 * `SmrtPluginApi`, written against the interface as published before #5462.
 * Producer selection by root uses a private registry, so this interface must
 * not gain a required member; adding one fails this file.
 */

import type { DomainKnowledgeConfig } from '@happyvertical/smrt-types';
import type { SmartObjectManifest } from '../scanner/types.js';
import type { SmrtPluginApi } from './index.js';

export const externalSmrtPluginApi: SmrtPluginApi = {
  options: {
    baseClasses: ['SmrtObject'],
    followImports: true,
    include: ['src/**/*.ts'],
    exclude: [],
  },
  async resolveKnowledgeConfig(
    _manifest: SmartObjectManifest,
  ): Promise<DomainKnowledgeConfig> {
    return {};
  },
  async resolveKnowledgeAgentSurface() {
    return undefined;
  },
};
