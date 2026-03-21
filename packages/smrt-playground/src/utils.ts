export function titleCase(value: string): string {
  return value
    .split(/[-_/]/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

export function displayNameForSmrtPackage(packageName: string): string {
  return titleCase(packageName.replace(/^@happyvertical\/smrt-/, ''));
}

export function displayNameForScopedPackage(packageName: string): string {
  return titleCase(packageName.replace(/^@/, '').replace(/\//g, ' '));
}
