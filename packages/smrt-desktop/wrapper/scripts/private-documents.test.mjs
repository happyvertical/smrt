import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
const source = readFileSync(new URL('../src/document_ui.rs', import.meta.url), 'utf8');
const script = /const ANCHOR_SCRIPT: &str = r#"([\s\S]*?)"#;/.exec(source)?.[1];
assert.ok(script, 'shipped native main-frame initialization script exists');
const capability = 'a'.repeat(64);
function fixture({ foreignFrame = false } = {}) {
  const listeners = new Map();
  class Element {
    closest() { return this; }
    getAttribute(name) { return name === 'target' ? this.target : undefined; }
    hasAttribute(name) { return name === 'download' && this.download; }
    after(note) { this.notes = [...(this.notes ?? []), note]; }
  }
  const window = { location: { href: 'http://127.0.0.1:49123/' }, addEventListener: (name, fn) => listeners.set(name, fn) };
  window.top = foreignFrame ? {} : window;
  const document = { createElement: () => ({ setAttribute() {} }) };
  runInNewContext(script.replace('__SMRT_PRIVATE_ACTION_CAPABILITY__', capability), { window, document, Element });
  const click = (options = {}) => {
    const anchor = Object.assign(new Element(), { href: 'http://127.0.0.1:49123/documents/id/pdf', target: '_blank', download: false }, options.anchor);
    const event = { target: anchor, isTrusted: true, defaultPrevented: false, button: 0, preventDefault() { this.defaultPrevented = true; }, stopImmediatePropagation() { this.stopped = true; }, ...options.event };
    listeners.get(options.kind ?? 'click')?.(event);
    return { event, anchor, location: window.location.href };
  };
  return { click, window, listeners };
}
test('trusted anchor and download activations carry only a bounded per-window action', () => {
  for (const anchor of [{}, { target: '', download: true }]) {
    const result = fixture().click({ anchor });
    const action = new URL(result.location);
    assert.equal(action.protocol, 'smrt-private-document:');
    assert.equal(action.hostname, 'open');
    assert.equal(action.searchParams.get('cap'), capability);
    assert.equal(action.searchParams.get('url'), 'http://127.0.0.1:49123/documents/id/pdf');
    assert.equal(result.event.defaultPrevented, true);
    assert.equal(result.event.stopped, true);
  }
});
test('foreign frames, synthetic clicks and ordinary app links get no action capability', () => {
  assert.equal(fixture({ foreignFrame: true }).listeners.size, 0);
  for (const options of [{ event: { isTrusted: false } }, { event: { button: 1 } }, { anchor: { target: '' } }]) {
    const result = fixture().click(options);
    assert.equal(result.location, 'http://127.0.0.1:49123/');
    assert.equal(result.event.defaultPrevented, false);
  }
  assert.deepEqual(Object.keys(fixture().window).sort(), ['addEventListener', 'location', 'top']);
});
test('URL payloads remain untrusted encoded values without extra native-action parameters', () => {
  const href = 'https://foreign.invalid/documents/id/pdf?proof=synthetic&cap=forged#fragment';
  const result = fixture().click({ anchor: { href } });
  const params = new URL(result.location).searchParams;
  assert.deepEqual([...params.keys()], ['cap', 'url']);
  assert.equal(params.get('url'), href);
  assert.equal(params.get('cap'), capability);
});
test('unsupported document context menus give guidance without opening or saving', () => {
  const result = fixture().click({ kind: 'contextmenu' });
  assert.equal(result.location, 'http://127.0.0.1:49123/');
  assert.equal(result.event.defaultPrevented, true);
  assert.match(result.anchor.notes[0].textContent, /primary click or Enter/);
});
