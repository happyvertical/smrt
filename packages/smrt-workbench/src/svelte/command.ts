export function workbenchScriptCommand(
  packageSummary: {
    name: string;
    source: 'workspace' | 'package' | 'app';
    relativeDirectory?: string;
  },
  scriptName: string,
  packageManager: 'pnpm' | 'yarn' | 'npm',
): string {
  if (packageSummary.source === 'workspace') {
    return `pnpm --filter ${packageSummary.name} ${scriptName}`;
  }

  if (packageSummary.source === 'app') {
    return packageManager === 'yarn'
      ? `yarn run ${scriptName}`
      : `${packageManager} run ${scriptName}`;
  }

  const packageDir = packageSummary.relativeDirectory || '.';
  if (packageManager === 'yarn') {
    return `yarn --cwd ${packageDir} run ${scriptName}`;
  }
  if (packageManager === 'pnpm') {
    return `pnpm --dir ${packageDir} run ${scriptName}`;
  }
  return `npm --prefix ${packageDir} run ${scriptName}`;
}
