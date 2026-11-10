/**
 * Asking the page's assistant from anywhere on the page: a "New report" button,
 * an empty state, a help hint. Pure DOM, so a widget can ask without knowing
 * which assistant (if any) the host mounted, and the assistant can listen
 * without importing the widget's package.
 *
 * The requester dispatches a bubbling, cancelable event with the prompt to put
 * in the composer. Whoever takes it calls `preventDefault()`:
 * - an app shell with an assistant dock opens the dock and re-dispatches the
 *   request from inside it, so a dock that mounts only when open still gets it;
 * - the assistant dock fills its composer with the prompt and focuses it. The
 *   prompt is never sent on the person's behalf: they edit and send it.
 *
 * `requestAssistant` returns whether anything took it, so the requester can
 * explain where to ask instead when no assistant is on the page.
 */

/** The bubbling DOM event that asks the page's assistant. */
export const ASSISTANT_REQUEST_EVENT = 'smrt-assistant-request';

export interface AssistantRequestDetail {
  /** Text to put in the assistant's composer, for the person to edit and send. */
  prompt: string;
}

/** Ask the page's assistant from `from`; `true` when something took the request. */
export function requestAssistant(
  from: Element,
  detail: AssistantRequestDetail,
): boolean {
  const event = new CustomEvent<AssistantRequestDetail>(
    ASSISTANT_REQUEST_EVENT,
    { bubbles: true, composed: true, cancelable: true, detail },
  );
  from.dispatchEvent(event);
  return event.defaultPrevented;
}
