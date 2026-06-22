export function formatEmail(transcript: string): string {
  return transcript
    .toLowerCase()
    .replace(/\s+at\s+/gi, '@')
    .replace(/\bat\b/gi, '@')
    .replace(/\s+dot\s+/gi, '.')
    .replace(/\bdot\b/gi, '.')
    .replace(/\s+/g, '')
    .trim();
}

export function formatText(transcript: string): string {
  return transcript
    .replace(/^(my name is|i am|i'm|it's|this is|the name is)\s*/i, '')
    .replace(/\b(um|uh|like|so|well)\b\s*/gi, '')
    .trim();
}

/**
 * Parses a spoken string into a boolean value.
 */
export function parseSpokenBoolean(text: string): boolean | null {
  const normalized = text.toLowerCase().trim();

  const trueWords = [
    'yes',
    'yeah',
    'yep',
    'true',
    'correct',
    'affirmative',
    'check',
    'checked',
    'on',
    'enable',
    'enabled',
  ];
  const falseWords = [
    'no',
    'nope',
    'false',
    'incorrect',
    'negative',
    'uncheck',
    'unchecked',
    'off',
    'disable',
    'disabled',
  ];

  for (const word of trueWords) {
    if (normalized.includes(word)) return true;
  }

  for (const word of falseWords) {
    if (normalized.includes(word)) return false;
  }

  return null;
}

/**
 * Matches a spoken string against a list of options.
 */
export function matchOption(
  spokenText: string,
  options: Array<{ label: string; value: string }>,
): string | null {
  const normalized = spokenText.toLowerCase().trim();

  // Try exact match first
  for (const opt of options) {
    if (
      opt.value.toLowerCase() === normalized ||
      opt.label.toLowerCase() === normalized
    ) {
      return opt.value;
    }
  }

  // Try partial match
  for (const opt of options) {
    if (
      opt.label.toLowerCase().includes(normalized) ||
      normalized.includes(opt.label.toLowerCase())
    ) {
      return opt.value;
    }
  }

  return null;
}
