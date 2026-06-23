// @vitest-environment jsdom
/**
 * Component coverage for ChatLayout via the shared S11 harness (#1416).
 *
 * Regression for T2 #1391: ChatLayout rendered RoomList but never forwarded
 * `oncreateroom`, so the bundled layout's create-room affordance was dead.
 * ChatLayout must now accept and forward `oncreateroom` to RoomList.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { createRawSnippet } from 'svelte';
import { describe, expect, it, vi } from 'vitest';
import type { ChatRoomData } from '../../../types.js';
import ChatLayout from '../ChatLayout.svelte';

const ROOMS: ChatRoomData[] = [
  {
    id: 'room-1',
    name: 'General',
    description: '',
    roomType: 'public',
    topic: '',
    participantCount: 1,
    unreadCount: 0,
  },
];

// Minimal main-content snippet for the required `children` prop.
const content = createRawSnippet(() => ({
  render: () => '<div data-testid="main">Main content</div>',
}));

describe('ChatLayout', () => {
  it('forwards oncreateroom to RoomList so the create affordance is wired', async () => {
    const oncreateroom = vi.fn();
    render(ChatLayout, {
      props: {
        rooms: ROOMS,
        currentProfileId: 'p1',
        onselectroom: vi.fn(),
        oncreateroom,
        children: content,
      },
    });

    const createBtn = screen.getByRole('button', { name: 'Create new room' });
    await userEvent.click(createBtn);
    expect(oncreateroom).toHaveBeenCalledTimes(1);
  });

  it('omits the create affordance when no oncreateroom is supplied', () => {
    render(ChatLayout, {
      props: {
        rooms: ROOMS,
        currentProfileId: 'p1',
        onselectroom: vi.fn(),
        children: content,
      },
    });
    expect(
      screen.queryByRole('button', { name: 'Create new room' }),
    ).toBeNull();
  });

  it('is axe-clean', async () => {
    const { container } = render(ChatLayout, {
      props: {
        rooms: ROOMS,
        currentProfileId: 'p1',
        onselectroom: vi.fn(),
        oncreateroom: vi.fn(),
        children: content,
      },
    });
    await expectNoA11yViolations(container);
  });
});
