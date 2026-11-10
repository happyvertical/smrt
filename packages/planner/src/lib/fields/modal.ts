/**
 * A Svelte attachment for a `<dialog>` that holds a `<form>`: it moves the
 * element to `document.body`, so the form is not nested inside another
 * `<form>` (whose submit would bubble to the outer one), then opens it as a
 * modal (focus is trapped and Escape closes it).
 */
export function modalInBody(node: HTMLDialogElement): () => void {
  document.body.appendChild(node);
  node.showModal();
  return () => {
    node.close();
    node.remove();
  };
}
