// @vitest-environment jsdom

// The sanitizer runs identically in Node (SSR / prerender) and the browser:
// it never touches a DOM. jsdom is used here only to re-parse the output the
// way a browser does, so each check asserts on the tree a page would build.

import { describe, expect, it } from 'vitest';
import {
  bodyToEditorHtml,
  editorHtmlToBody,
  imageAssetToHtml,
  placeThumbnailInBody,
  renderContentBodyHtml,
  renderMarkdownToHtml,
  sanitizeHtml,
} from './body-format';

const URL_ATTRIBUTES = ['href', 'src', 'srcset', 'action', 'formaction'];

/** Parse like a browser and list anything that could run script. */
function executableParts(html: string): string[] {
  const doc = new DOMParser().parseFromString(
    `<body>${html}</body>`,
    'text/html',
  );
  const found: string[] = [];
  for (const element of Array.from(doc.body.querySelectorAll('*'))) {
    const tag = element.tagName.toLowerCase();
    if (
      [
        'script',
        'style',
        'iframe',
        'object',
        'embed',
        'svg',
        'math',
        'form',
        'base',
        'link',
        'meta',
        'template',
        'noscript',
      ].includes(tag)
    ) {
      found.push(`<${tag}>`);
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        found.push(`${tag}[${name}]`);
      }
      if (
        name === 'style' &&
        /expression|url\(|position/i.test(attribute.value)
      ) {
        found.push(`${tag}[style=${attribute.value}]`);
      }
      if (
        URL_ATTRIBUTES.includes(name) &&
        /^(?:javascript|vbscript|data:(?!image\/(?:png|gif|jpe?g|webp|avif);))/i.test(
          // biome-ignore lint/suspicious/noControlCharactersInRegex: browsers strip C0 controls before reading a scheme
          attribute.value.replace(/[\u0000-\u0020\u007f]/g, ''),
        )
      ) {
        found.push(`${tag}[${name}=${attribute.value}]`);
      }
    }
  }
  return found;
}

describe('body sanitizer: script-injection bypasses', () => {
  const vectors: Array<[string, string]> = [
    ['nested tag reassembly', '<scr<script>ipt>alert(1)</scr<script>ipt>'],
    [
      'nested tag reassembly with a closing gap',
      '<scr<script>x</script>ipt>alert(1)</scr</script>ipt>',
    ],
    ['nested iframe reassembly', '<ifr<iframe>ame src="javascript:alert(1)">'],
    ['uppercase script', '<SCRIPT>alert(1)</SCRIPT>'],
    ['whitespace in tag', '<script\n>alert(1)</script\t>'],
    ['unclosed script', '<p>ok</p><script>alert(1)'],
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['img onerror uppercase', '<IMG SRC=x ONERROR="alert(1)">'],
    ['img slash-separated handler', '<img/src="x"/onerror=alert(1)>'],
    ['handler glued to a quote', '<img src="x"onerror="alert(1)">'],
    ['handler with newline', '<img src=x\nonerror\n=\nalert(1)>'],
    [
      'entity-encoded javascript href',
      '<a href="jav&#x61;script:alert(1)">x</a>',
    ],
    ['decimal-encoded scheme', '<a href="&#106;avascript:alert(1)">x</a>'],
    ['named colon entity', '<a href="javascript&colon;alert(1)">x</a>'],
    ['tab inside the scheme', '<a href="java\tscript:alert(1)">x</a>'],
    [
      'encoded tab inside the scheme',
      '<a href="java&#9;script:alert(1)">x</a>',
    ],
    [
      'leading control characters',
      '<a href="\u0001 javascript:alert(1)">x</a>',
    ],
    ['mixed-case scheme', '<a href="JaVaScRiPt:alert(1)">x</a>'],
    ['vbscript', '<a href="vbscript:msgbox(1)">x</a>'],
    [
      'data text/html link',
      '<a href="data:text/html,<script>alert(1)</script>">x</a>',
    ],
    ['svg data image', '<img src="data:image/svg+xml,<svg onload=alert(1)>">'],
    ['svg script', '<svg><script>alert(1)</script></svg>'],
    ['svg onload', '<svg onload=alert(1)>'],
    [
      'svg animate href',
      '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>',
    ],
    [
      'math mtext mglyph style (mXSS)',
      '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    ],
    [
      'svg p style (mXSS)',
      '<svg></p><style><a id="</style><img src=1 onerror=alert(1)>">',
    ],
    [
      'noscript attribute breakout (mXSS)',
      '<noscript><p title="</noscript><img src=x onerror=alert(1)>">',
    ],
    ['xmp breakout', '<xmp><img src=x onerror=alert(1)></xmp>'],
    ['textarea breakout', '<textarea><img src=x onerror=alert(1)></textarea>'],
    ['title breakout', '<title><img src=x onerror=alert(1)></title>'],
    ['template content', '<template><img src=x onerror=alert(1)></template>'],
    ['style tag', '<style>@import "javascript:alert(1)";</style>'],
    [
      'style attribute expression',
      '<p style="width: expression(alert(1))">x</p>',
    ],
    ['iframe srcdoc', '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
    ['object data', '<object data="javascript:alert(1)"></object>'],
    ['embed', '<embed src="javascript:alert(1)">'],
    [
      'form action',
      '<form action="javascript:alert(1)"><button>go</button></form>',
    ],
    [
      'button formaction',
      '<button formaction="javascript:alert(1)">go</button>',
    ],
    [
      'meta refresh',
      '<meta http-equiv="refresh" content="0;url=javascript:alert(1)">',
    ],
    ['base href', '<base href="javascript:alert(1)//">'],
    [
      'srcset javascript',
      '<img src="https://example.com/a.jpg" srcset="javascript:alert(1) 1x">',
    ],
    ['comment breakout', '<!--<img src="--><img src=x onerror=alert(1)//">'],
    ['cdata breakout', '<![CDATA[<img src=x onerror=alert(1)>]]>'],
    ['details ontoggle', '<details open ontoggle=alert(1)>x</details>'],
    [
      'markup in attribute value',
      '<a title="&quot;><img src=x onerror=alert(1)>">x</a>',
    ],
  ];

  for (const [name, input] of vectors) {
    it(`neutralizes ${name}`, () => {
      const html = sanitizeHtml(input);
      expect(executableParts(html)).toEqual([]);
      // Idempotent: a second pass never finds anything new to remove.
      expect(sanitizeHtml(html)).toBe(html);
    });

    it(`neutralizes ${name} in a public HTML render`, () => {
      expect(executableParts(renderContentBodyHtml(input, 'html'))).toEqual([]);
    });
  }

  it('leaves no executable tag from the nested-tag bypass', () => {
    const html = sanitizeHtml('<scr<script>ipt>alert(1)</scr<script>ipt>');
    expect(html).not.toMatch(/<\s*script/i);
    expect(html).not.toContain('<');
  });

  it('keeps the text of a quote-breaking attribute as inert text', () => {
    const html = sanitizeHtml(
      '<a href="https://example.com" title="&quot;><img src=x onerror=alert(1)>">x</a>',
    );
    expect(html).toBe(
      '<a href="https://example.com" title="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;">x</a>',
    );
  });

  it('neutralizes injection in markdown bodies', () => {
    for (const markdown of [
      '[x](javascript:alert(1))',
      '[x](jav&#x61;script:alert(1))',
      '![x](javascript:alert(1))',
      '![x](data:image/svg+xml,alert(1))',
      '<script>alert(1)</script>',
      '<scr<script>ipt>alert(1)</scr<script>ipt>',
      '<img src=x onerror=alert(1)>',
      '![x](https://example.com/a.jpg "a\\" onerror=\\"alert(1)")',
    ]) {
      const html = renderContentBodyHtml(markdown, 'markdown');
      expect(executableParts(html)).toEqual([]);
      expect(executableParts(renderMarkdownToHtml(markdown))).toEqual([]);
      expect(html).not.toMatch(/<script/i);
    }
  });

  it('never rewrites alt text into a new attribute when swapping the thumbnail src', () => {
    const body =
      '<img alt="x src=a onerror=alert(1) b" src="https://example.com/t.jpg" data-smrt-thumbnail="true" data-smrt-placement="full">';
    const html = renderContentBodyHtml(body, 'html', {
      thumbnailSrc: 'https://cdn.example.com/t.jpg',
    });
    expect(executableParts(html)).toEqual([]);
    expect(html).toBe(
      '<img alt="x src=a onerror=alert(1) b" src="https://cdn.example.com/t.jpg" data-smrt-thumbnail="true" data-smrt-placement="full">',
    );
  });

  it('ignores an unsafe thumbnail replacement source', () => {
    const body =
      '<img src="https://example.com/t.jpg" alt="" data-smrt-thumbnail="true" data-smrt-placement="full">';
    expect(
      renderContentBodyHtml(body, 'html', {
        thumbnailSrc: 'javascript:alert(1)',
      }),
    ).toBe(body);
  });
});

describe('body sanitizer: URL policy', () => {
  it('keeps http(s), mailto, tel, relative and fragment links', () => {
    for (const href of [
      'https://example.com/a?b=1&c=2',
      'http://example.com',
      'mailto:news@example.com',
      'tel:+15555550100',
      '/news/story',
      '../story',
      '#section',
      '//cdn.example.com/x',
    ]) {
      const html = sanitizeHtml(
        `<a href="${href.replace(/&/g, '&amp;')}">x</a>`,
      );
      const doc = new DOMParser().parseFromString(html, 'text/html');
      expect(doc.querySelector('a')?.getAttribute('href')).toBe(href);
    }
  });

  it('drops links with other schemes', () => {
    for (const href of [
      'ftp://example.com',
      'file:///etc/passwd',
      'data:text/plain,hi',
    ]) {
      expect(sanitizeHtml(`<a href="${href}">x</a>`)).toBe('<a>x</a>');
    }
  });

  it('keeps raster data images and refuses SVG / non-image data', () => {
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    expect(sanitizeHtml(`<img src="${png}" alt="">`)).toBe(
      `<img src="${png}" alt="">`,
    );
    expect(
      sanitizeHtml('<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="">'),
    ).toBe('');
    expect(
      sanitizeHtml('<img src="data:text/html;base64,PHN2Zz4=" alt="">'),
    ).toBe('');
  });

  it('forces noopener on links that open a new tab and drops other targets', () => {
    expect(
      sanitizeHtml('<a href="https://example.com" target="_blank">x</a>'),
    ).toBe(
      '<a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a>',
    );
    expect(
      sanitizeHtml('<a href="https://example.com" target="top">x</a>'),
    ).toBe('<a href="https://example.com">x</a>');
  });

  it('drops classes, ids and styles outside the image width allowlist', () => {
    expect(
      sanitizeHtml(
        '<p class="x" id="y" style="color: red">a</p><img src="/a.jpg" alt="" class="z" style="width: 320px; position: fixed">',
      ),
    ).toBe('<p>a</p><img src="/a.jpg" alt="" style="width: 320px">');
  });
});

describe('body sanitizer: editor content survives unchanged', () => {
  it('keeps editor-produced rich text byte for byte', () => {
    const html = [
      '<h2>Council <em>votes</em></h2>',
      '<p>Hello <strong>world</strong>, <b>bold</b> <i>it</i> <u>u</u> <s>s</s><br>next line</p>',
      '<ul><li>One</li><li>Two <a href="https://example.com/a?b=1&amp;c=2" title="T">link</a></li></ul>',
      '<ol start="3"><li>Three</li></ol>',
      '<blockquote><p>Quote</p></blockquote>',
      '<pre><code>const a = 1 &lt; 2;</code></pre>',
      '<hr>',
      '<table><thead><tr><th scope="col">A</th></tr></thead><tbody><tr><td colspan="2">1</td></tr></tbody></table>',
      '<figure data-smrt-inline-image="true" data-smrt-placement="left" data-smrt-width="320" style="width: 320px; max-width: 100%"><img src="https://example.com/a.jpg" alt="A"><figcaption>Caption</figcaption></figure>',
    ].join('');
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('keeps inserted image assets unchanged', () => {
    const html = imageAssetToHtml({
      id: 'asset-1',
      name: 'Inline',
      sourceUri: 'https://example.com/inline.jpg',
      width: 400,
    });
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('keeps header and float thumbnail blocks and their markers (HTML)', () => {
    const header = placeThumbnailInBody('<p>First</p><p>Second</p>', 'html', {
      src: 'https://example.com/wide.jpg',
      alt: 'Wide',
      assetId: 'asset-9',
      width: 1600,
      height: 900,
    });
    const float = placeThumbnailInBody('<h2>Head</h2><p>First</p>', 'html', {
      src: 'https://example.com/tall.jpg',
      width: 600,
      height: 900,
    });
    expect(sanitizeHtml(header)).toBe(header);
    expect(sanitizeHtml(float)).toBe(float);
    expect(renderContentBodyHtml(header, 'html')).toBe(header);
    expect(renderContentBodyHtml(float, 'html')).toContain(
      'data-smrt-thumbnail="true" data-smrt-inline-image="true" data-smrt-placement="right"',
    );
    expect(bodyToEditorHtml(header, 'html')).toBe(header);
    expect(editorHtmlToBody(bodyToEditorHtml(float, 'html'), 'html')).toBe(
      float,
    );
  });

  it('keeps Markdown thumbnail blocks through render and the editor', () => {
    const markdown = placeThumbnailInBody(
      'Intro paragraph.\n\nMore.',
      'markdown',
      {
        src: 'https://example.com/tall.jpg',
        alt: 'Tall',
        width: 600,
        height: 900,
      },
    );
    const html = renderContentBodyHtml(markdown, 'markdown');
    expect(html).toContain(
      '<img src="https://example.com/tall.jpg" alt="Tall" data-smrt-thumbnail="true" data-smrt-inline-image="true" data-smrt-placement="right">',
    );
    expect(
      editorHtmlToBody(bodyToEditorHtml(markdown, 'markdown'), 'markdown'),
    ).toBe(markdown);
  });

  it('keeps the bare thumbnail marker form', () => {
    const html =
      '<img src="/t.jpg" alt="" data-smrt-thumbnail data-smrt-placement="full">';
    expect(sanitizeHtml(html)).toBe(html);
  });

  it('strips transient editor state markers', () => {
    expect(
      sanitizeHtml(
        '<img src="/a.jpg" alt="" data-smrt-selected="true" data-smrt-moving="true" data-smrt-resizing="true" data-smrt-placement="sideways">',
      ),
    ).toBe('<img src="/a.jpg" alt="">');
  });
});
