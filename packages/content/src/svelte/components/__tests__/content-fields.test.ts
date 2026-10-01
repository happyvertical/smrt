// @vitest-environment jsdom
import {
  createControlInteractionRegistry,
  executeLocalControlCommand,
} from '@happyvertical/smrt-ui/forms';
import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Fixture from './content-fields.fixture.svelte';

const mounted: Array<ReturnType<typeof mount>> = [];

function renderFixture(props: Record<string, unknown>): HTMLElement {
  const target = document.createElement('div');
  document.body.appendChild(target);
  mounted.push(mount(Fixture, { target, props: props as never }));
  flushSync();
  return target;
}

afterEach(() => {
  while (mounted.length) {
    const component = mounted.pop();
    if (component) unmount(component);
  }
  document.body.innerHTML = '';
});

function controls(
  registry: ReturnType<typeof createControlInteractionRegistry>,
) {
  return Object.fromEntries(
    registry
      .list('content-editor')
      .map((snapshot) => [
        snapshot.identity.controlId,
        snapshot.metadata.label,
      ]),
  );
}

function labelTexts(target: HTMLElement): string[] {
  return Array.from(target.querySelectorAll('label')).map((label) =>
    (label.textContent ?? '').replace(/\s+/g, ' ').trim(),
  );
}

describe('content editor fields', () => {
  it('register every full-mode field for agents under plain labels', async () => {
    const registry = createControlInteractionRegistry();
    const target = renderFixture({ registry });
    await tick();
    expect(controls(registry)).toEqual({
      title: 'Title',
      type: 'Type',
      state: 'State',
      status: 'Status',
      publish_date: 'Published',
      body: 'Story',
      author: 'Author',
      description: 'Description',
      tags: 'Tags',
      url: 'URL',
      fileKey: 'File Key',
    });
    expect(target.querySelector('details')).toBeNull();
  });

  it('simple mode keeps the everyday fields, marks optional ones, and collapses Details', async () => {
    const registry = createControlInteractionRegistry();
    const target = renderFixture({ registry, mode: 'simple' });
    await tick();
    expect(controls(registry)).toEqual({
      title: 'Title',
      status: 'Status',
      publish_date: 'Publish date (optional)',
      body: 'Story',
      author: 'Author (optional)',
      description: 'Summary (optional)',
      tags: 'Tags (optional)',
    });
    const labels = labelTexts(target);
    expect(labels).not.toContain('Type');
    expect(labels).not.toContain('State');
    expect(labels.some((label) => label.startsWith('URL'))).toBe(false);
    const details = target.querySelector('details') as HTMLDetailsElement;
    expect(details.querySelector('summary')?.textContent).toBe('Details');
    expect(details.open).toBe(false);
    const statusOptions = Array.from(
      target.querySelectorAll('select[name="status"] option'),
    ).map((option) => option.textContent);
    expect(statusOptions).toContain('Ready for review');
  });

  it('applies a staged story proposal through the body editor', async () => {
    const registry = createControlInteractionRegistry({
      isLocalGesture: () => true,
    });
    const onChange = vi.fn();
    const target = renderFixture({ registry, mode: 'simple', onChange });
    await tick();
    const identity = { formId: 'content-editor', controlId: 'body' };
    expect(registry.get(identity)?.state.value).toBe('<p>The council met.</p>');
    await registry.execute(
      { action: 'stage', identity, value: '<p>The council voted 5-2.</p>' },
      { source: 'agent' },
    );
    expect(onChange).not.toHaveBeenCalled();
    const gesture = new EventTarget();
    let applied: Promise<unknown> | undefined;
    gesture.addEventListener('click', (event) => {
      applied = executeLocalControlCommand(
        registry,
        { action: 'apply', identity },
        event,
      );
    });
    gesture.dispatchEvent(new Event('click'));
    expect(await applied).toMatchObject({ ok: true });
    expect(onChange).toHaveBeenCalledWith({
      body: '<p>The council voted 5-2.</p>',
    });
    const surface = target.querySelector('[aria-label="Story"]') as HTMLElement;
    expect(surface.textContent).toContain('The council voted 5-2.');
    expect(surface.dataset.smrtControl).toBe('body');
  });
});
