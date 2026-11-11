import { defineMessages } from '@happyvertical/smrt-ui/i18n';

export const M = defineMessages({
  'ui.connect_ai.working_directory':
    'The local AI needs a writable temporary directory. Check the app permissions, then retry.',
  'ui.connect_ai.runtime_unavailable':
    'The local AI cannot start in this app. Check its executable and Node installation, then retry.',
  'ui.connect_ai.cli_invocation':
    'The local AI does not accept the required secure options. Update the CLI, then retry.',
  'ui.connect_ai.title': 'Connect AI',
  'ui.connect_ai.loading': 'Checking the AI available on this computer…',
  'ui.connect_ai.options': 'Your AI',
  'ui.connect_ai.missing': 'Not installed on this computer.',
  'ui.connect_ai.signed_out': 'Installed, not signed in.',
  'ui.connect_ai.signed_in': 'Installed and signed in.',
  'ui.connect_ai.unknown': 'Installed, but it did not answer.',
  'ui.connect_ai.install': 'How to install {tool}',
  'ui.connect_ai.use': 'Use my {tool}',
  'ui.connect_ai.sign_in': 'Sign in with {tool}',
  'ui.connect_ai.waiting': 'Waiting for sign-in…',
  'ui.connect_ai.in_use': 'In use',
  'ui.connect_ai.retry': 'Check again',
  'ui.connect_ai.api': 'API key',
  'ui.connect_ai.api_saved': 'An API key is configured.',
  'ui.connect_ai.api_missing': 'Save a key in AI settings.',
  'ui.connect_ai.save_key': 'Save an API key',
  'ui.connect_ai.use_key': 'Use my API key',
  'ui.connect_ai.chatgpt': 'ChatGPT',
  'ui.connect_ai.claude': 'Claude Code',
  'ui.connect_ai.codex': 'Codex',
  'ui.connect_ai.chatgpt_description':
    'Use your own ChatGPT plan. A preview for local open source apps.',
  'ui.connect_ai.chatgpt_signed_in': 'Signed in.',
  'ui.connect_ai.sign_out': 'Sign out of ChatGPT',
  'ui.connect_ai.open_sign_in': 'Open the ChatGPT sign-in page',
  'ui.connect_ai.new_tab': '(opens in a new tab)',
  'ui.connect_ai.error':
    'Could not connect AI. Check your connection and try again.',
  'ui.connect_ai.sign_in_error': 'Sign-in did not finish. Try again.',
  'ui.connect_ai.ready': 'The assistant is ready.',
  'ui.connect_ai.not_ready': 'Nothing connected yet.',
  'ui.connect_ai.legal':
    'Claude Code and Codex use your own installed CLI and its vendor sign-in, billed to your account. In-app Claude subscription login is not offered; this app does not collect or proxy CLI credentials.',
  'ui.connect_ai.preview':
    'Sign in with ChatGPT uses OpenAI’s own sign-in page. Preview limitations apply.',
});
