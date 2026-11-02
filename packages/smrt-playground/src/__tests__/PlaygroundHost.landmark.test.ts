/**
 * Regression (#4374): an embedded playground must not render a second
 * `<main>` landmark inside its host page.
 */
import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import PlaygroundHost from '../svelte/PlaygroundHost.svelte';

describe('PlaygroundHost workspace landmark', () => {
  it('renders <main> when standalone', () => {
    const { body } = render(PlaygroundHost, { props: { embedded: false } });
    expect(body).toMatch(/<main[^>]*class="workspace[ "]/);
  });

  it('renders a plain <div> when embedded', () => {
    const { body } = render(PlaygroundHost, { props: { embedded: true } });
    expect(body).not.toContain('<main');
    expect(body).toMatch(/<div[^>]*class="workspace[ "]/);
  });
});
