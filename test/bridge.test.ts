import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { AddressInfo } from "node:net";
import { forward, loadConfig, readLines } from "../src/bridge.js";
import type { BridgeConfig } from "../src/types.js";
import { ERR_AUTH, ERR_INTERNAL, ERR_PARSE } from "../src/types.js";
import { Readable } from "node:stream";

interface Handler {
  status: number;
  body: string | (() => string | Promise<string>);
  delayMs?: number;
  capture?: (req: IncomingMessage, body: string) => void;
}

let server: Server;
let baseUrl: string;
let handler: Handler = { status: 200, body: "{}" };

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      handler.capture?.(req, body);
      const wait = handler.delayMs ?? 0;
      const send = async (): Promise<void> => {
        const raw = handler.body;
        const b = typeof raw === "function" ? await raw() : raw;
        res.writeHead(handler.status, { "content-type": "application/json" });
        res.end(b);
      };
      if (wait > 0) setTimeout(send, wait);
      else await send();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

afterEach(() => {
  handler = { status: 200, body: "{}" };
});

function cfg(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    endpoint: `${baseUrl}/rpc`,
    eventsEndpoint: `${baseUrl}/events`,
    bearer: undefined,
    timeoutMs: 2_000,
    debug: false,
    enableSse: false,
    ...overrides,
  };
}

describe("forward()", () => {
  it("passes a 200 JSON response through unchanged", async () => {
    handler = {
      status: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    };
    const out = await forward(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      cfg(),
    );
    const parsed = JSON.parse(out);
    expect(parsed.result).toEqual({ ok: true });
    expect(parsed.id).toBe(1);
  });

  it("maps 401 upstream to JSON-RPC error -32000", async () => {
    handler = { status: 401, body: "unauthorized" };
    const out = await forward(
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }),
      cfg(),
    );
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe(ERR_AUTH);
    expect(parsed.id).toBe(2);
    expect(parsed.error.data.status).toBe(401);
  });

  it("maps 403 upstream to JSON-RPC error -32000", async () => {
    handler = { status: 403, body: "forbidden" };
    const out = await forward(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "ping" }),
      cfg(),
    );
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe(ERR_AUTH);
  });

  it("maps 500 upstream to JSON-RPC error -32603", async () => {
    handler = { status: 500, body: "boom" };
    const out = await forward(
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "ping" }),
      cfg(),
    );
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe(ERR_INTERNAL);
    expect(parsed.id).toBe(4);
  });

  it("timeout is reported with error.data.reason='timeout'", async () => {
    handler = { status: 200, body: "{}", delayMs: 500 };
    const out = await forward(
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "slow" }),
      cfg({ timeoutMs: 50 }),
    );
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe(ERR_INTERNAL);
    expect(parsed.error.data.reason).toBe("timeout");
  });

  it("forwards Authorization header when bearer is set", async () => {
    let seenAuth: string | undefined;
    handler = {
      status: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 6, result: null }),
      capture: (req) => {
        seenAuth = req.headers.authorization;
      },
    };
    await forward(
      JSON.stringify({ jsonrpc: "2.0", id: 6, method: "ping" }),
      cfg({ bearer: "spk_test_abc" }),
    );
    expect(seenAuth).toBe("Bearer spk_test_abc");
  });

  it("omits Authorization header when bearer is unset", async () => {
    let seenAuth: string | undefined = "unset-sentinel";
    handler = {
      status: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 7, result: null }),
      capture: (req) => {
        seenAuth = req.headers.authorization;
      },
    };
    await forward(
      JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" }),
      cfg(),
    );
    expect(seenAuth).toBeUndefined();
  });

  it("returns a parse error frame when stdin is not JSON", async () => {
    const out = await forward("not json{{{", cfg());
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe(ERR_PARSE);
    expect(parsed.id).toBeNull();
  });

  it("preserves the request id in error frames", async () => {
    handler = { status: 500, body: "boom" };
    const out = await forward(
      JSON.stringify({ jsonrpc: "2.0", id: "abc-123", method: "x" }),
      cfg(),
    );
    expect(JSON.parse(out).id).toBe("abc-123");
  });

  it("wraps a non-JSON 200 body in an internal error", async () => {
    handler = { status: 200, body: "not-json" };
    const out = await forward(
      JSON.stringify({ jsonrpc: "2.0", id: 8, method: "x" }),
      cfg(),
    );
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe(ERR_INTERNAL);
    expect(parsed.error.message).toMatch(/non-JSON/);
  });

  it("wraps an empty 200 body in an internal error", async () => {
    handler = { status: 200, body: "" };
    const out = await forward(
      JSON.stringify({ jsonrpc: "2.0", id: 9, method: "x" }),
      cfg(),
    );
    const parsed = JSON.parse(out);
    expect(parsed.error.code).toBe(ERR_INTERNAL);
    expect(parsed.error.message).toMatch(/empty/);
  });

  it("posts the request body verbatim to the endpoint", async () => {
    let seenBody = "";
    handler = {
      status: 200,
      body: JSON.stringify({ jsonrpc: "2.0", id: 10, result: null }),
      capture: (_req, body) => {
        seenBody = body;
      },
    };
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/list",
    });
    await forward(payload, cfg());
    expect(JSON.parse(seenBody)).toEqual(JSON.parse(payload));
  });
});

describe("loadConfig()", () => {
  it("applies defaults when env is empty", () => {
    const c = loadConfig({});
    expect(c.endpoint).toBe("https://spoc.com/mcp/rpc");
    expect(c.eventsEndpoint).toBe("https://spoc.com/mcp/events");
    expect(c.bearer).toBeUndefined();
    expect(c.timeoutMs).toBe(30_000);
    expect(c.debug).toBe(false);
    expect(c.enableSse).toBe(true);
  });

  it("reads env overrides", () => {
    const c = loadConfig({
      SPOC_ENDPOINT: "https://example.test/rpc",
      SPOC_EVENTS_ENDPOINT: "https://example.test/events",
      SPOC_BEARER: "spk_x",
      SPOC_TIMEOUT_MS: "1234",
      SPOC_DEBUG: "1",
      SPOC_DISABLE_SSE: "1",
    });
    expect(c.endpoint).toBe("https://example.test/rpc");
    expect(c.eventsEndpoint).toBe("https://example.test/events");
    expect(c.bearer).toBe("spk_x");
    expect(c.timeoutMs).toBe(1234);
    expect(c.debug).toBe(true);
    expect(c.enableSse).toBe(false);
  });

  it("falls back to default when SPOC_TIMEOUT_MS is malformed", () => {
    const c = loadConfig({ SPOC_TIMEOUT_MS: "nonsense" });
    expect(c.timeoutMs).toBe(30_000);
  });
});

describe("readLines()", () => {
  it("splits newline-delimited input and skips blanks", async () => {
    const stream = Readable.from(["line1\n", "line", "2\n\n", "line3\n"]);
    const seen: string[] = [];
    await readLines(stream, async (l) => {
      seen.push(l);
    });
    expect(seen).toEqual(["line1", "line2", "line3"]);
  });

  it("emits a final line without trailing newline", async () => {
    const stream = Readable.from(["only-line"]);
    const seen: string[] = [];
    await readLines(stream, async (l) => {
      seen.push(l);
    });
    expect(seen).toEqual(["only-line"]);
  });
});
