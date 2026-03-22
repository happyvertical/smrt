import { CHAT_MODULE_META } from '../ui.js';

const noop = () => {};

const sampleRooms = [
  {
    id: 'room-editorial',
    name: 'Editorial Ops',
    description: 'Daily coordination room',
    roomType: 'public',
    topic: 'Launch readiness and governance',
    participantCount: 8,
    unreadCount: 4,
    lastMessageAt: '2026-03-21T16:08:00.000Z',
    lastMessage: {
      id: 'room-editorial-last',
      roomId: 'room-editorial',
      senderProfileId: 'profile-taylor',
      senderName: 'Taylor Rowan',
      content: 'Content QA is clear for tonight’s rollout.',
      messageType: 'text',
      role: 'user',
      isEdited: false,
      isDeleted: false,
      reactions: [],
      attachments: [],
      createdAt: '2026-03-21T16:08:00.000Z',
    },
  },
  {
    id: 'room-governance',
    name: 'Governance',
    description: 'Policy review',
    roomType: 'agent',
    topic: 'Publication profile monitoring',
    participantCount: 3,
    unreadCount: 1,
    isPinned: true,
    lastMessageAt: '2026-03-21T15:55:00.000Z',
  },
  {
    id: 'room-jordan',
    name: 'Jordan Lee',
    description: 'Direct message',
    roomType: 'dm',
    topic: '',
    participantCount: 2,
    unreadCount: 0,
    lastMessageAt: '2026-03-21T14:12:00.000Z',
  },
];

const sampleMessages = [
  {
    id: 'chat-message-1',
    roomId: 'room-editorial',
    senderProfileId: 'profile-taylor',
    senderName: 'Taylor Rowan',
    content:
      'The root playground is showing the content previews correctly now.',
    messageType: 'text',
    role: 'user',
    isEdited: false,
    isDeleted: false,
    replyTo: null,
    reactions: [
      {
        emoji: '✅',
        count: 2,
        reacted: true,
        profileIds: ['profile-taylor', 'profile-jordan'],
      },
    ],
    attachments: [],
    createdAt: '2026-03-21T15:52:00.000Z',
  },
  {
    id: 'chat-message-2',
    roomId: 'room-editorial',
    senderProfileId: 'profile-jordan',
    senderName: 'Jordan Lee',
    content:
      'Next up is broadening the package rollout from the content reference implementation.',
    messageType: 'text',
    role: 'user',
    isEdited: false,
    isDeleted: false,
    replyTo: {
      id: 'chat-message-1',
      senderName: 'Taylor Rowan',
      content:
        'The root playground is showing the content previews correctly now.',
    },
    reactions: [],
    attachments: [],
    createdAt: '2026-03-21T15:58:00.000Z',
  },
];

const loadMessageInput = () =>
  import('./components/messages/MessageInput.svelte');
const loadMessageList = () =>
  import('./components/messages/MessageList.svelte');
const loadRoomList = () => import('./components/layout/RoomList.svelte');

export default {
  packageName: '@happyvertical/smrt-chat',
  displayName: CHAT_MODULE_META.displayName,
  description: CHAT_MODULE_META.description,
  moduleMeta: CHAT_MODULE_META,
  entries: [
    {
      id: 'room-list',
      title: 'Room List',
      description:
        'Sidebar navigation for rooms, DMs, and agent conversations with unread state.',
      loadComponent: loadRoomList,
      order: 1,
      props: {
        rooms: sampleRooms,
        currentRoomId: 'room-editorial',
        onselectroom: noop,
        oncreateroom: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'message-list',
      title: 'Message List',
      description:
        'Grouped chat transcript with replies and reactions for a conversation thread.',
      loadComponent: loadMessageList,
      order: 2,
      props: {
        messages: sampleMessages,
        currentProfileId: 'profile-taylor',
        onreply: noop,
        onreact: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
    {
      id: 'message-input',
      title: 'Message Input',
      description:
        'Chat composer with reply context and keyboard send affordance.',
      loadComponent: loadMessageInput,
      order: 3,
      props: {
        onsend: noop,
        placeholder: 'Reply to the rollout thread…',
        replyTo: {
          id: 'chat-message-1',
          senderName: 'Taylor Rowan',
          content:
            'The root playground is showing the content previews correctly now.',
        },
        oncancelreply: noop,
      },
      modes: {
        mock: {
          label: 'Mock',
        },
      },
    },
  ],
};
