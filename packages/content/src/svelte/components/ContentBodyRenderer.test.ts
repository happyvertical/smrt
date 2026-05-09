// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it } from 'vitest';
import ContentBodyRenderer from './ContentBodyRenderer.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderBody(props: {
  content: string;
  format?: 'markdown' | 'html' | null;
}) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = mount(ContentBodyRenderer, {
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

describe('ContentBodyRenderer component', () => {
  it('renders markdown images and links', () => {
    const target = renderBody({
      format: 'markdown',
      content:
        '[Link](https://example.com)\n\n![Alt](https://example.com/a.jpg)',
    });

    expect(target.querySelector('a')?.getAttribute('href')).toBe(
      'https://example.com',
    );
    expect(target.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.com/a.jpg',
    );
  });

  it('renders sanitized HTML bodies', () => {
    const target = renderBody({
      format: 'html',
      content:
        '<p onclick="alert(1)">Hello</p><script>alert(1)</script><img src="https://example.com/a.jpg" onerror="x()">',
    });

    expect(target.querySelector('p')?.textContent).toBe('Hello');
    expect(target.querySelector('script')).toBeNull();
    expect(target.innerHTML).not.toContain('onclick');
    expect(target.innerHTML).not.toContain('onerror');
    expect(target.querySelector('img')?.getAttribute('src')).toBe(
      'https://example.com/a.jpg',
    );
  });

  it('infers legacy HTML when format is missing', () => {
    const target = renderBody({
      format: null,
      content: '<h1>Legacy</h1><p>Body</p>',
    });

    expect(target.querySelector('h1')?.textContent).toBe('Legacy');
  });
});
