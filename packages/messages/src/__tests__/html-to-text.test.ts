import { describe, expect, it } from 'vitest';
import {
  HTML_TO_TEXT_MAX_INPUT,
  HTML_TO_TEXT_TRUNCATED,
  htmlToText,
} from '../html-to-text';

describe('htmlToText', () => {
  it('drops script/style (incl. "</script >" and unclosed) content', () => {
    expect(htmlToText('a<script>evil()</script >b')).toBe('ab');
    expect(htmlToText('a<style>p{}</STYLE>b')).toBe('ab');
    expect(htmlToText('a<script>never closed <b>x')).toBe('a');
    expect(htmlToText('a<style>never closed')).toBe('a');
  });
  it('drops comments (even containing ">") and head/title/template/noscript', () => {
    expect(htmlToText('a<!-- x > y <b>z</b> -->b')).toBe('ab');
    expect(
      htmlToText(
        '<head><title>T</title></head><template>t</template><noscript>n</noscript>body',
      ),
    ).toBe('body');
  });
  it('keeps CSS-hidden text (documented limitation)', () => {
    expect(htmlToText('<p style="display:none">hidden</p>')).toBe('hidden');
  });
  it('decodes numeric and common named entities, never passes markup', () => {
    expect(htmlToText('it&#8217;s &mdash; &amp; &#x41; &lt;b&gt;')).toBe(
      'it’s — & A <b>',
    );
    expect(htmlToText('x <a href="y">link</a> <b')).toBe('x link');
  });
  it('keeps block breaks and leaves plain text unchanged', () => {
    expect(htmlToText('<p>one</p><p>two</p>')).toBe('one\n\ntwo');
    expect(htmlToText('plain text, no markup')).toBe('plain text, no markup');
  });
  it('is linear on multi-MB hostile input', () => {
    const inputs = [
      '<'.repeat(4_000_000),
      '<script>'.repeat(500_000),
      '<a '.repeat(1_500_000),
      '<!--'.repeat(1_000_000),
      ' '.repeat(HTML_TO_TEXT_MAX_INPUT),
      '\t '.repeat(HTML_TO_TEXT_MAX_INPUT / 2),
      '<i> </i>'.repeat(40_000),
      '\n'.repeat(HTML_TO_TEXT_MAX_INPUT),
    ];
    const start = Date.now();
    for (const input of inputs) htmlToText(input);
    expect(Date.now() - start).toBeLessThan(5000);
  });
  it('marks truncation and does not split a surrogate pair', () => {
    const out = htmlToText('a'.repeat(HTML_TO_TEXT_MAX_INPUT * 2));
    expect(out.endsWith(HTML_TO_TEXT_TRUNCATED)).toBe(true);
    const pair = `${'a'.repeat(HTML_TO_TEXT_MAX_INPUT - 1)}\u{1F600}tail`;
    const cut = htmlToText(pair);
    expect(cut).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
    expect(cut.endsWith(HTML_TO_TEXT_TRUNCATED)).toBe(true);
  });
  it('does not let multi-char lowercase code points desync script skipping', () => {
    expect(htmlToText('\u0130<script>alert(1)</script>ok')).toBe('\u0130ok');
    expect(htmlToText('\u0130\u0130\u0130<STYLE>x</STYLE>ok')).toBe(
      '\u0130\u0130\u0130ok',
    );
    expect(htmlToText('\u1E9E<ScRiPt>x</sCrIpT>y')).toBe('\u1E9Ey');
  });
  it('treats a bare < as text', () => {
    expect(htmlToText('a < b and 1 < 2 > 0')).toBe('a < b and 1 < 2 > 0');
    expect(htmlToText('x <3 y')).toBe('x <3 y');
    expect(htmlToText('<!DOCTYPE html><p>hi</p>')).toBe('hi');
  });
  it('strips bidi/format/control characters, also via entities', () => {
    expect(
      htmlToText('a\u202Eb\u200Bc\uFEFFd\u2028e\u0007f&#8238;g&#x202e;h&#7;i'),
    ).toBe('abcdefghi');
    expect(htmlToText('keep\ttab\nline')).toBe('keep\ttab\nline');
  });
});
