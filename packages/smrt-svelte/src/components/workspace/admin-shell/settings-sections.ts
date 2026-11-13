/**
 * The built-in sections of the shell settings (`ShellSettingsPanel`), so a
 * host can list them as a menu and render one per page (`ShellSettingsPage`
 * with a `section`).
 */
export const SHELL_SETTINGS_SECTIONS = [
  'appearance',
  'account',
  'layout',
  'shortcuts',
] as const;

export type ShellSettingsSection = (typeof SHELL_SETTINGS_SECTIONS)[number];

/** True when `value` names a built-in settings section (route param matchers). */
export function isShellSettingsSection(
  value: unknown,
): value is ShellSettingsSection {
  return (
    typeof value === 'string' &&
    (SHELL_SETTINGS_SECTIONS as readonly string[]).includes(value)
  );
}
