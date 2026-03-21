import {
  displayNameForScopedPackage,
  displayNameForSmrtPackage,
} from './utils.js';

export function createPackagePlaygroundTemplate(packageName: string): string {
  const displayName = displayNameForSmrtPackage(packageName);

  return `/**
 * ${displayName} playground definitions
 *
 * Export preview entries for the shared SMRT playground host here.
 */

export default {
  packageName: '${packageName}',
  displayName: '${displayName}',
  entries: [],
};
`;
}

export function createAppPlaygroundTemplate(packageName: string): string {
  const displayName = displayNameForScopedPackage(packageName);

  return `/**
 * Local app playground overrides
 *
 * Add app-specific previews here, or override installed package entries by
 * exporting an additional module with the same packageName + entry id.
 */

export default [
  {
    packageName: '${packageName}',
    displayName: '${displayName}',
    entries: [],
  },
];
`;
}

export function createAppPlaygroundRouteTemplate(): string {
  return `<script lang="ts">
import { PlaygroundHost } from '@happyvertical/smrt-playground/svelte';
import { playgroundModules } from 'virtual:smrt-playground/modules';
</script>

<PlaygroundHost
  title="SMRT Playground"
  subtitle="Package previews and local app overrides"
  modules={playgroundModules}
/>
`;
}
