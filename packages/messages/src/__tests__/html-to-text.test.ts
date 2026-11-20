import { describe, expect, it } from 'vitest';
import { HTML_TO_TEXT_MAX_INPUT, htmlToText } from '../html-to-text';

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
    ];
    const start = Date.now();
    for (const input of inputs) htmlToText(input);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(htmlToText('a'.repeat(HTML_TO_TEXT_MAX_INPUT * 2)).length).toBe(
      HTML_TO_TEXT_MAX_INPUT,
    );
  });
});
