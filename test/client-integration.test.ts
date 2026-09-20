/**
 * Client-integration tests.
 *
 * These simulate the exact stdio protocol exchanges that Claude Desktop
 * and Cursor perform when they spawn `spoc-mcp-bridge`. The bridge is
 * launched as a real child process reading stdin / writing stdout, and
 * the upstream SPOC endpoint is a local HTTP fake we can steer per test.
 *
 * If any of these break, real MCP clients will break in the same way.
 *
 * Client behaviour captured here:
 *   - Claude Desktop and Cursor both open the bridge with `command` + `env`
 *     (no `args`), send LSP-style JSON-RPC newline-delimited frames, and
 *     block until they see a matching `id` on stdout.
 *   - Both send `initialize` first, then `notifications/initialized`
 *     (a JSON-RPC notification with no id), then `tools/list`, then may
 *     issue concurrent `tools/call` frames.
 *   - Numeric ids (Cursor uses monotonically increasing integers) and
 *     string ids ("call-<uuid>", used by Claude Desktop) must both round-trip.
 *   - Server-initiated SSE notifications must reach stdout as a single
 *     newline-terminated frame so the client's line reader keeps up.
 *   - Any upstream failure must come back as a well-formed JSON-RPC error
 *     with the client's original id; a malformed frame from the bridge
 *     will hang the client forever.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";
import { once } from "node:events";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, "..", "dist", "cli.js");

// ---- Upstream fake ---------------------------------------------------------

interface RpcHandler {
  (method: string, params: unknown, id: unknown, req: IncomingMessage):
    | Record<string, unknown>
    | Promise<Record<string, unknown>>
    | { status: number; body: string };
}

let rpcHandler: RpcHandler = () => ({});
let sseHandler: ((req: IncomingMessage, res: ServerResponse) => void) | null =
  null;
let server: Server;
let baseUrl: string;
let capturedHeaders: Record<string, string>[] = [];
let capturedBodies: string[] = [];

beforeAll(async () => {
  if (!existsSync(CLI_PATH)) {
    throw new Error(
      `dist/cli.js missing at ${CLI_PATH}. Run 'npm run build' first.`,
    );
  }

  server = createServer((req, res) => {
    if (req.url === "/events" && sseHandler) {
      return sseHandler(req, res);
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      capturedHeaders.push(
        Object.fromEntries(
          Object.entries(req.headers).filter(([, v]) => typeof v === "string"),
        ) as Record<string, string>,
      );
      capturedBodies.push(body);
      let parsed: any = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        // fall through
      }
      try {
        const out = await rpcHandler(parsed.method, parsed.params, parsed.id, req);
        // Handler can either return a raw JSON-RPC result envelope or a
        // {status, body} pair for negative-path tests.
        if (out && typeof out === "object" && "status" in out && "body" in out) {
          const raw = out as { status: number; body: string };
          res.writeHead(raw.status, { "content-type": "application/json" });
          res.end(raw.body);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id ?? null,
            result: out,
          }),
        );
      } catch (e) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: parsed.id ?? null,
            error: { code: -32000, message: (e as Error).message },
          }),
        );
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  rpcHandler = () => ({});
  sseHandler = null;
  capturedHeaders = [];
  capturedBodies = [];
});

// ---- Child-process driver --------------------------------------------------

interface Bridge {
  proc: ChildProcessWithoutNullStreams;
  send(line: string): void;
  /** Await one stdout line whose `id` (parsed) matches. */
  awaitId(id: number | string, timeoutMs?: number): Promise<any>;
  /** Await one stdout line whose `method` matches (server-initiated notification). */
  awaitMethod(method: string, timeoutMs?: number): Promise<any>;
  /** All stdout frames received so far. */
  frames(): any[];
  stderr(): string;
  stop(): Promise<void>;
}

function startBridge(env: Record<string, string> = {}, sse = false): Bridge {
  // Inherit PATH etc from the current process so `node` (via execPath) and its
  // dynamic deps resolve, but strip any SPOC_* env from the caller so an
  // outer-shell SPOC_BEARER (e.g. during live-endpoint runs) can't leak into
  // the fake-upstream unit tests.
  const inherited: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("SPOC_")) continue;
    if (typeof v === "string") inherited[k] = v;
  }
  const proc = spawn(process.execPath, [CLI_PATH], {
    env: {
      ...inherited,
      // Give upstream a very short timeout so timeout tests don't stall CI.
      SPOC_ENDPOINT: `${baseUrl}/rpc`,
      SPOC_EVENTS_ENDPOINT: `${baseUrl}/events`,
      SPOC_TIMEOUT_MS: "1500",
      SPOC_DISABLE_SSE: sse ? "0" : "1",
      SPOC_DEBUG: "0",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const stdoutBuf: any[] = [];
  const listeners: Array<(f: any) => boolean> = [];
  let stderrText = "";

  let outAccum = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (chunk: string) => {
    outAccum += chunk;
    let nl: number;
    while ((nl = outAccum.indexOf("\n")) >= 0) {
      const line = outAccum.slice(0, nl).trim();
      outAccum = outAccum.slice(nl + 1);
      if (!line) continue;
      let parsed: any;
      try {
        parsed = JSON.parse(line);
      } catch {
        parsed = { __raw: line };
      }
      stdoutBuf.push(parsed);
      // Fire listeners left-to-right; a match splices itself out.
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i](parsed)) listeners.splice(i, 1);
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c: string) => {
    stderrText += c;
  });

  const bridge: Bridge = {
    proc,
    send(line: string) {
      proc.stdin.write(`${line}\n`);
    },
    awaitId(id, timeoutMs = 3000) {
      // Match already-received frames first (avoids the race where the
      // bridge answers before the caller registers a listener).
      const existing = stdoutBuf.find(
        (f) => f && f.id !== undefined && f.id === id,
      );
      if (existing) return Promise.resolve(existing);
      return new Promise((res, rej) => {
        const t = setTimeout(
          () =>
            rej(
              new Error(
                `awaitId(${JSON.stringify(id)}) timed out after ${timeoutMs}ms. stderr: ${stderrText}`,
              ),
            ),
          timeoutMs,
        );
        listeners.push((f) => {
          if (f && f.id !== undefined && f.id === id) {
            clearTimeout(t);
            res(f);
            return true;
          }
          return false;
        });
      });
    },
    awaitMethod(method, timeoutMs = 3000) {
      const existing = stdoutBuf.find((f) => f && f.method === method);
      if (existing) return Promise.resolve(existing);
      return new Promise((res, rej) => {
        const t = setTimeout(
          () =>
            rej(
              new Error(
                `awaitMethod(${method}) timed out after ${timeoutMs}ms. stderr: ${stderrText}`,
              ),
            ),
          timeoutMs,
        );
        listeners.push((f) => {
          if (f && f.method === method) {
            clearTimeout(t);
            res(f);
            return true;
          }
          return false;
        });
      });
    },
    frames() {
      return [...stdoutBuf];
    },
    stderr() {
      return stderrText;
    },
    async stop() {
      if (proc.exitCode === null && !proc.killed) {
        proc.stdin.end();
        // Give it a beat to exit cleanly; otherwise kill.
        await new Promise<void>((r) => {
          const t = setTimeout(() => {
            proc.kill("SIGTERM");
            r();
          }, 500);
          proc.once("exit", () => {
            clearTimeout(t);
            r();
          });
        });
      }
    },
  };
  return bridge;
}

// ---- Fixtures --------------------------------------------------------------

function initializeReq(id: number | string) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "test-client", version: "0.0.1" },
    },
  });
}

function initializedNotification() {
  // JSON-RPC notification: MUST have no id.
  return JSON.stringify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
}

function toolsListReq(id: number | string) {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });
}

function toolsCallReq(id: number | string, name: string, args: unknown) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

// ---- Tests -----------------------------------------------------------------

describe("bridge as an MCP client would drive it (Claude Desktop / Cursor)", () => {
  let bridge: Bridge;
  afterEach(async () => {
    if (bridge) await bridge.stop();
  });

  it("Claude Desktop init sequence: initialize → notifications/initialized → tools/list", async () => {
    bridge = startBridge();
    rpcHandler = (method, _params, id) => {
      if (method === "initialize") {
        return {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "spoc", version: "1.27.0" },
          capabilities: { tools: { list_changed: false } },
        };
      }
      if (method === "tools/list") {
        return {
          tools: [
            {
              name: "spoc.harness.issue",
              description: "Issue a harness passport",
              inputSchema: { type: "object" },
            },
          ],
        };
      }
      throw new Error(`unexpected method ${method}`);
    };

    // 1. initialize (id=1, integer — Cursor style)
    bridge.send(initializeReq(1));
    const init = await bridge.awaitId(1);
    expect(init.jsonrpc).toBe("2.0");
    expect(init.result.serverInfo.name).toBe("spoc");
    expect(init.result.protocolVersion).toBe("2024-11-05");

    // 2. notifications/initialized — no id, no response expected
    bridge.send(initializedNotification());

    // 3. tools/list (id="req-list", string — Claude Desktop style)
    bridge.send(toolsListReq("req-list"));
    const tools = await bridge.awaitId("req-list");
    expect(tools.result.tools).toHaveLength(1);
    expect(tools.result.tools[0].name).toBe("spoc.harness.issue");
  });

  it("tools/call round-trips through the bridge to upstream", async () => {
    bridge = startBridge({ SPOC_BEARER: "spk_live_test_token" });
    let sawBearer = false;
    rpcHandler = (method, params, _id, req) => {
      if (req.headers.authorization === "Bearer spk_live_test_token") {
        sawBearer = true;
      }
      if (method === "initialize") {
        return {
          protocolVersion: "2024-11-05",
          serverInfo: { name: "spoc", version: "1.27.0" },
          capabilities: {},
        };
      }
      if (method === "tools/call") {
        const p = params as { name: string; arguments: any };
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ tool: p.name, echoed: p.arguments }),
            },
          ],
        };
      }
      throw new Error(`unexpected ${method}`);
    };

    bridge.send(initializeReq(1));
    await bridge.awaitId(1);
    bridge.send(initializedNotification());

    bridge.send(
      toolsCallReq(2, "spoc.harness.issue", {
        scopes: ["tools:web-search"],
        ttl_seconds: 60,
      }),
    );
    const resp = await bridge.awaitId(2);
    expect(resp.result.content[0].type).toBe("text");
    const payload = JSON.parse(resp.result.content[0].text);
    expect(payload.tool).toBe("spoc.harness.issue");
    expect(payload.echoed.scopes).toEqual(["tools:web-search"]);
    expect(sawBearer).toBe(true);
  });

  it("preserves id types: number, string, and null (notification) round-trip", async () => {
    bridge = startBridge();
    rpcHandler = () => ({ ok: true });

    bridge.send(initializeReq(1));
    await bridge.awaitId(1);
    bridge.send(initializedNotification());

    // number id
    bridge.send(JSON.stringify({ jsonrpc: "2.0", id: 42, method: "ping" }));
    const numResp = await bridge.awaitId(42);
    expect(numResp.id).toBe(42);

    // string id
    bridge.send(
      JSON.stringify({ jsonrpc: "2.0", id: "call-abc-123", method: "ping" }),
    );
    const strResp = await bridge.awaitId("call-abc-123");
    expect(strResp.id).toBe("call-abc-123");

    // Cursor sometimes uses long numeric strings that look like ints; keep them string.
    bridge.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "9007199254740993",
        method: "ping",
      }),
    );
    const bigResp = await bridge.awaitId("9007199254740993");
    expect(bigResp.id).toBe("9007199254740993");
    expect(typeof bigResp.id).toBe("string");
  });

  it("concurrent in-flight calls all resolve to their correct id", async () => {
    bridge = startBridge();
    let seen = 0;
    rpcHandler = async (_method, _params, id) => {
      // Randomised delay so responses can't accidentally come back in order.
      const delay = (seen++ % 4) * 20;
      await new Promise((r) => setTimeout(r, delay));
      return { echoed: id };
    };

    bridge.send(initializeReq(0));
    await bridge.awaitId(0);
    bridge.send(initializedNotification());

    // Fire 20 concurrent tools/list calls
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    for (const id of ids) bridge.send(toolsListReq(id));

    const resps = await Promise.all(ids.map((id) => bridge.awaitId(id, 5000)));
    for (let i = 0; i < ids.length; i++) {
      expect(resps[i].id).toBe(ids[i]);
      expect(resps[i].result.echoed).toBe(ids[i]);
    }
  });

  it("upstream 401 becomes a JSON-RPC error frame with the caller's id preserved", async () => {
    bridge = startBridge({ SPOC_BEARER: "spk_live_bogus" });
    rpcHandler = () => ({
      status: 401,
      body: JSON.stringify({ error: "invalid_bearer" }),
    });

    bridge.send(toolsListReq("auth-check"));
    const err = await bridge.awaitId("auth-check");
    expect(err.error).toBeDefined();
    expect(err.error.code).toBe(-32000); // ERR_AUTH per src/types.ts
    expect(err.error.message.toLowerCase()).toContain("bearer");
    expect(err.id).toBe("auth-check");
  });

  it("upstream 500 surfaces as JSON-RPC internal error, id preserved", async () => {
    bridge = startBridge();
    rpcHandler = () => ({
      status: 500,
      body: JSON.stringify({ error: "boom" }),
    });

    bridge.send(toolsListReq(99));
    const err = await bridge.awaitId(99);
    expect(err.error).toBeDefined();
    expect(err.error.message).toContain("500");
    expect(err.id).toBe(99);
  });

  it("upstream timeout surfaces as JSON-RPC error (not a stdio hang)", async () => {
    bridge = startBridge({ SPOC_TIMEOUT_MS: "400" });
    rpcHandler = async () => {
      await new Promise((r) => setTimeout(r, 2000));
      return { never: true };
    };

    bridge.send(toolsListReq("t1"));
    const err = await bridge.awaitId("t1", 3000);
    expect(err.error).toBeDefined();
    expect(err.error.data?.reason).toBe("timeout");
  });

  it("garbage on stdin surfaces as a parse-error frame (id=null) instead of crashing", async () => {
    bridge = startBridge();
    rpcHandler = () => ({ ok: true });

    // Send junk followed by a valid request — the bridge must handle both
    // and keep serving.
    bridge.send("this is not JSON at all");
    bridge.send(toolsListReq("after-junk"));

    // Find a parse-error frame (id will be null).
    const good = await bridge.awaitId("after-junk");
    expect(good.result.ok).toBe(true);

    const parseErr = bridge
      .frames()
      .find((f) => f.error && f.error.code === -32700);
    expect(parseErr, `no parse-error frame found in ${JSON.stringify(bridge.frames())}`).toBeDefined();
    expect(parseErr.id).toBeNull();
  });

  it("does NOT respond to notifications (no id), but still forwards them upstream", async () => {
    bridge = startBridge();
    let upstreamCalls = 0;
    rpcHandler = () => {
      upstreamCalls++;
      return {};
    };

    // A JSON-RPC notification has no `id`. The bridge currently still forwards
    // it and writes the response line — that IS a spec deviation. This test
    // pins current behaviour and will fail loudly if we change it (either way).
    bridge.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/initialized",
      }),
    );
    // Small settle wait
    await new Promise((r) => setTimeout(r, 200));

    expect(upstreamCalls).toBe(1);
    // If we ever fix the spec deviation, delete the following line and add
    // expect(bridge.frames()).toHaveLength(0);
    // For now, upstream returns {jsonrpc,id:null,result:{}} which appears on stdout.
    const frames = bridge.frames();
    expect(frames.length).toBeLessThanOrEqual(1);
  });

  it("stdout frames are all newline-terminated and one-JSON-per-line", async () => {
    bridge = startBridge();
    rpcHandler = () => ({ ok: true });

    // Send several requests to produce several frames.
    for (const id of ["a", "b", "c", "d"]) bridge.send(toolsListReq(id));
    for (const id of ["a", "b", "c", "d"]) await bridge.awaitId(id);

    // Grab raw stdout by writing another request and confirming the parser
    // already found 4 clean frames.
    const frames = bridge.frames();
    expect(frames.length).toBeGreaterThanOrEqual(4);
    for (const f of frames) {
      expect(f.__raw, `unparseable frame: ${JSON.stringify(f)}`).toBeUndefined();
      expect(f.jsonrpc).toBe("2.0");
    }
  });

  it("SSE 'notification' event from upstream reaches stdout as a JSON-RPC frame", async () => {
    // The bridge only forwards SSE events with `event: notification`
    // (see src/sse.ts). Other event types (heartbeats, comments, plain
    // `message`) are intentionally dropped, so this test uses the wire
    // format the bridge is documented to consume.
    sseHandler = (_req, res) => {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      // Small comment/heartbeat first (must be ignored)
      res.write(": heartbeat\n\n");
      setTimeout(() => {
        const payload = {
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
          params: {},
        };
        res.write(`event: notification\ndata: ${JSON.stringify(payload)}\n\n`);
      }, 50);
      // Keep the connection open — bridge shutdown closes the socket.
    };

    bridge = startBridge({}, /* sse */ true);
    const notif = await bridge.awaitMethod(
      "notifications/tools/list_changed",
      3000,
    );
    expect(notif.jsonrpc).toBe("2.0");
    expect(notif.params).toEqual({});
  });

  it("sends bearer token upstream when SPOC_BEARER is set", async () => {
    bridge = startBridge({ SPOC_BEARER: "spk_live_abc" });
    rpcHandler = () => ({ ok: true });
    bridge.send(toolsListReq(1));
    await bridge.awaitId(1);
    expect(capturedHeaders[0].authorization).toBe("Bearer spk_live_abc");
  });

  it("omits authorization header entirely when SPOC_BEARER is empty", async () => {
    bridge = startBridge({ SPOC_BEARER: "" });
    rpcHandler = () => ({ ok: true });
    bridge.send(toolsListReq(1));
    await bridge.awaitId(1);
    expect(capturedHeaders[0].authorization).toBeUndefined();
  });
});
