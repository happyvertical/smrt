export function displayNameForSmrtPackage(packageName: string): string {
  const baseName = packageName
    .replace(/^@happyvertical\/smrt-/, '')
    .replace(/^@happyvertical\/smrt$/, 'SMRT')
    .replace(/^smrt-/, '');

  return baseName
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

export function commandIdForScript(packageName: string, scriptName: string) {
  return `${packageName}:${scriptName}`;
}
