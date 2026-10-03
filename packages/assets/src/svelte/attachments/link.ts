/** Accept only caller-supplied HTTP(S) or relative navigation URLs, never scripts. */
export function attachmentLink(href: string | undefined): string | undefined {
  if (!href?.trim()) return undefined;
  try {
    const url = new URL(href, 'https://attachment.invalid/');
    return url.protocol === 'https:' || url.protocol === 'http:'
      ? href
      : undefined;
  } catch {
    return undefined;
  }
}
