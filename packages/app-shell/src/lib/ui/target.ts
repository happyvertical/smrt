import type { Target } from './types.ts';

/** Shell and MCP URLs name the copy; app REST uses its dedicated header. */
export function targetPath(path: string, target: Target): string {
  if (path.startsWith('/api/app/')) return path;
  const url = new URL(path, 'http://shell.local');
  url.searchParams.set('target', target);
  return `${url.pathname}${url.search}${url.hash}`;
}
