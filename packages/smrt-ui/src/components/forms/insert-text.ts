/**
 * Put text into a text field at the cursor, the way typing would.
 *
 * - Replaces the selection, if any.
 * - A field that has never had the cursor in it gets the text at the end.
 * - Adds a space before the text when it would otherwise run into a word,
 *   and after it when the next character is a letter or digit.
 * - Leaves the cursor after the inserted text and fires `input`, so bound
 *   values (`bind:value`) and listeners see the change.
 */
export function insertTextAtCursor(
  field: HTMLTextAreaElement | HTMLInputElement,
  text: string,
): void {
  const words = text.trim();
  if (!words) return;
  const value = field.value;
  const focused =
    typeof document !== 'undefined' && document.activeElement === field;
  let start = field.selectionStart ?? value.length;
  let end = field.selectionEnd ?? value.length;
  // An untouched field reports 0/0; dictation then belongs at the end.
  if (!focused && start === 0 && end === 0 && value.length > 0) {
    start = value.length;
    end = value.length;
  }
  const before = value.slice(0, start);
  const after = value.slice(end);
  const lead = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const trail = /^[\p{L}\p{N}]/u.test(after) ? ' ' : '';
  const inserted = `${lead}${words}${trail}`;
  field.value = `${before}${inserted}${after}`;
  const caret = before.length + inserted.length;
  try {
    field.setSelectionRange(caret, caret);
  } catch {
    // Some input types do not support selection; the value is still set.
  }
  field.dispatchEvent(new Event('input', { bubbles: true }));
}
