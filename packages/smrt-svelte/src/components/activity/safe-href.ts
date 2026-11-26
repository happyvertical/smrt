function hasControlChar(value: string): boolean {
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** Accept ordinary web links, never executable schemes, control characters, or protocol-relative URLs. */
export function safeActivityHref(
  value: string | null | undefined,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (
    !trimmed ||
    trimmed.startsWith('//') ||
    trimmed.includes('\\') ||
    hasControlChar(trimmed)
  ) {
    return undefined;
  }
  try {
    const url = new URL(trimmed, 'https://smrt.invalid');
    return ['https:', 'http:'].includes(url.protocol) ? trimmed : undefined;
  } catch {
    return undefined;
  }
}
