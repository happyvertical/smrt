// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentContributionForm from './ContentContributionForm.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderForm(props: Record<string, any>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ContentContributionForm, {
    target,
    props,
  });
  mountedComponents.push(component);
  flushSync();
  return target;
}

function setValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
) {
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

afterEach(() => {
  while (mountedComponents.length > 0) {
    const component = mountedComponents.pop();
    if (component) {
      unmount(component);
    }
  }

  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('ContentContributionForm', () => {
  it('emits the selected type, contributor fields, and held files', () => {
    const onSubmit = vi.fn();
    const target = renderForm({
      types: [
        { key: 'letter', label: 'Letter', enabled: true, allowFiles: true },
      ],
      onSubmit,
    });

    const emailInput = target.querySelector(
      'input[type="email"]',
    ) as HTMLInputElement;
    const textInputs = target.querySelectorAll('input[type="text"]');
    const textareas = target.querySelectorAll('textarea');
    const fileInput = target.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const form = target.querySelector('form') as HTMLFormElement;

    setValue(emailInput, 'reader@example.com');
    setValue(textInputs[0] as HTMLInputElement, 'Reader');
    setValue(textInputs[1] as HTMLInputElement, 'Letter title');
    setValue(textareas[0] as HTMLTextAreaElement, 'Short description');
    setValue(textareas[1] as HTMLTextAreaElement, 'Longer body text');

    const file = new File(['hello'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(fileInput, 'files', {
      value: [file],
      configurable: true,
    });
    fileInput.dispatchEvent(new Event('change', { bubbles: true }));

    form.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        typeKey: 'letter',
        contributorEmail: 'reader@example.com',
        contributorName: 'Reader',
        title: 'Letter title',
        description: 'Short description',
        body: 'Longer body text',
        files: [file],
      }),
    );
  });

  it('exposes a native POST form contract for contribution fields', () => {
    const target = renderForm({
      types: [
        { key: 'letter', label: 'Letter', enabled: true, allowFiles: true },
        { key: 'news-tip', label: 'News tip', enabled: true, allowFiles: true },
      ],
      action: '/contentcontributions/submit',
    });

    const form = target.querySelector('form') as HTMLFormElement;
    const typeSelect = target.querySelector(
      'select[name="typeKey"]',
    ) as HTMLSelectElement;
    const emailInput = target.querySelector(
      'input[name="contributorEmail"]',
    ) as HTMLInputElement;
    const contributorNameInput = target.querySelector(
      'input[name="contributorName"]',
    ) as HTMLInputElement;
    const titleInput = target.querySelector(
      'input[name="title"]',
    ) as HTMLInputElement;
    const descriptionTextarea = target.querySelector(
      'textarea[name="description"]',
    ) as HTMLTextAreaElement;
    const bodyTextarea = target.querySelector(
      'textarea[name="body"]',
    ) as HTMLTextAreaElement;
    const fileInput = target.querySelector(
      'input[name="files"]',
    ) as HTMLInputElement;

    expect(form.method).toBe('post');
    expect(form.enctype).toBe('multipart/form-data');
    expect(form.getAttribute('action')).toBe('/contentcontributions/submit');

    setValue(typeSelect, 'news-tip');
    setValue(emailInput, 'reader@example.com');
    setValue(contributorNameInput, 'Reader');
    setValue(titleInput, 'Letter title');
    setValue(descriptionTextarea, 'Short description');
    setValue(bodyTextarea, 'Longer body text');

    const file = new File(['hello'], 'photo.jpg', { type: 'image/jpeg' });
    Object.defineProperty(fileInput, 'files', {
      value: [file],
      configurable: true,
    });

    const formData = new FormData(form);

    expect(Object.fromEntries(formData.entries())).toMatchObject({
      typeKey: 'news-tip',
      contributorEmail: 'reader@example.com',
      contributorName: 'Reader',
      title: 'Letter title',
      description: 'Short description',
      body: 'Longer body text',
    });
    expect(formData.getAll('files')).toEqual([file]);
  });

  it('allows native form submission when no submit callback is provided', () => {
    const target = renderForm({
      types: [
        { key: 'letter', label: 'Letter', enabled: true, allowFiles: true },
      ],
      action: '/contentcontributions/submit',
    });

    const form = target.querySelector('form') as HTMLFormElement;
    const event = new Event('submit', { bubbles: true, cancelable: true });

    form.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('prevents native submission when neither callback nor action is provided', () => {
    const target = renderForm({
      types: [
        { key: 'letter', label: 'Letter', enabled: true, allowFiles: true },
      ],
    });

    const form = target.querySelector('form') as HTMLFormElement;
    const event = new Event('submit', { bubbles: true, cancelable: true });

    form.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
