import { expect, test } from "@playwright/test";

test("renders list/detail, routes through the host and only opens human review", async ({
  page,
  request,
}) => {
  await page.goto("/");
  const view = page.frameLocator("iframe");
  await expect(view.getByText("Synthetic opportunity summary")).toBeVisible();
  await view.getByRole("button", { name: "Synthetic analyst role" }).click();
  await expect(
    view.getByText("Synthetic role details:", { exact: false }),
  ).toBeVisible();
  await view.getByRole("link", { name: "Open human review" }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window as any).calls.some((c: any) => c.method === "ui/open-link"),
      ),
    )
    .toBe(true);
  const calls = await page.evaluate(() => (window as any).calls);
  expect(
    calls
      .filter((c: any) => c.method === "tools/call")
      .map((c: any) => c.params.name),
  ).toEqual(["opportunity_list", "opportunity_detail"]);
  expect(calls.find((c: any) => c.method === "ui/open-link").params.url).toBe(
    "https://example.com/opportunities/synthetic-1/review",
  );
  await view.getByRole("button", { name: "Back to opportunities" }).click();
  await view.getByRole("button", { name: "Synthetic designer role" }).click();
  await expect(
    view.getByRole("link", { name: "Open human review" }),
  ).toHaveAttribute(
    "href",
    "https://example.com/opportunities/synthetic-2/review",
  );
  await expect(view.locator("code")).toHaveText(
    "https://example.com/opportunities/synthetic-2/review",
  );
  await view.getByRole("link", { name: "Open human review" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).calls
            .filter((c: any) => c.method === "ui/open-link")
            .at(-1)?.params.url,
      ),
    )
    .toBe("https://example.com/opportunities/synthetic-2/review");
  expect((await (await request.get("/metrics")).json()).bytes).toBeLessThan(
    102400,
  );
});

test("capability absence retains full text/structured fallback and review URL", async ({
  page,
}) => {
  await page.goto("/?headless");
  const view = page.frameLocator("iframe");
  await expect(view.getByText("Synthetic opportunity summary")).toBeVisible();
  await expect(
    view.getByRole("button", { name: "Synthetic analyst role" }),
  ).toBeDisabled();
  await expect(view.getByRole("link")).toHaveAttribute(
    "href",
    "https://example.com/opportunities/synthetic-1/review",
  );
  expect(
    await page.evaluate(() =>
      (window as any).calls.some((c: any) => c.method === "tools/call"),
    ),
  ).toBe(false);
});

test("rejects sibling messages, malformed host data and enforces CSP network/assets", async ({
  page,
}) => {
  await page.goto("/");
  const child = page.frames().find((frame) => frame.url().endsWith("/view"))!;
  await expect(
    page.frameLocator("iframe").getByText("Synthetic opportunity summary"),
  ).toBeVisible();
  await page.evaluate(() => {
    const sibling = document.createElement("iframe");
    document.body.append(sibling);
    sibling.contentWindow!.eval(
      `parent.view.contentWindow.postMessage({jsonrpc:'2.0',method:'ui/notifications/host-context-changed',params:{theme:'dark'}}, '*')`,
    );
    (window as any).view.contentWindow.postMessage(
      {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params: { theme: "future" },
      },
      "*",
    );
  });
  await expect
    .poll(() =>
      child.evaluate(() => (window as any).fixture.bridge.snapshot.hostContext),
    )
    .toEqual({});
  expect(
    await child.evaluate(() => (window as any).fixture.blockedNetwork()),
  ).toEqual({ blocked: true, imageBlocked: true });
});

test("teardown rejects pending work and repeated mount remains independent", async ({
  page,
}) => {
  await page.goto("/");
  await expect(
    page.frameLocator("iframe").getByText("Synthetic opportunity summary"),
  ).toBeVisible();
  for (let i = 0; i < 3; i++) {
    const child = page.frames().find((frame) => frame.url().endsWith("/view"))!;
    await child.evaluate(() => {
      (window as any).pendingResult = (window as any).fixture.pending();
    });
    await page.evaluate(() =>
      (window as any).view.contentWindow.postMessage(
        {
          jsonrpc: "2.0",
          id: "teardown",
          method: "ui/resource-teardown",
          params: {},
        },
        "*",
      ),
    );
    expect(await child.evaluate(() => (window as any).pendingResult)).toContain(
      "disposed",
    );
    await page.evaluate(() =>
      (window as any).view.contentWindow.postMessage(
        {
          jsonrpc: "2.0",
          method: "ui/notifications/host-context-changed",
          params: { theme: "dark" },
        },
        "*",
      ),
    );
    expect(
      await child.evaluate(
        () => (window as any).fixture.bridge.snapshot.hostContext,
      ),
    ).toEqual({});
    await page.evaluate(() => {
      (window as any).view.remove();
      (window as any).mount();
    });
    await expect(
      page.frameLocator("iframe").getByText("Synthetic opportunity summary"),
    ).toBeVisible();
  }
});

for (const width of [320, 390]) {
  test(`reference is readable and keyboard navigable at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 720 });
    await page.goto("/");
    const view = page.frameLocator("iframe");
    const child = page.frames().find((frame) => frame.url().endsWith("/view"))!;
    await expect(
      view.getByRole("heading", { name: "Synthetic opportunities" }),
    ).toBeVisible();
    const analyst = view.getByRole("button", {
      name: "Synthetic analyst role",
    });
    await expect(analyst).toBeVisible();
    expect(
      await child.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const bounds = await analyst.boundingBox();
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    await page.keyboard.press("Tab");
    await expect(analyst).toBeFocused();
    await page.keyboard.press("Enter");
    const back = view.getByRole("button", { name: "Back to opportunities" });
    await expect(back).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(
      view.getByRole("link", { name: "Open human review" }),
    ).toBeFocused();
    expect(
      await child.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await expect(analyst).toBeVisible();
  });
}

test("M3 resources preserve digest and deny revoked reads/tools", async ({
  page,
  request,
}) => {
  await page.goto("/");
  await expect(
    page.frameLocator("iframe").getByText("Synthetic opportunity summary"),
  ).toBeVisible();
  const metrics = await (await request.get("/metrics")).json();
  const resource = await request.get("/view");
  const html = await resource.text();
  const { createHash } = await import("node:crypto");
  expect(metrics.descriptor.mimeType).toBe("text/html;profile=mcp-app");
  expect(metrics.descriptor._meta["com.happyvertical.smrt/resource"]).toEqual({
    version: "v1",
    bytes: Buffer.byteLength(html),
    sha256: createHash("sha256").update(html).digest("hex"),
  });
  expect(metrics.descriptor._meta.ui).toEqual({
    csp: {
      connectDomains: [],
      resourceDomains: [],
      frameDomains: [],
      baseUriDomains: [],
    },
    permissions: {},
  });
  expect(resource.headers()["content-security-policy"]).toContain(
    "connect-src 'none'",
  );
  await request.post("/policy", { data: { revoked: true } });
  try {
    expect((await request.get("/view")).status()).toBe(403);
    const child = page.frames().find((frame) => frame.url().endsWith("/view"))!;
    const result = await child.evaluate(() =>
      (window as any).fixture.bridge
        .callTool("opportunity_detail", { id: "synthetic-1" })
        .catch((error: Error) => error.message),
    );
    expect(result).toContain("Forbidden");
  } finally {
    await request.post("/policy", { data: { revoked: false } });
  }
});

test("late superseded detail results cannot replace the current selection", async ({
  page,
}) => {
  await page.goto("/");
  const view = page.frameLocator("iframe");
  await expect(
    view.getByRole("button", { name: "Synthetic analyst role" }),
  ).toBeVisible();
  await page.evaluate(() => {
    (window as any).deferTools = true;
  });
  await view.getByRole("button", { name: "Synthetic analyst role" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).deferred.length))
    .toBe(1);
  await view.getByRole("button", { name: "Synthetic designer role" }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).deferred.length))
    .toBe(2);
  await page.evaluate(() => {
    const latest = (window as any).deferred[1];
    (window as any).view.contentWindow.postMessage(
      { jsonrpc: "2.0", ...latest },
      "*",
    );
  });
  await expect(
    view.getByText("Synthetic role details: synthetic-2.", { exact: false }),
  ).toBeVisible();
  await page.evaluate(() => {
    const old = (window as any).deferred[0];
    (window as any).view.contentWindow.postMessage(
      { jsonrpc: "2.0", ...old },
      "*",
    );
  });
  await expect(
    view.getByText("Synthetic role details: synthetic-2.", { exact: false }),
  ).toBeVisible();
  await expect(
    view.getByText("Synthetic role details: synthetic-1.", { exact: false }),
  ).toHaveCount(0);
  await expect(view.locator("code")).toHaveText(
    "https://example.com/opportunities/synthetic-2/review",
  );
  await view.getByRole("link", { name: "Open human review" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as any).calls
            .filter((c: any) => c.method === "ui/open-link")
            .at(-1)?.params.url,
      ),
    )
    .toBe("https://example.com/opportunities/synthetic-2/review");
});

test("a newly mounted connection ignores prior lifetime response IDs", async ({
  page,
}) => {
  await page.goto("/");
  const view = page.frameLocator("iframe");
  await expect(view.getByText("Synthetic opportunity summary")).toBeVisible();
  await page.evaluate(() => {
    (window as any).oldId = (window as any).calls.find(
      (call: any) => call.method === "tools/call",
    ).id;
    (window as any).view.contentWindow.postMessage(
      {
        jsonrpc: "2.0",
        id: "close",
        method: "ui/resource-teardown",
        params: {},
      },
      "*",
    );
  });
  await expect(view.getByRole("status")).toHaveText("disposed");
  await page.evaluate(() => {
    (window as any).view.remove();
    (window as any).mount();
  });
  await expect(view.getByText("Synthetic opportunity summary")).toBeVisible();
  await page.evaluate(() =>
    (window as any).view.contentWindow.postMessage(
      {
        jsonrpc: "2.0",
        id: (window as any).oldId,
        result: { content: [{ type: "text", text: "STALE LIFETIME" }] },
      },
      "*",
    ),
  );
  await expect(view.getByText("STALE LIFETIME")).toHaveCount(0);
  await view.getByRole("button", { name: "Synthetic analyst role" }).click();
  await expect(
    view.getByText("Synthetic role details: synthetic-1.", { exact: false }),
  ).toBeVisible();
});

test('registered optional extension uses the bound transport and detaches on disposal', async ({ page }) => {
  await page.goto('/');
  await expect(page.frameLocator('iframe').getByText('Synthetic opportunity summary')).toBeVisible();
  await page.evaluate(() => {
    (window as any).view.remove();
    (window as any).mount({ experimental: { 'example/resources': {} } });
    addEventListener('message', (event) => {
      if (event.source !== (window as any).view.contentWindow || event.data.method !== 'example/resources/read') return;
      (window as any).view.contentWindow.postMessage({ jsonrpc: '2.0', id: event.data.id, result: { contents: [{ uri: 'test://fixture', text: 'Extension content' }] } }, '*');
    });
  });
  await expect(page.frameLocator('iframe').getByText('Synthetic opportunity summary')).toBeVisible();
  const child = page.frames().find((frame) => frame.url().endsWith('/view'))!;
  const result = await child.evaluate(async () => {
    const owner = window as any;
    owner.extensionNotifications = [];
    owner.extension = owner.fixture.bridge.registerExtension({ id: 'example.resources', capability: { path: ['experimental', 'example/resources'] }, methods: ['example/resources/read', 'example/resources/hold'], notifications: ['notifications/resources/updated'] });
    owner.extension.subscribe((method: string, params: unknown) => owner.extensionNotifications.push({ method, params }));
    return owner.extension.request('example/resources/read', { uri: 'test://fixture' });
  });
  expect(result).toEqual({ contents: [{ uri: 'test://fixture', text: 'Extension content' }] });
  await page.evaluate(() => (window as any).view.contentWindow.postMessage({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'test://fixture' } }, '*'));
  await expect.poll(() => child.evaluate(() => (window as any).extensionNotifications.length)).toBe(1);
  expect(await child.evaluate(() => (window as any).extension.request('example/resources/unlisted', {}).catch((error: Error) => error.message))).toContain('not registered');
  await child.evaluate(() => {
    const owner = window as any;
    owner.extensionPending = owner.extension.request('example/resources/hold', {}).catch((error: Error) => error.message);
    owner.extension.dispose();
  });
  expect(await child.evaluate(() => (window as any).extensionPending)).toMatch(/cancelled|disposed/);
  await page.evaluate(() => (window as any).view.contentWindow.postMessage({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: 'test://late' } }, '*'));
  expect(await child.evaluate(() => (window as any).extensionNotifications.length)).toBe(1);
});
