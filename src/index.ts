import { Hono } from "hono";
import { cdpPaymentMiddleware } from "x402-cdp";
import { stripeApiKeyMiddleware } from "x402-stripe";
import { extractParams } from "x402-ai";
import { openapiFromMiddleware } from "x402-openapi";
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

const SYSTEM_PROMPT = `You are a parameter extractor for a headless browser automation service.
Extract the following from the user's message and return JSON:
- "action": one of "create", "navigate", "screenshot", "click", "type", "close". Default "create". (required)
- "url": URL to navigate to. Used for "create" (optional) and "navigate" (required). (optional)
- "selector": CSS selector for "click" or "type" actions. (optional)
- "text": text to type for "type" action. (optional)
- "session_id": the session ID for existing sessions. Required for all actions except "create". (optional)

Return ONLY valid JSON, no explanation.
Examples:
- {"action": "create", "url": "https://example.com"}
- {"action": "navigate", "session_id": "abc123", "url": "https://google.com"}
- {"action": "screenshot", "session_id": "abc123"}
- {"action": "click", "session_id": "abc123", "selector": "#submit-button"}
- {"action": "type", "session_id": "abc123", "selector": "#search", "text": "hello world"}
- {"action": "close", "session_id": "abc123"}`;

const ROUTES = {
  "POST /": {
    accepts: [
      { scheme: "exact", price: "$0.02", network: "eip155:8453", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.02", network: "eip155:137", payTo: "0x0" as `0x${string}` },
      { scheme: "exact", price: "$0.02", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "CvraJ4avKPpJNLvMhMH5ip2ihdt85PXvDwfzXdziUxRq" },
    ],
    description: "Control a headless browser session. Send {\"input\": \"your request\"}",
    mimeType: "application/json",
    extensions: {
      bazaar: {
        info: {
          input: {
            type: "http",
            method: "POST",
            bodyType: "json",
            body: {
              input: { type: "string", description: "Describe what you want: create a session, navigate, screenshot, click, type, or close", required: true },
            },
          },
          output: { type: "json" },
        },
        schema: {
          properties: {
            input: {
              properties: { method: { type: "string", enum: ["POST"] } },
              required: ["method"],
            },
          },
        },
      },
    },
  },
};

app.use(stripeApiKeyMiddleware({ serviceName: "browser-session" }));

app.use(async (c, next) => {
  if (c.get("skipX402")) return next();
  return cdpPaymentMiddleware((env) => ({
    "POST /": { ...ROUTES["POST /"], accepts: ROUTES["POST /"].accepts.map((a: any) => ({ ...a, payTo: a.network.startsWith("solana") ? a.payTo : env.SERVER_ADDRESS as `0x${string}` })) },
    "POST /session": {
      accepts: [
        { scheme: "exact", price: "$0.02", network: "eip155:8453", payTo: env.SERVER_ADDRESS as `0x${string}` },
        { scheme: "exact", price: "$0.02", network: "eip155:137", payTo: env.SERVER_ADDRESS as `0x${string}` },
        { scheme: "exact", price: "$0.02", network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "CvraJ4avKPpJNLvMhMH5ip2ihdt85PXvDwfzXdziUxRq" },
      ],
      description: "Create a browser session and get a CDP websocket endpoint. No input needed — just pay and connect with Puppeteer/Playwright.",
      mimeType: "application/json",
    },
  }))(c, next);
});

// Create a session — no input, just returns CDP websocket endpoint
app.post("/session", async (c) => {
  const { id, stub } = newSessionId(c.env);
  const doResp = await stub.fetch("https://do.internal/launch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const launch = await doResp.json<any>();

  // Get the CDP websocket endpoint
  const connectResp = await stub.fetch("https://do.internal/connect", { method: "POST" });
  const connect = await connectResp.json<any>();

  return c.json({
    session_id: id.toString(),
    created_at: launch.created_at,
    ws_endpoint: connect.ws_endpoint,
  });
});

app.post("/", async (c) => {
  const body = await c.req.json<{ input?: string }>();
  if (!body?.input) {
    return c.json({ error: "Missing 'input' field" }, 400);
  }

  const params = await extractParams(c.env.CF_GATEWAY_TOKEN, SYSTEM_PROMPT, body.input);
  const action = ((params.action as string) || "create").toLowerCase();

  if (action === "create") {
    const { id, stub } = newSessionId(c.env);
    const doUrl = new URL("/launch", "https://do.internal");
    const launchBody: Record<string, unknown> = {};
    if (params.url) launchBody.url = params.url;

    const doResp = await stub.fetch(doUrl.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(launchBody),
    });

    const result = await doResp.json<any>();
    result.session_id = id.toString();
    return c.json(result, doResp.status as any);
  }

  // All other actions require session_id
  const sessionId = params.session_id as string;
  if (!sessionId) {
    return c.json({ error: "Could not determine session_id for this action" }, 400);
  }

  const stub = getSessionStub(c.env, sessionId);

  if (action === "navigate") {
    if (!params.url) {
      return c.json({ error: "Could not determine URL to navigate to" }, 400);
    }
    const doResp = await stub.fetch("https://do.internal/navigate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: params.url }),
    });
    return new Response(doResp.body, { status: doResp.status, headers: doResp.headers });
  }

  if (action === "screenshot") {
    const screenshotBody: Record<string, unknown> = {};
    if (params.selector) screenshotBody.selector = params.selector;
    const doResp = await stub.fetch("https://do.internal/screenshot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(screenshotBody),
    });
    return new Response(doResp.body, { status: doResp.status, headers: doResp.headers });
  }

  if (action === "click") {
    if (!params.selector) {
      return c.json({ error: "Could not determine selector to click" }, 400);
    }
    const doResp = await stub.fetch("https://do.internal/click", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selector: params.selector }),
    });
    return new Response(doResp.body, { status: doResp.status, headers: doResp.headers });
  }

  if (action === "type") {
    if (!params.selector || !params.text) {
      return c.json({ error: "Could not determine selector and/or text to type" }, 400);
    }
    const doResp = await stub.fetch("https://do.internal/type", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selector: params.selector, text: params.text }),
    });
    return new Response(doResp.body, { status: doResp.status, headers: doResp.headers });
  }

  if (action === "close") {
    const doResp = await stub.fetch("https://do.internal/close", { method: "POST" });
    const result = await doResp.json();
    return c.json(result);
  }

  return c.json({ error: `Unknown action: ${action}` }, 400);
});

// Delete session (free — no payment middleware)
app.delete("/session/:id", async (c) => {
  const stub = getSessionStub(c.env, c.req.param("id"));
  const doResp = await stub.fetch("https://do.internal/close", { method: "POST" });
  const result = await doResp.json();
  return c.json(result);
});

app.get("/.well-known/openapi.json", openapiFromMiddleware("x402 Browser Session", "browser.camelai.io", ROUTES));

app.get("/", (c) => {
  return c.json({
    service: "x402-browser-session",
    description: 'Pay-per-action headless browser automation. Send POST / with {"input": "create a browser session and navigate to https://example.com"}',
    price: "$0.02 per request (Base mainnet)",
    endpoints: {
      "POST /session": "$0.02 — create a session, returns CDP websocket endpoint for Puppeteer/Playwright",
      "POST /": "$0.02 — natural language actions (navigate, screenshot, click, type, close)",
      "DELETE /session/:id": "free — close the session",
    },
  });
});

export default app;
