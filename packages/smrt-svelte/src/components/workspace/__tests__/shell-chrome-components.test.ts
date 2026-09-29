/** ShellNavToggle, ShellTitle, PhoneTopBar and PhoneBottomBar. */
import { fireEvent, render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import PhoneBottomBar from '../admin-shell/PhoneBottomBar.svelte';
import PhoneTopBar from '../admin-shell/PhoneTopBar.svelte';
import ShellNavToggle from '../admin-shell/ShellNavToggle.svelte';
import TestIcon from './test-icon.svelte';

describe('ShellNavToggle', () => {
  it('collapses an open nav and expands a closed one', async () => {
    const onclick = vi.fn();
    const { rerender } = render(ShellNavToggle, {
      props: { expanded: true, onclick, label: 'site navigation' },
    });
    const toggle = screen.getByRole('button', {
      name: 'Collapse site navigation',
    });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute(
      'aria-controls',
      'smrt-admin-shell-left-panel',
    );
    await fireEvent.click(toggle);
    expect(onclick).toHaveBeenCalledTimes(1);
    await rerender({ expanded: false, onclick });
    expect(
      screen.getByRole('button', { name: 'Expand site navigation' }),
    ).toHaveAttribute('aria-expanded', 'false');
  });

  it('defaults its label', () => {
    render(ShellNavToggle, { props: { expanded: false, onclick: () => {} } });
    expect(
      screen.getByRole('button', { name: 'Expand navigation' }),
    ).toBeInTheDocument();
  });
});

describe('PhoneTopBar', () => {
  it('links the workspace name home on section homes', () => {
    render(PhoneTopBar, {
      props: {
        model: { kind: 'home', title: 'Alpha Times' },
        homeHref: '/sites/alpha',
      },
    });
    const link = screen.getByRole('link', { name: 'Alpha Times' });
    expect(link).toHaveAttribute('href', '/sites/alpha');
  });

  it('shows a named back link and the page title on detail pages', () => {
    render(PhoneTopBar, {
      props: {
        model: {
          kind: 'detail',
          title: 'Fair opens Friday',
          backHref: '/sites/alpha/articles',
          backLabel: 'Articles',
        },
        homeHref: '/sites/alpha',
      },
    });
    expect(
      screen.getByRole('link', { name: 'Back to Articles' }),
    ).toHaveAttribute('href', '/sites/alpha/articles');
    expect(screen.getByTestId('phone-top-bar').textContent).toContain(
      'Fair opens Friday',
    );
  });
});

describe('PhoneBottomBar', () => {
  it('renders links and buttons with states, badges and dots', async () => {
    const onMenu = vi.fn();
    render(PhoneBottomBar, {
      props: {
        items: [
          {
            id: 'menu',
            label: 'Menu',
            icon: TestIcon,
            onclick: onMenu,
            expanded: false,
            controls: 'nav',
          },
          {
            id: 'home',
            label: 'Home',
            icon: TestIcon,
            href: '/',
            active: true,
          },
          {
            id: 'notifications',
            label: 'Notifications',
            icon: TestIcon,
            onclick: () => {},
            badge: 12,
          },
          {
            id: 'assistant',
            label: 'Assistant',
            icon: TestIcon,
            onclick: () => {},
            dot: true,
            dotLabel: 'new reply',
          },
        ],
      },
    });
    expect(
      screen.getByRole('navigation', { name: 'Main' }),
    ).toBeInTheDocument();
    const menu = screen.getByRole('button', { name: 'Menu' });
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(menu).toHaveAttribute('aria-controls', 'nav');
    await fireEvent.click(menu);
    expect(onMenu).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('link', { name: 'Home' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const notifications = screen.getByRole('button', {
      name: 'Notifications, 12 unread',
    });
    expect(notifications.textContent).toContain('9+');
    expect(
      screen.getByRole('button', { name: 'Assistant, new reply' }),
    ).toBeInTheDocument();
  });
});
