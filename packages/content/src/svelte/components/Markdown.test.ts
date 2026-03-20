// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import Markdown from './Markdown.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderMarkdown(props: { content: string; class?: string }) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = mount(Markdown, {
    target,
    props,
  });

  mountedComponents.push(component);
  flushSync();

  return target;
}

afterEach(() => {
  while (mountedComponents.length > 0) {
    const component = mountedComponents.pop();
    if (component) {
      unmount(component);
    }
  }
  document.body.innerHTML = '';
});

describe('Markdown component', () => {
  it('renders markdown structure and inline formatting', () => {
    const target = renderMarkdown({
      class: 'article-body',
      content:
        '# Heading\n\nThis is **bold** and *italic* with `code`.\n\n- One\n- Two',
    });

    const root = target.querySelector('.markdown-content.article-body');
    expect(root).not.toBeNull();
    expect(root?.querySelector('h1')?.textContent).toBe('Heading');
    expect(root?.querySelector('strong')?.textContent).toBe('bold');
    expect(root?.querySelector('em')?.textContent).toBe('italic');
    expect(root?.querySelector('code')?.textContent).toBe('code');
    expect(
      Array.from(root?.querySelectorAll('li') ?? []).map((item) =>
        item.textContent?.trim(),
      ),
    ).toEqual(['One', 'Two']);
  });

  it('escapes embedded HTML before rendering markdown', () => {
    const target = renderMarkdown({
      content: '<script>alert("xss")</script>\n\n**safe**',
    });

    const root = target.querySelector('.markdown-content');
    expect(root?.innerHTML).toContain(
      '&lt;script&gt;alert("xss")&lt;/script&gt;',
    );
    expect(root?.querySelector('script')).toBeNull();
    expect(root?.querySelector('strong')?.textContent).toBe('safe');
  });
});
