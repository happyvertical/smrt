/** A section a host adds to the `ShellSettingsPage` menu (it renders its own page for it). */
export interface ShellSettingsMenuItem {
  /** Route segment under the page's `basePath`. */
  id: string;
  label: string;
  description?: string;
}
