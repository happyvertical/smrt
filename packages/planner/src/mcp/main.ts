import '@happyvertical/smrt-ui/styles/tokens.css';
import '@happyvertical/smrt-ui/themes/styles/all.css';
import '@happyvertical/smrt-ui/themes/styles/base.css';
import '@happyvertical/smrt-ui/themes/styles/fonts.css';
import { mount, unmount } from 'svelte';
import HostPlanner from '../lib/planner/host/HostPlanner.svelte';
import type {
  CallKitchenTool,
  HostSession,
} from '../lib/planner/host/session.svelte.ts';

declare global {
  interface Window {
    smrtKitchen: {
      callTool: CallKitchenTool;
      subscribe: (listener: (value: unknown) => void) => () => void;
    };
    smrtKitchenUnmount?: () => Promise<void>;
  }
}
let session: HostSession | undefined;
let latest: unknown;
const bridge = window.smrtKitchen;
if (!bridge) throw new Error('The Kitchen MCP Apps bridge is required.');
const unsubscribe = bridge.subscribe((value) => {
  if (
    !value ||
    typeof value !== 'object' ||
    !('state' in value) ||
    !('planId' in value)
  )
    return;
  latest = value;
  if (session) session.receive(value);
});
const target = document.getElementById('planner');
if (!target) throw new Error('The Kitchen Planner mount point is missing.');
const app = mount(HostPlanner, {
  target,
  props: {
    callTool: bridge.callTool,
    onready: (ready: HostSession) => {
      session = ready;
      if (latest) ready.receive(latest);
    },
  },
});
window.smrtKitchenUnmount = async () => {
  unsubscribe();
  await unmount(app);
  session = undefined;
};
