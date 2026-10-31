// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  renderAssistantMarkdown as md,
} from '../assistant-markdown.js';

describe('renderAssistantMarkdown (#4505)', () => {
  it('bounds the cost of one pathological long line (review F1)', () => {
    const line = '**x '.repeat(20_000);
    const started = performance.now();
    const html = md(`# ${line}\n${line}\n- ${line}`);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(html).not.toContain('<strong>');
    expect(html).not.toContain('<h1>');
    expect(html.startsWith('<p>')).toBe(true);
  });

  it('renders paragraphs, line breaks, emphasis and inline code', () => {
    expect(md('Hello **world** and *you*\nnext line\n\nSecond `a*b*c`')).toBe(
      '<p>Hello <strong>world</strong> and <em>you</em><br>next line</p>' +
        '<p>Second <code>a*b*c</code></p>',
    );
    expect(md('__bold__ and _it_ but snake_case_name stays')).toBe(
      '<p><strong>bold</strong> and <em>it</em> but snake_case_name stays</p>',
    );
  });

  it('renders headings up to ###, lists and fenced code', () => {
    expect(md('# One\n## Two\n### Three\n#### Four')).toBe(
      '<h1>One</h1><h2>Two</h2><h3>Three</h3><p>#### Four</p>',
    );
    expect(md('- a\n- **b**\n  more\n\n3. x\n4. y')).toBe(
      '<ul><li>a</li><li><strong>b</strong><br>more</li></ul>' +
        '<ol start="3"><li>x</li><li>y</li></ol>',
    );
    expect(md('```ts\nconst a = 1 < 2;\n**not bold**\n```\nafter')).toBe(
      '<pre><code class="language-ts">const a = 1 &lt; 2;\n**not bold**</code></pre>' +
        '<p>after</p>',
    );
    // An unclosed fence runs to the end.
    expect(md('~~~\nopen')).toBe('<pre><code>open</code></pre>');
  });

  it('renders http(s) links with rel and target', () => {
    expect(md('See [the *docs*](https://example.com/a?b=1&c=2).')).toBe(
      '<p>See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">the <em>docs</em></a>.</p>',
    );
    expect(md('[x](http://example.com/a_b_c)')).toContain(
      'href="http://example.com/a_b_c"',
    );
  });

  it('escapes raw HTML, including script tags', () => {
    const html = md('<script>alert(1)</script>\n<b>hi</b> & "q" \'s\'');
    expect(html).not.toMatch(/<script|<b>/);
    expect(html).toBe(
      '<p>&lt;script&gt;alert(1)&lt;/script&gt;<br>&lt;b&gt;hi&lt;/b&gt; &amp; &quot;q&quot; &#39;s&#39;</p>',
    );
    expect(md('```\n<script>x</script>\n```')).not.toContain('<script');
    expect(md('`<img src=x onerror=alert(1)>`')).toBe(
      '<p><code>&lt;img src=x onerror=alert(1)&gt;</code></p>',
    );
  });

  it('never emits a non-http(s) href', () => {
    for (const target of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      '//evil.example/x',
      '/relative',
      'java&#09;script:alert(1)',
    ]) {
      const html = md(`[click](${target})`);
      expect(html).not.toContain('<a');
      expect(html).not.toMatch(/href=/i);
      expect(html).not.toContain('<script');
    }
  });

  it('cannot break out of an attribute or inject an event handler', () => {
    const attempts = [
      '[x](https://example.com/"onmouseover="alert(1))',
      "[x](https://example.com/'onmouseover='alert(1))",
      '[x"onclick="alert(1)](https://example.com)',
      '**<img src=x onerror=alert(1)>**',
      '[<svg onload=alert(1)>](https://example.com)',
    ];
    for (const attempt of attempts) {
      // Parse the output as a browser would and inspect the real DOM.
      const root = document.createElement('div');
      root.innerHTML = md(attempt);
      for (const element of root.querySelectorAll('*')) {
        expect(['P', 'A', 'STRONG', 'EM', 'CODE']).toContain(element.tagName);
        for (const attribute of element.attributes) {
          expect(['href', 'target', 'rel']).toContain(attribute.name);
        }
        if (element.tagName === 'A') {
          expect(element.getAttribute('href')).toMatch(
            /^https:\/\/example\.com\//,
          );
        }
      }
    }
  });

  it('strips the placeholder delimiter from input', () => {
    expect(md('a\u00000\u0000b `c`')).toBe('<p>a0b <code>c</code></p>');
  });

  it('escapes every HTML-significant character', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });
});
