<script lang="ts">
/**
 * Phone tab bar: the footer region's phone presentation (conceptually the
 * footer's center slot), not a new region. Navigation tabs (icon, label,
 * `aria-current`), then the dock tab, then "More" when navigation overflows.
 * Rendered by `AppShell` into `AdminShell`'s `phoneBottomBar` track when
 * `phoneTabBar` is on.
 */
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import type { Component } from 'svelte';
import { M } from '../../i18n/strings.workspace.js';
import { useAdminShell } from '../workspace/admin-shell/context.js';
import { useShellDock } from '../workspace/admin-shell/dock.js';
import PhoneBottomBar from '../workspace/admin-shell/PhoneBottomBar.svelte';
import {
  isShellIconName,
  SHELL_DEFAULT_TOOL_ICON,
  SHELL_PLACEHOLDER_ICON,
} from '../workspace/admin-shell/shell-icons.js';
import type { PhoneBottomBarEntry } from '../workspace/admin-shell/types.js';
import type { DockToggle } from './dock-toggle.js';
import {
  isTabCurrent,
  type PhoneTabNavEntry,
  planPhoneTabs,
} from './phone-tabs.js';

interface Props {
  /** Navigation destinations in order (see `phoneTabNavEntries`). */
  entries: PhoneTabNavEntry[];
  /** Current path, for `aria-current`. */
  currentHref?: string;
  /** Navigation and dock tabs before "More". */
  budget: number;
  /** The dock toggle that gets a tab; without one a "Tools" tab opens the right edge when it has tools. */
  dockToggle?: DockToggle;
  /** Renders host icon names. */
  iconComponent?: Component<{ name: string; size?: number }>;
}

let {
  entries,
  currentHref = '',
  budget,
  dockToggle,
  iconComponent,
}: Props = $props();

const { t } = useI18n();
const shell = useAdminShell();
const dock = useShellDock();

const toolsTab = $derived(
  !dockToggle && shell.isEdgeShown('right') && shell.focusTools.length > 0,
);
const hasDockTab = $derived(Boolean(dockToggle) || toolsTab);
const plan = $derived(planPhoneTabs(entries, budget, hasDockTab));

function dockIcon(toggle: DockToggle): string {
  const icon =
    toggle.icon ?? (toggle.tool === 'assistant' ? 'chat' : undefined);
  return icon && (isShellIconName(icon) || iconComponent)
    ? icon
    : SHELL_DEFAULT_TOOL_ICON;
}

function openTools(): void {
  if (shell.panels.right === 'expanded') {
    shell.collapsePanel('right');
    return;
  }
  const tool =
    shell.focusTools.find((entry) => entry.id === shell.activeFocusToolId) ??
    shell.focusTools[0];
  if (tool) shell.openFocusTool(tool.id);
  else shell.expandPanel('right');
}

function openMore(): void {
  shell.setPanelState(
    'left',
    shell.panels.left === 'expanded' ? 'collapsed' : 'expanded',
  );
}

const items = $derived.by(() => {
  const out: PhoneBottomBarEntry[] = plan.nav.map((entry) => ({
    id: entry.id,
    label: entry.label,
    href: entry.href,
    iconName: entry.icon ?? SHELL_PLACEHOLDER_ICON,
    active: isTabCurrent(entry.href, currentHref),
  }));
  if (dockToggle) {
    const tool = dockToggle.tool;
    out.push({
      id: `dock:${tool}`,
      label: dockToggle.label,
      iconName: dockIcon(dockToggle),
      active: dock.isOpen(tool),
      expanded: dock.isOpen(tool),
      controls: 'smrt-admin-shell-right-panel',
      onclick: () => {
        if (dock.has(tool) && dock.available) dock.toggle(tool);
      },
    });
  } else if (toolsTab) {
    out.push({
      id: 'tools',
      label: t(M['ui.admin_shell.tools']),
      iconName: SHELL_DEFAULT_TOOL_ICON,
      active: shell.panels.right === 'expanded',
      expanded: shell.panels.right === 'expanded',
      controls: 'smrt-admin-shell-right-panel',
      onclick: openTools,
    });
  }
  if (plan.more) {
    out.push({
      id: 'more',
      label: t(M['ui.phone_tab_bar.more']),
      iconName: 'more',
      expanded: shell.panels.left === 'expanded',
      controls: 'smrt-admin-shell-left-panel',
      onclick: openMore,
    });
  }
  return out;
});
</script>

<PhoneBottomBar
  {items}
  {iconComponent}
  label={t(M['ui.phone_tab_bar.label'])}
/>
