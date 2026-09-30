import { McpAppBridge } from "../src/index.js";

const bridge = new McpAppBridge({
  hostWindow: parent,
  hostOrigin: "http://127.0.0.1:47862",
  appInfo: { name: "Synthetic opportunity viewer", version: "1" },
  timeoutMs: 2000,
});
const heading = document.createElement("h1");
heading.textContent = "Synthetic opportunities";
const status = document.createElement("p");
status.setAttribute("role", "status");
const content = document.createElement("main");
const review = document.createElement("a");
review.textContent = "Open human review";
review.href = "https://example.com/opportunities";
review.target = "_blank";
review.rel = "noopener noreferrer";
const reviewUrl = document.createElement("code");
reviewUrl.textContent = review.href;
document.body.append(heading, status, content, review, reviewUrl);
const back = document.createElement("button");
back.textContent = "Back to opportunities";
back.addEventListener("click", () => {
  void load("opportunity_list", {});
});
let currentRequest: AbortController | undefined;
let generation = 0;
let initialRendered = false;
function opportunityId(value: unknown): value is string {
  return typeof value === "string" && /^synthetic-[12]$/.test(value);
}
function selectReview(id: string): void {
  review.href = `https://example.com/opportunities/${encodeURIComponent(id)}/review`;
  reviewUrl.textContent = review.href;
}
function render(
  result: {
    content: { type: "text"; text: string }[];
    structuredContent?: Record<string, unknown>;
  },
  selection?: string,
): void {
  const rows =
    selection === undefined
      ? result.structuredContent?.opportunities
      : undefined;
  if (selection !== undefined) {
    if (
      !opportunityId(selection) ||
      result.structuredContent?.id !== selection
    ) {
      status.textContent = "Tool unavailable. Continue in human review.";
      return;
    }
    selectReview(selection);
  }
  content.replaceChildren();
  for (const block of result.content) {
    const text = document.createElement("p");
    text.textContent = block.text;
    content.append(text);
  }
  if (!Array.isArray(rows)) {
    if (bridge.snapshot.hostCapabilities.serverTools) {
      content.append(back);
      back.focus();
    }
    return;
  }
  let selected = false;
  for (const value of rows) {
    if (
      typeof value !== "object" ||
      !value ||
      !opportunityId(value.id) ||
      typeof value.title !== "string"
    )
      continue;
    if (!selected) {
      selectReview(value.id);
      selected = true;
    }
    const button = document.createElement("button");
    button.textContent = value.title;
    button.disabled = !bridge.snapshot.hostCapabilities.serverTools;
    button.addEventListener("click", () => {
      void load("opportunity_detail", { id: value.id });
    });
    content.append(button);
  }
}
async function load(
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const revision = ++generation;
  currentRequest?.abort();
  currentRequest = new AbortController();
  try {
    const result = await bridge.callTool(name, args, currentRequest.signal);
    if (revision === generation && !bridge.signal.aborted)
      render(
        result,
        name === "opportunity_detail" && opportunityId(args.id)
          ? args.id
          : undefined,
      );
  } catch {
    if (revision === generation && !bridge.signal.aborted)
      status.textContent = "Tool unavailable. Continue in human review.";
  }
}
bridge.subscribe((snapshot) => {
  status.textContent = snapshot.state;
  if (
    snapshot.state === "ready" &&
    snapshot.toolResult &&
    !initialRendered &&
    generation <= 1
  ) {
    initialRendered = true;
    render(snapshot.toolResult);
  }
});
review.addEventListener("click", (event) => {
  if (bridge.snapshot.hostCapabilities.openLinks) {
    event.preventDefault();
    void bridge.openLink(review.href).catch(() => {
      status.textContent = "Open the review URL in your browser.";
    });
  }
});
void bridge
  .connect()
  .then(() => {
    if (bridge.snapshot.hostCapabilities.serverTools)
      void load("opportunity_list", {});
    else
      status.textContent =
        "Interactive tools unavailable. Continue in human review.";
  })
  .catch(() => {
    status.textContent = "Host unavailable. Continue in human review.";
  });
addEventListener("pagehide", () => bridge.dispose());
// Test-only controls. The generated fixture is synthetic, not a production app template.
Object.assign(window, {
  fixture: {
    bridge,
    pending: () =>
      bridge.callTool("pending").catch((error: Error) => error.message),
    blockedNetwork: async () => {
      let blocked = false;
      try {
        await fetch("https://example.invalid/private");
      } catch {
        blocked = true;
      }
      const img = document.createElement("img");
      const imageBlocked = new Promise<boolean>((resolve) => {
        img.onerror = () => resolve(true);
        img.onload = () => resolve(false);
      });
      img.src = "https://example.invalid/asset.png";
      document.body.append(img);
      return { blocked, imageBlocked: await imageBlocked };
    },
  },
});
