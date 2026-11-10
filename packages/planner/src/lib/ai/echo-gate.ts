/**
 * Half-duplex voice: the spoken reply and the microphone take turns. While
 * `AiState.speaking` the dock suspends hands-free listening; these rules say
 * when the visitor's own action should cut the reply short instead.
 */

/**
 * True for an event inside the assistant dock that means the visitor wants
 * the floor: typing in the message box, or pressing the microphone button.
 */
export function cancelsSpeech(event: {
  type: string;
  target: EventTarget | null;
}): boolean {
  const target = event.target as Element | null;
  if (!target || typeof target.closest !== 'function') return false;
  if (event.type === 'input') {
    return target.matches('textarea, input[type="text"], input:not([type])');
  }
  if (event.type === 'click') {
    return target.closest('.smrt-dictation-button') !== null;
  }
  return false;
}
