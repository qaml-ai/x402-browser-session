import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { describeRoute, openAPIRouteHandler } from "hono-openapi";
import puppeteer, { type Browser, type Page } from "@cloudflare/puppeteer";

// ---------------------------------------------------------------------------
// Durable Object — holds a puppeteer browser + page for each session
// ---------------------------------------------------------------------------

export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private state: DurableObjectState;
  private env: Env;
  private createdAt: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/launch") return this.launch(request);
      if (path === "/connect") return this.connect();
      if (path === "/navigate") return this.navigate(request);
      if (path === "/click") return this.click(request);
      if (path === "/type") return this.type(request);
      if (path === "/screenshot") return this.screenshot(request);
      if (path === "/text") return this.text();
      if (path === "/close") return this.close();
      return Response.json({ error: "Unknown action" }, { status: 404 });
    } catch (err: any) {
      return Response.json(
        { error: err?.message ?? "Internal error" },
        { status: 500 }
      );
    }
  }

  private async ensureBrowser(): Promise<void> {
    if (!this.browser || !this.browser.isConnected()) {
      this.browser = await puppeteer.launch(this.env.BROWSER);
      this.page = await this.browser.newPage();
    }
  }

  // Return the CDP websocket endpoint so external Playwright/Puppeteer can connect
  private async connect(): Promise<Response> {
    await this.ensureBrowser();
    const wsEndpoint = this.browser!.wsEndpoint();
    return Response.json({
      session_id: this.state.id.toString(),
      ws_endpoint: wsEndpoint,
      created_at: this.createdAt ?? new Date().toISOString(),
      note: "Connect Playwright/Puppeteer to this websocket URL to control the browser directly.",
    });
  }

  private async launch(request: Request): Promise<Response> {
    await this.ensureBrowser();
    this.createdAt = new Date().toISOString();

    let navigatedUrl: string | null = null;
    try {
      const body = await request.json<{ url?: string }>();
      if (body?.url) {
        await this.page!.goto(body.url, { waitUntil: "domcontentloaded" });
        navigatedUrl = body.url;
      }
    } catch {
      // empty body is fine
    }

    return Response.json({
      session_id: this.state.id.toString(),
      created_at: this.createdAt,
      url: navigatedUrl ?? "about:blank",
    });
  }

  private async navigate(request: Request): Promise<Response> {
    if (!this.page) {
      return Response.json({ error: "Session not launched" }, { status: 400 });
    }
    const body = await request.json<{ url: string }>();
    if (!body?.url) {
      return Response.json({ error: "Missing 'url' in body" }, { status: 400 });
    }
    const resp = await this.page.goto(body.url, { waitUntil: "domcontentloaded" });
    const title = await this.page.title();
    return Response.json({
      url: body.url,
      title,
      status: resp?.status() ?? null,
    });
  }

  private async click(request: Request): Promise<Response> {
    if (!this.page) {
      return Response.json({ error: "Session not launched" }, { status: 400 });
    }
    const body = await request.json<{ selector: string }>();
    if (!body?.selector) {
      return Response.json({ error: "Missing 'selector' in body" }, { status: 400 });
    }
    await this.page.click(body.selector);
    return Response.json({ clicked: true, selector: body.selector });
  }

  private async type(request: Request): Promise<Response> {
    if (!this.page) {
      return Response.json({ error: "Session not launched" }, { status: 400 });
    }
    const body = await request.json<{ selector: string; text: string }>();
    if (!body?.selector || body?.text === undefined) {
      return Response.json(
        { error: "Missing 'selector' or 'text' in body" },
        { status: 400 }
      );
    }
    await this.page.type(body.selector, body.text);
    return Response.json({
      typed: true,
      selector: body.selector,
      length: body.text.length,
    });
  }

  private async screenshot(request: Request): Promise<Response> {
    if (!this.page) {
      return Response.json({ error: "Session not launched" }, { status: 400 });
    }

    let selector: string | undefined;
    let fullPage = false;
    try {
      const body = await request.json<{
        selector?: string;
        full_page?: boolean;
      }>();
      selector = body?.selector;
      fullPage = body?.full_page ?? false;
    } catch {
      // empty body is fine — default screenshot
    }

    let screenshot: Buffer | string;
    if (selector) {
      const el = await this.page.$(selector);
      if (!el) {
        return Response.json(
          { error: `Element not found: ${selector}` },
          { status: 404 }
        );
      }
      screenshot = (await el.screenshot()) as Buffer;
    } else {
      screenshot = (await this.page.screenshot({ fullPage })) as Buffer;
    }

    return new Response(screenshot as any, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "no-store",
      },
    });
  }

  private async text(): Promise<Response> {
    if (!this.page) {
      return Response.json({ error: "Session not launched" }, { status: 400 });
    }
    const url = this.page.url();
    const title = await this.page.title();
    const text = await this.page.evaluate(() => document.body.innerText);
    return Response.json({ url, title, text });
  }

  private async close(): Promise<Response> {
    if (this.browser) {
      try {
        await this.browser.close();
      } catch {
        // already closed
      }
      this.browser = null;
      this.page = null;
    }
    return Response.json({ closed: true });
  }
}

// ---------------------------------------------------------------------------
// Hono app — routes that gate on x402 and forward to the Durable Object
// ---------------------------------------------------------------------------

const app = new Hono<{ Bindings: Env }>();

// Helper to get a Durable Object stub by session id
function getSessionStub(env: Env, id: string): DurableObjectStub {
  const doId = env.BROWSER_SESSIONS.idFromString(id);
  return env.BROWSER_SESSIONS.get(doId);
}

// Helper to create a new session id
function newSessionId(env: Env): { id: DurableObjectId; stub: DurableObjectStub } {
  const id = env.BROWSER_SESSIONS.newUniqueId();
  return { id, stub: env.BROWSER_SESSIONS.get(id) };
}

// ---------- OpenAPI spec — must be before paymentMiddleware ----------

app.get("/.well-known/openapi.json", openAPIRouteHandler(app, {
  documentation: {
    info: {
      title: "x402 Browser Session Service",
      description: "Pay-per-action headless browser automation. Create sessions, navigate, click, type, screenshot, and extract text. Pay-per-use via x402 protocol on Base mainnet.",
      version: "1.0.0",
    },
    servers: [{ url: "https://browser.camelai.io" }],
  },
}));

// ---------- x402 payment middleware ----------

app.use(
  cdpPaymentMiddleware(
    (env) => ({
      "POST /session": {
        accepts: [{ scheme: "exact" as const, network: "eip155:8453" as const, payTo: env.SERVER_ADDRESS as `0x${string}`, price: "$0.02" }],
        description:
          "Create a new headless browser session. Optionally navigate to a URL.",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              bodyFields: {
                url: {
                  type: "string",
                  description: "Optional URL to navigate to on launch",
                  required: false,
                },
              },
            },
          },
        },
      },
      "POST /session/raw": {
        accepts: [{ scheme: "exact" as const, network: "eip155:8453" as const, payTo: env.SERVER_ADDRESS as `0x${string}`, price: "$0.05" }],
        description:
          "Create a raw browser session and return the CDP websocket URL. Connect your own Playwright or Puppeteer.",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
          },
        },
      },
      "POST /session/:id/navigate": {
        accepts: [{ scheme: "exact" as const, network: "eip155:8453" as const, payTo: env.SERVER_ADDRESS as `0x${string}`, price: "$0.01" }],
        description: "Navigate the browser session to a URL",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              bodyFields: {
                url: {
                  type: "string",
                  description: "URL to navigate to",
                  required: true,
                },
              },
            },
          },
        },
      },
      "POST /session/:id/click": {
        accepts: [{ scheme: "exact" as const, network: "eip155:8453" as const, payTo: env.SERVER_ADDRESS as `0x${string}`, price: "$0.01" }],
        description: "Click an element on the page by CSS selector",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              bodyFields: {
                selector: {
                  type: "string",
                  description: "CSS selector of the element to click",
                  required: true,
                },
              },
            },
          },
        },
      },
      "POST /session/:id/type": {
        accepts: [{ scheme: "exact" as const, network: "eip155:8453" as const, payTo: env.SERVER_ADDRESS as `0x${string}`, price: "$0.01" }],
        description: "Type text into an input field by CSS selector",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              bodyFields: {
                selector: {
                  type: "string",
                  description: "CSS selector of the input element",
                  required: true,
                },
                text: {
                  type: "string",
                  description: "Text to type into the element",
                  required: true,
                },
              },
            },
          },
        },
      },
      "POST /session/:id/screenshot": {
        accepts: [{ scheme: "exact" as const, network: "eip155:8453" as const, payTo: env.SERVER_ADDRESS as `0x${string}`, price: "$0.01" }],
        description:
          "Take a screenshot of the current page (PNG). Optionally target a selector or capture full page.",
        mimeType: "image/png",
        extensions: {
          bazaar: {
            discoverable: true,
            inputSchema: {
              bodyFields: {
                selector: {
                  type: "string",
                  description:
                    "Optional CSS selector to screenshot a specific element",
                  required: false,
                },
                full_page: {
                  type: "boolean",
                  description: "Capture the full scrollable page (default false)",
                  required: false,
                },
              },
            },
          },
        },
      },
      "GET /session/:id/text": {
        accepts: [{ scheme: "exact" as const, network: "eip155:8453" as const, payTo: env.SERVER_ADDRESS as `0x${string}`, price: "$0.01" }],
        description: "Extract all text content from the current page",
        mimeType: "application/json",
        extensions: {
          bazaar: {
            discoverable: true,
          },
        },
      },
    })
  )
);

// ---------- Route handlers ----------

// Raw CDP session — returns websocket URL for direct Playwright/Puppeteer connection
app.post("/session/raw", describeRoute({
  description: "Create a raw browser session and return the CDP websocket URL. Requires x402 payment ($0.05).",
  responses: {
    200: { description: "CDP websocket info", content: { "application/json": { schema: { type: "object" } } } },
    402: { description: "Payment required" },
  },
}), async (c) => {
  const { id, stub } = newSessionId(c.env);
  const doResp = await stub.fetch("https://do.internal/connect", {
    method: "POST",
  });
  const result = await doResp.json<any>();
  result.session_id = id.toString();
  return c.json(result, doResp.status as any);
});

// Create session
app.post("/session", describeRoute({
  description: "Create a new headless browser session. Optionally navigate to a URL. Requires x402 payment ($0.02).",
  requestBody: {
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            url: { type: "string", description: "Optional URL to navigate to on launch" },
          },
        },
      },
    },
  },
  responses: {
    200: { description: "Session created", content: { "application/json": { schema: { type: "object" } } } },
    402: { description: "Payment required" },
  },
}), async (c) => {
  const { id, stub } = newSessionId(c.env);
  const doUrl = new URL("/launch", "https://do.internal");

  // Forward body to DO
  const doResp = await stub.fetch(doUrl.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: c.req.raw.body,
  });

  const result = await doResp.json<any>();
  // Override session_id with the actual DO id string
  result.session_id = id.toString();
  return c.json(result, doResp.status as any);
});

// Navigate
app.post("/session/:id/navigate", describeRoute({
  description: "Navigate the browser session to a URL. Requires x402 payment ($0.01).",
  requestBody: {
    required: true,
    content: { "application/json": { schema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } } },
  },
  responses: {
    200: { description: "Navigation result", content: { "application/json": { schema: { type: "object" } } } },
    400: { description: "Missing URL" },
    402: { description: "Payment required" },
  },
}), async (c) => {
  const stub = getSessionStub(c.env, c.req.param("id"));
  const doResp = await stub.fetch("https://do.internal/navigate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: c.req.raw.body,
  });
  return new Response(doResp.body, {
    status: doResp.status,
    headers: doResp.headers,
  });
});

// Click
app.post("/session/:id/click", describeRoute({
  description: "Click an element on the page by CSS selector. Requires x402 payment ($0.01).",
  requestBody: {
    required: true,
    content: { "application/json": { schema: { type: "object", required: ["selector"], properties: { selector: { type: "string" } } } } },
  },
  responses: {
    200: { description: "Click result", content: { "application/json": { schema: { type: "object" } } } },
    400: { description: "Missing selector" },
    402: { description: "Payment required" },
  },
}), async (c) => {
  const stub = getSessionStub(c.env, c.req.param("id"));
  const doResp = await stub.fetch("https://do.internal/click", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: c.req.raw.body,
  });
  return new Response(doResp.body, {
    status: doResp.status,
    headers: doResp.headers,
  });
});

// Type
app.post("/session/:id/type", describeRoute({
  description: "Type text into an input field by CSS selector. Requires x402 payment ($0.01).",
  requestBody: {
    required: true,
    content: { "application/json": { schema: { type: "object", required: ["selector", "text"], properties: { selector: { type: "string" }, text: { type: "string" } } } } },
  },
  responses: {
    200: { description: "Type result", content: { "application/json": { schema: { type: "object" } } } },
    400: { description: "Missing selector or text" },
    402: { description: "Payment required" },
  },
}), async (c) => {
  const stub = getSessionStub(c.env, c.req.param("id"));
  const doResp = await stub.fetch("https://do.internal/type", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: c.req.raw.body,
  });
  return new Response(doResp.body, {
    status: doResp.status,
    headers: doResp.headers,
  });
});

// Screenshot
app.post("/session/:id/screenshot", describeRoute({
  description: "Take a screenshot of the current page (PNG). Requires x402 payment ($0.01).",
  requestBody: {
    content: {
      "application/json": {
        schema: {
          type: "object",
          properties: {
            selector: { type: "string", description: "Optional CSS selector to screenshot a specific element" },
            full_page: { type: "boolean", description: "Capture the full scrollable page (default false)" },
          },
        },
      },
    },
  },
  responses: {
    200: { description: "Screenshot PNG image", content: { "image/png": { schema: { type: "string", format: "binary" } } } },
    400: { description: "Session not launched" },
    402: { description: "Payment required" },
  },
}), async (c) => {
  const stub = getSessionStub(c.env, c.req.param("id"));
  const doResp = await stub.fetch("https://do.internal/screenshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: c.req.raw.body,
  });
  return new Response(doResp.body, {
    status: doResp.status,
    headers: doResp.headers,
  });
});

// Text extraction
app.get("/session/:id/text", describeRoute({
  description: "Extract all text content from the current page. Requires x402 payment ($0.01).",
  responses: {
    200: { description: "Page text content", content: { "application/json": { schema: { type: "object" } } } },
    400: { description: "Session not launched" },
    402: { description: "Payment required" },
  },
}), async (c) => {
  const stub = getSessionStub(c.env, c.req.param("id"));
  const doResp = await stub.fetch("https://do.internal/text", {
    method: "GET",
  });
  return new Response(doResp.body, {
    status: doResp.status,
    headers: doResp.headers,
  });
});

// Delete session (free — no payment middleware)
app.delete("/session/:id", describeRoute({
  description: "Close and delete a browser session (free).",
  responses: {
    200: { description: "Session closed", content: { "application/json": { schema: { type: "object" } } } },
  },
}), async (c) => {
  const stub = getSessionStub(c.env, c.req.param("id"));
  const doResp = await stub.fetch("https://do.internal/close", {
    method: "POST",
  });
  const result = await doResp.json();
  return c.json(result);
});

// Health check
app.get("/", describeRoute({
  description: "Health check and service info.",
  responses: {
    200: { description: "Service info", content: { "application/json": { schema: { type: "object" } } } },
  },
}), (c) => {
  return c.json({
    service: "x402-browser-session",
    description:
      "Pay-per-action headless browser automation. Create sessions, navigate, click, type, screenshot, and extract text.",
    endpoints: {
      "POST /session/raw": "$0.05 — get a raw CDP websocket URL (connect your own Playwright/Puppeteer)",
      "POST /session": "$0.02 — create a managed browser session",
      "POST /session/:id/navigate": "$0.01 — navigate to a URL",
      "POST /session/:id/click": "$0.01 — click an element",
      "POST /session/:id/type": "$0.01 — type into an input",
      "POST /session/:id/screenshot": "$0.01 — take a screenshot (PNG)",
      "GET /session/:id/text": "$0.01 — extract page text",
      "DELETE /session/:id": "free — close the session",
    },
    network: "Base mainnet (eip155:8453)",
  });
});

export default app;
