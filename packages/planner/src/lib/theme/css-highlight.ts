export interface CssToken {
  text: string;
  kind: 'plain' | 'comment' | 'selector' | 'property' | 'value' | 'punctuation';
}

/** Small CSS lexer for the Planner editor. Text is rendered by Svelte, never as HTML. */
export function highlightCss(source: string): CssToken[] {
  const result: CssToken[] = [];
  const pattern =
    /(\/\*[\s\S]*?\*\/|\/\*[\s\S]*$|"(?:\\.|[^"\\])*"?|'(?:\\.|[^'\\])*'?|[{}:;]|[^{}:;'"/]+|\/)/g;
  let inBlock = false;
  let afterColon = false;
  for (const match of source.matchAll(pattern)) {
    const text = match[0];
    let kind: CssToken['kind'] = 'plain';
    if (text.startsWith('/*')) kind = 'comment';
    else if (/^[{}:;]$/.test(text)) {
      kind = 'punctuation';
      if (text === '{') {
        inBlock = true;
        afterColon = false;
      }
      if (text === '}') {
        inBlock = false;
        afterColon = false;
      }
      if (text === ':') afterColon = true;
      if (text === ';') afterColon = false;
    } else if (inBlock) kind = afterColon ? 'value' : 'property';
    else kind = 'selector';
    result.push({ text, kind });
  }
  return result;
}
