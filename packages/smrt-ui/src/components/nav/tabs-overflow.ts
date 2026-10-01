/**
 * Split tabs into the row and a "More" menu, keeping the active tab in the
 * row: with more tabs than `maxVisible`, the first `maxVisible - 1` show, then
 * the active tab (or the next one), and the rest go to the menu.
 */
export function splitTabs<T extends { id: string }>(
  tabs: readonly T[],
  activeId: string | null | undefined,
  maxVisible: number | undefined,
): { visible: T[]; overflow: T[] } {
  if (!maxVisible || maxVisible < 1 || tabs.length <= maxVisible) {
    return { visible: [...tabs], overflow: [] };
  }
  const visible = tabs.slice(0, maxVisible - 1);
  const rest = tabs.slice(maxVisible - 1);
  const promoted = rest.find((tab) => tab.id === activeId) ?? rest[0];
  return {
    visible: promoted ? [...visible, promoted] : visible,
    overflow: rest.filter((tab) => tab !== promoted),
  };
}
