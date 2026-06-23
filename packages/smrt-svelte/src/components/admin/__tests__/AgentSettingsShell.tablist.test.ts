/**
 * Regression: the agent switcher is a proper ARIA tablist (C8).
 *
 * It was a <nav> of <button>s acting as single-select tabs, with no
 * role/aria-selected/roving-tabindex/arrow-key nav — unlike sibling
 * AgentAdminTabs which does the full tablist. The fix adds role="tablist" +
 * role="tab" + aria-selected + roving tabindex + Up/Down/Home/End navigation,
 * and marks the content panel role="tabpanel".
 */
import { createUIRegistry } from '@happyvertical/smrt-agents/ui';
import { render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import AgentSettingsShell from '../AgentSettingsShell.svelte';

/**
 * Roving focus moves via requestAnimationFrame, so wait for the expected tab to
 * actually receive focus before dispatching the next key (otherwise the next
 * keydown fires on the previously-focused tab).
 */
async function expectFocused(el: HTMLElement) {
  await waitFor(() => expect(el).toHaveFocus());
}

function agents() {
  return [
    { id: 'a1', agentClass: 'Praeco', name: 'Alpha', slots: {} },
    { id: 'a2', agentClass: 'Caelus', name: 'Beta', slots: {} },
    { id: 'a3', agentClass: 'Nimbus', name: 'Gamma', slots: {} },
  ];
}

function renderShell() {
  return render(AgentSettingsShell, {
    props: {
      registry: createUIRegistry(),
      agents: agents(),
      configs: {},
    },
  });
}

/**
 * The shell embeds AgentAdminTabs (its own slot tablist), so scope queries to
 * the agent-switcher tablist — identified by its "Agents" accessible name.
 */
function switcher() {
  return screen.getByRole('tablist', { name: 'Agents' });
}
function switcherTabs() {
  return within(switcher()).getAllByRole('tab');
}

describe('AgentSettingsShell — agent switcher tablist (C8)', () => {
  it('renders a tablist of tabs with the first selected', () => {
    renderShell();
    expect(switcher()).toBeInTheDocument();
    const tabs = switcherTabs();
    expect(tabs).toHaveLength(3);
    expect(tabs[0]).toHaveAttribute('aria-selected', 'true');
    expect(tabs[1]).toHaveAttribute('aria-selected', 'false');
  });

  it('uses a roving tabindex (only the selected tab is tabbable)', () => {
    renderShell();
    const tabs = switcherTabs();
    expect(tabs[0]).toHaveAttribute('tabindex', '0');
    expect(tabs[1]).toHaveAttribute('tabindex', '-1');
    expect(tabs[2]).toHaveAttribute('tabindex', '-1');
  });

  it('moves selection with ArrowDown / ArrowUp', async () => {
    renderShell();
    switcherTabs()[0].focus();

    await userEvent.keyboard('{ArrowDown}');
    expect(switcherTabs()[1]).toHaveAttribute('aria-selected', 'true');
    await expectFocused(switcherTabs()[1]);

    await userEvent.keyboard('{ArrowUp}');
    expect(switcherTabs()[0]).toHaveAttribute('aria-selected', 'true');
    await expectFocused(switcherTabs()[0]);
  });

  it('jumps to last/first with End / Home', async () => {
    renderShell();
    switcherTabs()[0].focus();

    await userEvent.keyboard('{End}');
    expect(switcherTabs()[2]).toHaveAttribute('aria-selected', 'true');
    await expectFocused(switcherTabs()[2]);

    await userEvent.keyboard('{Home}');
    expect(switcherTabs()[0]).toHaveAttribute('aria-selected', 'true');
    await expectFocused(switcherTabs()[0]);
  });

  it('exposes a tabpanel wired to the selected tab', () => {
    renderShell();
    const panel = screen.getByRole('tabpanel');
    const selectedTab = switcherTabs().find(
      (t) => t.getAttribute('aria-selected') === 'true',
    );
    expect(selectedTab).toBeTruthy();
    expect(panel).toHaveAttribute('aria-labelledby', selectedTab?.id);
    expect(selectedTab).toHaveAttribute('aria-controls', panel.id);
  });
});
