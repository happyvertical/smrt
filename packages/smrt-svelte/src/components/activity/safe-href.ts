/** Accept ordinary web links, never executable schemes or protocol-relative URLs. */
export function safeActivityHref(
  value: string | null | undefined,
): string | undefined {
  if (!value || value.startsWith('//') || value.includes('\\'))
    return undefined;
  try {
    const url = new URL(value, 'https://smrt.invalid');
    return ['https:', 'http:'].includes(url.protocol) ? value : undefined;
  } catch {
    return undefined;
  }
}
