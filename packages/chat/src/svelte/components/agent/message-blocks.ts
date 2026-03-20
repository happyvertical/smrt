export type ParsedBlock =
  | { type: 'text'; content: string }
  | { type: 'fields'; fields: Record<string, string> }
  | { type: 'markdown'; content: string };

export function parseAgentMessageBlocks(text: string): ParsedBlock[] {
  if (!text) return [];

  const regex = /```(json|markdown)[ \t]*\r?\n([\s\S]*?)```/gi;
  const blocks: ParsedBlock[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null = regex.exec(text);

  while (match !== null) {
    if (match.index > lastIndex) {
      blocks.push({
        type: 'text',
        content: text.slice(lastIndex, match.index),
      });
    }

    const lang = match[1].toLowerCase();
    const body = match[2].trim();

    if (lang === 'json') {
      try {
        const parsed = JSON.parse(body);
        if (parsed.fields && typeof parsed.fields === 'object') {
          blocks.push({ type: 'fields', fields: parsed.fields });
        } else {
          blocks.push({ type: 'text', content: match[0] });
        }
      } catch {
        blocks.push({ type: 'text', content: match[0] });
      }
    } else {
      blocks.push({ type: 'markdown', content: body });
    }

    lastIndex = regex.lastIndex;
    match = regex.exec(text);
  }

  if (lastIndex < text.length) {
    blocks.push({ type: 'text', content: text.slice(lastIndex) });
  }

  return blocks;
}
