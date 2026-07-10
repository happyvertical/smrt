<script lang="ts">
import { Select } from '@happyvertical/smrt-ui/forms';
import {
  ColorSchemeToggle,
  ThemeProvider,
} from '@happyvertical/smrt-ui/themes';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount } from 'svelte';
import ChatLayout from '../svelte/components/layout/ChatLayout.svelte';
import RoomHeader from '../svelte/components/layout/RoomHeader.svelte';
import MessageInput from '../svelte/components/messages/MessageInput.svelte';
import MessageList from '../svelte/components/messages/MessageList.svelte';
import type { ChatMessageData, ChatRoomData } from '../svelte/types.js';

type DevChatMode = 'ai' | 'local';
type WorkbenchMode = 'text' | 'voice';

interface DevChatResponse {
  mode: DevChatMode;
  provider?: string;
  model?: string;
  content: string;
  configured: boolean;
  warning?: string;
}

interface DevVoiceConfig {
  configured: boolean;
  httpUrl: string;
  wsUrl: string;
  token?: string;
  tokenConfigured: boolean;
  tokenExposed: boolean;
  defaultTarget: string;
  sampleRate: number;
  targets: Record<string, Record<string, unknown>>;
  warning?: string;
}

interface VoiceControlFrame {
  type?: string;
  session_id?: string;
  target?: string;
  text?: string;
  turn_id?: string;
  content_type?: string;
  bytes?: number;
  reason?: string;
  error?: string;
}

const currentProfileId = 'profile-dev-user';
const assistantProfileId = 'agent-dev-assistant';
const VOICE_CAPTURE_WORKLET_NAME = 'smrt-voice-capture';
const VOICE_CAPTURE_WORKLET_SOURCE = `
class SmrtVoiceCaptureProcessor extends AudioWorkletProcessor {
  process(inputs, outputs) {
    const output = outputs[0] && outputs[0][0];
    if (output) output.fill(0);

    const input = inputs[0] && inputs[0][0];
    if (input) {
      const copy = new Float32Array(input.length);
      copy.set(input);
      this.port.postMessage(copy, [copy.buffer]);
    }

    return true;
  }
}

registerProcessor('${VOICE_CAPTURE_WORKLET_NAME}', SmrtVoiceCaptureProcessor);
`;

const seedRooms: ChatRoomData[] = [
  {
    id: 'room-agent-lab',
    name: 'Agent Lab',
    description: 'Local agent chat workbench',
    roomType: 'agent',
    topic: 'Credential-backed chat when AI environment variables are present',
    participantCount: 2,
    unreadCount: 0,
    isPinned: true,
  },
  {
    id: 'room-product',
    name: 'Product',
    description: 'Package conversation fixture',
    roomType: 'public',
    topic: 'Chat package behavior and UI states',
    participantCount: 5,
    unreadCount: 0,
  },
  {
    id: 'room-direct',
    name: 'Taylor Rowan',
    description: 'Direct message fixture',
    roomType: 'dm',
    topic: '',
    participantCount: 2,
    unreadCount: 0,
  },
];

const seedMessages: Record<string, ChatMessageData[]> = {
  'room-agent-lab': [
    {
      id: 'seed-agent-1',
      roomId: 'room-agent-lab',
      senderProfileId: assistantProfileId,
      senderName: 'Dev Assistant',
      content:
        'The chat workbench is online. Send a message to exercise the package components and local dev endpoint.',
      messageType: 'text',
      role: 'assistant',
      isEdited: false,
      isDeleted: false,
      reactions: [],
      attachments: [],
      createdAt: new Date(Date.now() - 1000 * 60 * 8).toISOString(),
    },
  ],
  'room-product': [
    {
      id: 'seed-product-1',
      roomId: 'room-product',
      senderProfileId: 'profile-taylor',
      senderName: 'Taylor Rowan',
      content:
        'The route should make the message list, room list, and composer easy to test together.',
      messageType: 'text',
      role: 'user',
      isEdited: false,
      isDeleted: false,
      reactions: [{ emoji: 'ok', count: 1, reacted: false, profileIds: [] }],
      attachments: [],
      createdAt: new Date(Date.now() - 1000 * 60 * 15).toISOString(),
    },
  ],
  'room-direct': [
    {
      id: 'seed-direct-1',
      roomId: 'room-direct',
      senderProfileId: 'profile-taylor',
      senderName: 'Taylor Rowan',
      content: 'Can you sanity-check the compact chat state on mobile too?',
      messageType: 'text',
      role: 'user',
      isEdited: false,
      isDeleted: false,
      reactions: [],
      attachments: [],
      createdAt: new Date(Date.now() - 1000 * 60 * 35).toISOString(),
    },
  ],
};

let currentRoomId = $state('room-agent-lab');
let messagesByRoom = $state<Record<string, ChatMessageData[]>>({
  ...seedMessages,
});
let pendingRoomId = $state<string | null>(null);
let statusText = $state('Local endpoint ready');
let backendMode = $state<DevChatMode>('local');
let backendDetail = $state('No AI response yet');
let warning = $state<string | null>(null);
let workbenchMode = $state<WorkbenchMode>('text');
let voiceConfig = $state<DevVoiceConfig | null>(null);
let voiceConfigLoaded = $state(false);
let voiceTarget = $state('echo');
let voiceSessionId = $state<string | null>(null);
let voiceConnected = $state(false);
let voiceStatus = $state('Voice gateway not loaded');
let voiceTurnState = $state('Idle');
let voiceTranscript = $state('No voice transcript yet');
let voiceWarning = $state<string | null>(null);

let voiceSocket: WebSocket | null = null;
let voiceStream: MediaStream | null = null;
let voiceAudioContext: AudioContext | null = null;
let voiceSource: MediaStreamAudioSourceNode | null = null;
let voiceProcessor: AudioWorkletNode | null = null;
let activeVoiceAudio: HTMLAudioElement | null = null;
let activeVoiceAudioUrl: string | null = null;

const messages = $derived(messagesByRoom[currentRoomId] ?? []);
const pending = $derived(pendingRoomId === currentRoomId);
const voiceTargetNames = $derived(Object.keys(voiceConfig?.targets ?? {}));
const rooms = $derived(
  seedRooms.map((room) => {
    const roomMessages = messagesByRoom[room.id] ?? [];
    const lastMessage = roomMessages.at(-1);

    return {
      ...room,
      lastMessage,
      lastMessageAt: lastMessage?.createdAt ?? room.lastMessageAt ?? null,
      unreadCount: room.id === currentRoomId ? 0 : room.unreadCount,
    };
  }),
);
const currentRoom = $derived(
  rooms.find((room) => room.id === currentRoomId) ?? rooms[0],
);
const totalMessages = $derived(
  Object.values(messagesByRoom).reduce(
    (total, roomMessages) => total + roomMessages.length,
    0,
  ),
);

function createMessageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function appendMessage(roomId: string, message: ChatMessageData) {
  messagesByRoom = {
    ...messagesByRoom,
    [roomId]: [...(messagesByRoom[roomId] ?? []), message],
  };
}

function createUserMessage(roomId: string, content: string): ChatMessageData {
  return {
    id: createMessageId('user'),
    roomId,
    senderProfileId: currentProfileId,
    senderName: 'You',
    content,
    messageType: 'text',
    role: 'user',
    isEdited: false,
    isDeleted: false,
    reactions: [],
    attachments: [],
    createdAt: new Date().toISOString(),
  };
}

function chatHistoryFor(roomId: string, nextMessage: ChatMessageData) {
  return [...(messagesByRoom[roomId] ?? []), nextMessage].map((message) => ({
    role: message.role,
    content: message.content,
  }));
}

function appendAssistantMessage(
  roomId: string,
  content: string,
  role: ChatMessageData['role'] = 'assistant',
) {
  appendMessage(roomId, {
    id: createMessageId(role === 'system' ? 'system' : 'assistant'),
    roomId,
    senderProfileId: role === 'system' ? 'system' : assistantProfileId,
    senderName: role === 'system' ? 'System' : 'Dev Assistant',
    content,
    messageType: role === 'system' ? 'system' : 'text',
    role,
    isEdited: false,
    isDeleted: false,
    reactions: [],
    attachments: [],
    createdAt: new Date().toISOString(),
  });
}

async function requestAssistantReply(
  roomId: string,
  userMessage: ChatMessageData,
) {
  pendingRoomId = roomId;
  statusText = 'Assistant replying';
  warning = null;

  try {
    const response = await fetch('/api/dev-chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        messages: chatHistoryFor(roomId, userMessage),
      }),
    });
    const result = (await response.json()) as DevChatResponse;

    if (!response.ok) {
      throw new Error(result.content || 'Dev chat request failed.');
    }

    backendMode = result.mode;
    backendDetail =
      result.mode === 'ai'
        ? [result.provider, result.model].filter(Boolean).join(' / ') ||
          'AI provider'
        : result.configured
          ? 'AI configured, fallback response'
          : 'Local fallback';
    statusText =
      result.mode === 'ai' ? 'AI response received' : 'Local response received';
    warning = result.warning ?? null;
    appendAssistantMessage(roomId, result.content);
  } catch (error) {
    statusText = 'Request failed';
    backendMode = 'local';
    backendDetail = 'Error state';
    warning =
      error instanceof Error ? error.message : 'Dev chat request failed.';
    appendAssistantMessage(
      roomId,
      error instanceof Error ? error.message : 'Dev chat request failed.',
      'system',
    );
  } finally {
    pendingRoomId = null;
  }
}

function sendMessage(content: string) {
  const roomId = currentRoomId;
  const room = currentRoom;
  const userMessage = createUserMessage(roomId, content);

  appendMessage(roomId, userMessage);

  if (room.roomType === 'agent') {
    void requestAssistantReply(roomId, userMessage);
    return;
  }

  statusText = 'Message appended';
  backendDetail = 'No assistant in this room';
}

function handleComposerSend(content: string) {
  if (workbenchMode === 'voice') {
    sendVoiceTextTurn(content);
    return;
  }

  sendMessage(content);
}

function resetConversation() {
  void stopVoiceConversation();
  messagesByRoom = { ...seedMessages };
  currentRoomId = 'room-agent-lab';
  pendingRoomId = null;
  statusText = 'Local endpoint ready';
  backendMode = 'local';
  backendDetail = 'No AI response yet';
  warning = null;
  voiceTurnState = 'Idle';
  voiceTranscript = 'No voice transcript yet';
  voiceWarning = null;
}

function setWorkbenchMode(mode: WorkbenchMode) {
  workbenchMode = mode;
  if (mode === 'voice' && !voiceConfigLoaded) {
    void loadVoiceConfig();
  }
  if (mode === 'text') {
    void stopVoiceConversation();
  }
}

async function loadVoiceConfig() {
  voiceConfigLoaded = false;
  voiceStatus = 'Loading voice gateway';
  voiceWarning = null;

  try {
    const response = await fetch('/api/dev-voice/config');
    const config = (await response.json()) as DevVoiceConfig;
    voiceConfig = config;
    voiceConfigLoaded = true;
    voiceWarning = config.warning ?? null;

    const targetNames = Object.keys(config.targets ?? {});
    if (!targetNames.includes(voiceTarget)) {
      voiceTarget = targetNames.includes(config.defaultTarget)
        ? config.defaultTarget
        : targetNames[0] || config.defaultTarget || 'echo';
    }

    if (!config.configured) {
      voiceStatus = 'Voice gateway not configured';
    } else if (config.tokenConfigured && !config.tokenExposed) {
      voiceStatus = 'Voice token is server-side only';
    } else {
      voiceStatus = 'Voice gateway ready';
    }
  } catch (error) {
    voiceConfigLoaded = true;
    voiceStatus = 'Voice config failed';
    voiceWarning =
      error instanceof Error ? error.message : 'Voice config request failed.';
  }
}

function voiceSocketUrl(config: DevVoiceConfig): string {
  const url = new URL(config.wsUrl);
  if (config.token) {
    url.searchParams.set('token', config.token);
  }
  return url.toString();
}

function downsampleToPcm16(
  input: Float32Array,
  inputSampleRate: number,
  outputSampleRate: number,
): ArrayBuffer {
  const ratio = inputSampleRate / outputSampleRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(length);

  for (let outputIndex = 0; outputIndex < length; outputIndex += 1) {
    const start = Math.floor(outputIndex * ratio);
    const end = Math.min(input.length, Math.floor((outputIndex + 1) * ratio));
    let total = 0;
    let count = 0;

    for (let inputIndex = start; inputIndex < end; inputIndex += 1) {
      total += input[inputIndex] ?? 0;
      count += 1;
    }

    const sample = Math.max(-1, Math.min(1, count ? total / count : 0));
    output[outputIndex] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return output.buffer;
}

async function createVoiceCaptureProcessor(
  audioContext: AudioContext,
  config: DevVoiceConfig,
  socket: WebSocket,
): Promise<AudioWorkletNode> {
  if (!audioContext.audioWorklet) {
    throw new Error('This browser does not support AudioWorklet capture.');
  }

  const workletUrl = URL.createObjectURL(
    new Blob([VOICE_CAPTURE_WORKLET_SOURCE], { type: 'text/javascript' }),
  );
  try {
    await audioContext.audioWorklet.addModule(workletUrl);
  } finally {
    URL.revokeObjectURL(workletUrl);
  }

  const processor = new AudioWorkletNode(
    audioContext,
    VOICE_CAPTURE_WORKLET_NAME,
    {
      channelCount: 1,
      channelCountMode: 'explicit',
      numberOfInputs: 1,
      numberOfOutputs: 1,
    },
  );

  processor.port.onmessage = (event: MessageEvent<Float32Array>) => {
    if (socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const pcm = downsampleToPcm16(
      event.data,
      audioContext.sampleRate,
      config.sampleRate,
    );
    socket.send(pcm);
  };

  return processor;
}

function stopActiveVoiceAudio() {
  if (activeVoiceAudio) {
    activeVoiceAudio.pause();
    activeVoiceAudio.src = '';
    activeVoiceAudio = null;
  }
  if (activeVoiceAudioUrl) {
    URL.revokeObjectURL(activeVoiceAudioUrl);
    activeVoiceAudioUrl = null;
  }
}

async function playVoiceAudio(data: ArrayBuffer | Blob) {
  stopActiveVoiceAudio();
  const blob =
    data instanceof Blob ? data : new Blob([data], { type: 'audio/wav' });
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);

  activeVoiceAudio = audio;
  activeVoiceAudioUrl = url;
  audio.onended = stopActiveVoiceAudio;
  audio.onerror = () => {
    voiceWarning = 'Voice audio playback failed.';
    stopActiveVoiceAudio();
  };

  try {
    await audio.play();
  } catch (error) {
    voiceWarning =
      error instanceof Error ? error.message : 'Voice audio playback failed.';
  }
}

function handleVoiceControlFrame(frame: VoiceControlFrame) {
  switch (frame.type) {
    case 'ready':
      voiceSessionId = frame.session_id ?? voiceSessionId;
      voiceStatus = 'Voice socket ready';
      break;
    case 'started':
      voiceConnected = true;
      voiceSessionId = frame.session_id ?? voiceSessionId;
      voiceTarget = frame.target ?? voiceTarget;
      voiceStatus = 'Listening';
      voiceTurnState = 'Listening';
      break;
    case 'transcribing':
      voiceStatus = 'Transcribing';
      voiceTurnState = frame.reason
        ? `Transcribing (${frame.reason})`
        : 'Transcribing';
      break;
    case 'transcript':
      if (frame.text) {
        voiceTranscript = frame.text;
        appendMessage(
          currentRoomId,
          createUserMessage(currentRoomId, frame.text),
        );
      }
      voiceStatus = 'Transcript received';
      voiceTurnState = 'Waiting for response';
      break;
    case 'response_text':
      if (frame.text) {
        appendAssistantMessage(currentRoomId, frame.text);
      }
      backendMode = 'ai';
      backendDetail = `Voice gateway / ${voiceTarget}`;
      statusText = 'Voice response received';
      voiceStatus = 'Response received';
      voiceTurnState = 'Synthesizing audio';
      break;
    case 'audio':
      voiceStatus = 'Playing voice response';
      voiceTurnState =
        typeof frame.bytes === 'number'
          ? `Playing ${Math.round(frame.bytes / 1024)} KB audio`
          : 'Playing audio';
      break;
    case 'done':
      voiceStatus = 'Listening';
      voiceTurnState = 'Listening';
      break;
    case 'clear_buffer':
      stopActiveVoiceAudio();
      voiceStatus = 'Barge-in detected';
      voiceTurnState = 'Listening';
      break;
    case 'error':
      voiceWarning = frame.error ?? 'Voice gateway error.';
      voiceStatus = 'Voice error';
      voiceTurnState = 'Error';
      break;
    default:
      break;
  }
}

function handleVoiceSocketMessage(
  event: MessageEvent<string | ArrayBuffer | Blob>,
) {
  if (typeof event.data === 'string') {
    try {
      handleVoiceControlFrame(JSON.parse(event.data) as VoiceControlFrame);
    } catch {
      voiceWarning = 'Voice gateway sent invalid JSON.';
    }
    return;
  }

  void playVoiceAudio(event.data);
}

function cleanupVoiceCapture() {
  voiceProcessor?.port.close();
  voiceProcessor?.disconnect();
  voiceProcessor = null;
  voiceSource?.disconnect();
  voiceSource = null;
  voiceStream?.getTracks().forEach((track) => {
    track.stop();
  });
  voiceStream = null;

  if (voiceAudioContext && voiceAudioContext.state !== 'closed') {
    void voiceAudioContext.close();
  }
  voiceAudioContext = null;
}

async function startVoiceConversation() {
  if (voiceConnected) return;
  if (!voiceConfigLoaded) {
    await loadVoiceConfig();
  }

  const config = voiceConfig;
  if (!config?.configured) {
    voiceWarning = 'Voice gateway is not configured.';
    voiceStatus = 'Voice gateway not configured';
    return;
  }
  if (config.tokenConfigured && !config.tokenExposed) {
    voiceWarning =
      'Voice gateway token is not exposed to the local browser dev route.';
    voiceStatus = 'Voice token unavailable';
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    voiceWarning = 'This browser does not support microphone capture.';
    voiceStatus = 'Microphone unavailable';
    return;
  }

  voiceWarning = null;
  voiceStatus = 'Opening microphone';

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
      },
    });
    const audioContext = new AudioContext();
    await audioContext.resume();
    const source = audioContext.createMediaStreamSource(stream);
    const socket = new WebSocket(voiceSocketUrl(config));

    voiceStream = stream;
    voiceAudioContext = audioContext;
    voiceSource = source;
    voiceSocket = socket;
    socket.binaryType = 'arraybuffer';

    const processor = await createVoiceCaptureProcessor(
      audioContext,
      config,
      socket,
    );
    voiceProcessor = processor;

    source.connect(processor);
    processor.connect(audioContext.destination);

    socket.onmessage = handleVoiceSocketMessage;
    socket.onclose = () => {
      voiceConnected = false;
      voiceStatus = 'Voice disconnected';
      voiceTurnState = 'Idle';
      cleanupVoiceCapture();
    };
    socket.onerror = () => {
      voiceWarning = 'Voice socket connection failed.';
      voiceStatus = 'Voice socket failed';
    };
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'start',
          target: voiceTarget,
          session_id: voiceSessionId ?? undefined,
          actor: 'chat-dev',
          audio: { sample_rate: config.sampleRate, encoding: 'pcm_s16le' },
        }),
      );
      voiceConnected = true;
      voiceStatus = 'Starting voice session';
      voiceTurnState = 'Listening';
    };
  } catch (error) {
    cleanupVoiceCapture();
    voiceSocket?.close();
    voiceSocket = null;
    voiceConnected = false;
    voiceStatus = 'Voice start failed';
    voiceWarning =
      error instanceof Error ? error.message : 'Voice conversation failed.';
  }
}

async function stopVoiceConversation() {
  stopActiveVoiceAudio();
  if (voiceSocket?.readyState === WebSocket.OPEN) {
    voiceSocket.send(JSON.stringify({ type: 'stop' }));
  }
  voiceSocket?.close();
  voiceSocket = null;
  cleanupVoiceCapture();
  voiceConnected = false;
  voiceStatus = voiceConfigLoaded
    ? 'Voice stopped'
    : 'Voice gateway not loaded';
  voiceTurnState = 'Idle';
}

function sendVoiceTextTurn(content: string) {
  if (!voiceSocket || voiceSocket.readyState !== WebSocket.OPEN) {
    voiceWarning = 'Start voice conversation before sending a voice turn.';
    voiceStatus = 'Voice is not connected';
    return;
  }

  appendMessage(currentRoomId, createUserMessage(currentRoomId, content));
  voiceSocket.send(JSON.stringify({ type: 'text_turn', text: content }));
  voiceTranscript = content;
  voiceStatus = 'Voice text turn sent';
  voiceTurnState = 'Waiting for response';
}

onMount(() => {
  void loadVoiceConfig();
  return () => {
    void stopVoiceConversation();
  };
});
</script>

<svelte:head>
  <title>Chat Dev</title>
</svelte:head>

<ThemeProvider colorScheme="system" persist={true}>
  <div class="chat-dev">
    <header class="topbar">
      <div class="title-block">
        <p class="eyebrow">@happyvertical/smrt-chat</p>
        <h1>Chat Dev</h1>
      </div>

      <nav class="topbar__actions" aria-label="Chat dev navigation">
        <div class="mode-toggle" role="group" aria-label="Input mode">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            class={workbenchMode === 'text' ? 'mode-button active' : 'mode-button'}
            aria-pressed={workbenchMode === 'text'}
            onclick={() => setWorkbenchMode('text')}
          >
            Text
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            class={workbenchMode === 'voice' ? 'mode-button active' : 'mode-button'}
            aria-pressed={workbenchMode === 'voice'}
            onclick={() => setWorkbenchMode('voice')}
          >
            Voice
          </Button>
        </div>
        <a class="preview-link" href="/previews">Previews</a>
        <Button variant="ghost" size="sm" type="button" onclick={resetConversation}>
          Reset
        </Button>
        <ColorSchemeToggle />
      </nav>
    </header>

    <main class="workspace">
      <section class="chat-frame" aria-label="Chat workbench">
        <ChatLayout
          {rooms}
          {currentRoomId}
          {currentProfileId}
          onselectroom={(roomId) => (currentRoomId = roomId)}
        >
          <RoomHeader room={currentRoom} participantCount={currentRoom.participantCount} />
          <div class="transcript">
            <MessageList
              {messages}
              {currentProfileId}
              onreply={() => undefined}
              onreact={() => undefined}
            />
            {#if pending}
              <div class="typing-row" role="status">Assistant is replying...</div>
            {/if}
            {#if workbenchMode === 'voice' && voiceConnected}
              <div class="typing-row" role="status">{voiceTurnState}</div>
            {/if}
          </div>
          <MessageInput
            onsend={handleComposerSend}
            disabled={Boolean(pendingRoomId) || (workbenchMode === 'voice' && !voiceConnected)}
            placeholder={workbenchMode === 'voice' ? 'Send a typed voice turn' : currentRoom.roomType === 'agent' ? 'Message the dev assistant' : 'Message this room'}
          />
        </ChatLayout>
      </section>

      <aside class="status-panel" aria-label="Dev chat status">
        <div class="status-row">
          <span class="status-label">Input</span>
          <strong>{workbenchMode === 'voice' ? 'Voice conversation' : 'Text chat'}</strong>
        </div>
        <div class="status-row">
          <span class="status-label">Mode</span>
          <strong>{backendMode === 'ai' ? 'AI' : 'Local'}</strong>
        </div>
        <div class="status-row">
          <span class="status-label">Backend</span>
          <strong>{backendDetail}</strong>
        </div>
        <div class="status-row">
          <span class="status-label">Status</span>
          <strong>{statusText}</strong>
        </div>
        <div class="status-row">
          <span class="status-label">Messages</span>
          <strong>{totalMessages}</strong>
        </div>

        {#if workbenchMode === 'voice'}
          <section class="voice-panel" aria-label="Voice conversation controls">
            <label class="voice-field">
              <span class="status-label">Voice target</span>
              <Select bind:value={voiceTarget} disabled={voiceConnected} class="voice-select">
                {#each voiceTargetNames as target (target)}
                  <option value={target}>{target}</option>
                {/each}
              </Select>
            </label>

            <div class="voice-actions">
              {#if voiceConnected}
                <Button variant="danger" size="sm" type="button" class="voice-button" onclick={stopVoiceConversation}>
                  Stop
                </Button>
              {:else}
                <Button variant="primary" size="sm" type="button" class="voice-button" onclick={startVoiceConversation}>
                  Start
                </Button>
              {/if}
              <Button variant="secondary" size="sm" type="button" class="voice-button" onclick={loadVoiceConfig} disabled={voiceConnected}>
                Reload
              </Button>
            </div>

            <div class="voice-readout">
              <span class:active={voiceConnected} aria-hidden="true"></span>
              <strong>{voiceStatus}</strong>
            </div>

            <div class="voice-meta">
              <span class="status-label">Session</span>
              <strong>{voiceSessionId ?? 'Not started'}</strong>
            </div>
            <div class="voice-meta">
              <span class="status-label">Transcript</span>
              <strong>{voiceTranscript}</strong>
            </div>

            {#if voiceWarning}
              <p class="warning">{voiceWarning}</p>
            {/if}
          </section>
        {/if}

        {#if warning}
          <p class="warning">{warning}</p>
        {/if}
      </aside>
    </main>
  </div>
</ThemeProvider>

<style>
  :global(body) {
    margin: 0;
    min-height: 100vh;
  }

  :global(a) {
    color: inherit;
  }

  .chat-dev {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr);
    min-height: 100vh;
    background: var(--smrt-color-background);
    color: var(--smrt-color-on-background);
    font-family: var(--smrt-font-family);
  }

  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.8rem 1rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }

  .title-block {
    min-width: 0;
  }

  .eyebrow {
    margin: 0 0 0.15rem;
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }

  h1 {
    margin: 0;
    font-size: var(--smrt-typography-title-medium-size, 1rem);
    line-height: var(--smrt-typography-title-medium-line-height, 1.5);
    letter-spacing: 0;
  }

  .topbar__actions {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
    justify-content: flex-end;
  }

  .mode-toggle {
    display: inline-flex;
    padding: 0.16rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-surface-container-high);
  }

  .mode-toggle :global(.mode-button) {
    min-height: 2rem;
    padding: 0 0.68rem;
    border: 0;
    border-radius: var(--smrt-radius-sm, 4px);
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }

  .mode-toggle :global(.mode-button.active) {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }

  .preview-link {
    display: inline-flex;
    align-items: center;
    min-height: 2rem;
    padding: 0 0.7rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-surface-container-lowest);
    color: var(--smrt-color-on-surface);
    text-decoration: none;
    font-size: var(--smrt-typography-label-large-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .preview-link:hover {
    background: var(--smrt-color-surface-container-low);
  }

  .workspace {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 17rem;
    gap: 1rem;
    min-height: 0;
    padding: 1rem;
  }

  .chat-frame {
    min-width: 0;
    min-height: 32rem;
    height: calc(100vh - 5.1rem);
    overflow: hidden;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-surface);
  }

  .transcript {
    display: flex;
    flex: 1;
    min-height: 0;
    flex-direction: column;
    background: var(--smrt-color-surface-container-low);
  }

  .typing-row {
    margin: 0 1rem 0.75rem;
    padding: 0.55rem 0.7rem;
    align-self: flex-start;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
  }

  .status-panel {
    display: grid;
    align-content: start;
    gap: 0.75rem;
    height: max-content;
    padding: 0.9rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
  }

  .status-row {
    display: grid;
    gap: 0.2rem;
    padding-bottom: 0.65rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .status-row:last-of-type {
    padding-bottom: 0;
    border-bottom: 0;
  }

  .status-label {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .status-panel strong {
    min-width: 0;
    overflow-wrap: anywhere;
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }

  .voice-panel {
    display: grid;
    gap: 0.75rem;
    padding-top: 0.15rem;
  }

  .voice-field {
    display: grid;
    gap: 0.35rem;
  }

  .voice-field :global(.voice-select) {
    min-height: 2.2rem;
    background-color: var(--smrt-color-surface-container-lowest);
  }

  .voice-actions {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.55rem;
  }

  .voice-actions :global(.voice-button) {
    width: 100%;
    min-height: 2rem;
  }

  .voice-readout {
    display: flex;
    align-items: center;
    gap: 0.45rem;
  }

  .voice-readout span {
    width: 0.6rem;
    height: 0.6rem;
    flex: 0 0 auto;
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-outline);
  }

  .voice-readout span.active {
    background: var(--smrt-color-success);
  }

  .voice-meta {
    display: grid;
    gap: 0.2rem;
  }

  .warning {
    margin: 0;
    padding: 0.7rem;
    border: 1px solid var(--smrt-color-warning);
    border-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-warning-container);
    color: var(--smrt-color-on-warning-container);
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    line-height: 1.45;
  }

  @media (max-width: 820px) {
    .workspace {
      grid-template-columns: 1fr;
    }

    .chat-frame {
      height: 36rem;
    }
  }

  @media (max-width: 600px) {
    .topbar {
      align-items: flex-start;
    }

    .topbar__actions {
      max-width: 12rem;
    }

    .workspace {
      padding: 0.75rem;
    }

    .chat-frame {
      height: 34rem;
      min-height: 28rem;
    }
  }
</style>
