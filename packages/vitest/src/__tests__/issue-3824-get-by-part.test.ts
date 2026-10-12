// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getByPart, queryByPart } from '../svelte.js';

function render(html: string): HTMLElement {
  document.body.innerHTML = html;
  return document.body;
}

describe('getByPart / queryByPart (#3824)', () => {
  it('finds a part inside the named component root only', () => {
    const container = render(`
      <div data-smrt-component="Tabs"><button data-smrt-part="tab">A</button></div>
      <div data-smrt-component="Card"><button data-smrt-part="tab">B</button></div>
    `);
    expect(getByPart('Tabs', 'tab', container).textContent).toBe('A');
    expect(getByPart('Card', 'tab', container).textContent).toBe('B');
  });

  it('throws when no part matches or more than one matches', () => {
    const container = render(`
      <div data-smrt-component="Tabs">
        <span data-smrt-part="label">one</span>
        <span data-smrt-part="label">two</span>
      </div>
    `);
    expect(() => getByPart('Tabs', 'missing', container)).toThrow(/found 0/);
    expect(() => getByPart('Tabs', 'label', container)).toThrow(/found 2/);
  });

  it('queryByPart returns null for no match and throws on several', () => {
    const container = render(`
      <div data-smrt-component="Badge"><span data-smrt-part="label">x</span></div>
    `);
    expect(queryByPart('Badge', 'missing', container)).toBeNull();
    expect(queryByPart('Badge', 'label', container)?.textContent).toBe('x');
    expect(() => queryByPart('Tabs', 'label', container)).not.toThrow();
  });

  it('escapes quotes in names rather than breaking the selector', () => {
    const container = render(`
      <div data-smrt-component='Odd"Name'><span data-smrt-part="p">ok</span></div>
    `);
    expect(getByPart('Odd"Name', 'p', container).textContent).toBe('ok');
  });
});
