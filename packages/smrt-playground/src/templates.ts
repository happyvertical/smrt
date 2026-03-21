function titleCase(value: string): string {
  return value
    .split(/[-_/]/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function displayNameForPackage(packageName: string): string {
  return titleCase(packageName.replace(/^@happyvertical\/smrt-/, ''));
}

export function createPackagePlaygroundTemplate(packageName: string): string {
  const displayName = displayNameForPackage(packageName);

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
  const displayName = titleCase(
    packageName.replace(/^@/, '').replace(/\//g, ' '),
  );

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
