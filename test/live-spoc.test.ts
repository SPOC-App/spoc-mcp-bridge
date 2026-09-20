/**
 * Live-endpoint smoke tests against https://spoc.com/mcp/rpc.
 *
 * These skip unless SPOC_LIVE_TEST=1 is set, so `npm test` in a clean
 * clone doesn't hit prod. Set the bearer token via SPOC_BEARER to also
 * exercise authenticated paths.
 *
 * Purpose: catch schema drift between this bridge and production SPOC.
 * The unit-level bridge tests use a local fake and cannot notice that
 * upstream renamed a field or changed a status code.
 *
 * Run:
 *   SPOC_LIVE_TEST=1 npm test
 *   SPOC_LIVE_TEST=1 SPOC_BEARER=spk_live_... npm test
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, "..", "dist", "cli.js");
const LIVE = process.env.SPOC_LIVE_TEST === "1";
const BEARER = process.env.SPOC_BEARER;

const describeLive = LIVE ? describe : describe.skip;

// Minimal reuse of the child-process driver — kept local so this file can
// be run standalone and doesn't couple to the client-integration file.

interface Bridge {
  proc: ChildProcessWithoutNullStreams;
  send(line: string): void;
  awaitId(id: number | string, timeoutMs?: number): Promise<any>;
  stop(): Promise<void>;
  stderr(): string;
}

function startBridge(env: Record<string, string> = {}): Bridge {
  const proc = spawn(process.execPath, [CLI_PATH], {
    env: {
      ...process.env,
      SPOC_ENDPOINT: "https://spoc.com/mcp/rpc",
      SPOC_EVENTS_ENDPOINT: "https://spoc.com/mcp/events",
      SPOC_DISABLE_SSE: "1",
      SPOC_TIMEOUT_MS: "15000",
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const buf: any[] = [];
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
      buf.push(parsed);
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i](parsed)) listeners.splice(i, 1);
      }
    }
  });
  proc.stderr.setEncoding("utf8");
  proc.stderr.on("data", (c: string) => {
    stderrText += c;
  });

  return {
    proc,
    send(line) {
      proc.stdin.write(`${line}\n`);
    },
    awaitId(id, timeoutMs = 20_000) {
      const existing = buf.find((f) => f && f.id === id);
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
          if (f && f.id === id) {
            clearTimeout(t);
            res(f);
            return true;
          }
          return false;
        });
      });
    },
    stderr() {
      return stderrText;
    },
    async stop() {
      if (proc.exitCode === null && !proc.killed) {
        proc.stdin.end();
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
}

describeLive("live SPOC endpoint (SPOC_LIVE_TEST=1)", () => {
  let bridge: Bridge;
  beforeAll(() => {
    if (!existsSync(CLI_PATH)) {
      throw new Error(`dist/cli.js missing. Run 'npm run build' first.`);
    }
  });
  afterAll(async () => {
    if (bridge) await bridge.stop();
  });

  it("initialize returns SPOC serverInfo and known protocol version", async () => {
    bridge = startBridge();
    bridge.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: "init-live",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "spoc-mcp-bridge-live-test", version: "0.1.0" },
        },
      }),
    );
    const resp = await bridge.awaitId("init-live");
    expect(resp.error, `initialize failed: ${JSON.stringify(resp.error)}`).toBeUndefined();
    expect(resp.result.serverInfo.name).toBe("spoc");
    expect(resp.result.protocolVersion).toBe("2024-11-05");
    // SPOC v1.27.x baseline — this catches upstream downgrades.
    expect(resp.result.serverInfo.version).toMatch(/^1\.\d+\.\d+/);
  });

  it("tools/list exposes at least spoc.harness.issue with a valid schema", async () => {
    bridge = startBridge();
    bridge.send(
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    );
    const resp = await bridge.awaitId(1);
    expect(resp.error, `tools/list failed: ${JSON.stringify(resp.error)}`).toBeUndefined();
    const tools = resp.result.tools as any[];
    expect(Array.isArray(tools)).toBe(true);
    const issue = tools.find((t) => t.name === "spoc.harness.issue");
    expect(issue, "spoc.harness.issue not exposed").toBeDefined();
    expect(issue.inputSchema).toBeDefined();
    expect(issue.inputSchema.required).toContain("scopes");
  });

  const describeAuth = BEARER ? describe : describe.skip;

  describeAuth("authenticated (SPOC_BEARER set)", () => {
    it("tools/call spoc.harness.issue mints a real principal-linked passport", async () => {
      bridge = startBridge({ SPOC_BEARER: BEARER! });
      bridge.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: "issue-1",
          method: "tools/call",
          params: {
            name: "spoc.harness.issue",
            arguments: {
              scopes: ["tools:test"],
              ttl_seconds: 60,
              purpose:
                "integration test from spoc-mcp-bridge — end-to-end handshake check.",
            },
          },
        }),
      );
      const resp = await bridge.awaitId("issue-1");
      expect(resp.error, `issue failed: ${JSON.stringify(resp.error)}`).toBeUndefined();
      const text = resp.result.content?.[0]?.text;
      expect(text, "no content[0].text in result").toBeDefined();
      const payload = JSON.parse(text);
      expect(payload.harness_id).toMatch(/^hrn_/);
      expect(payload.reporting_key).toMatch(/^[0-9a-f]+$/);
      expect(payload.trust_tier).toBeDefined();
    });
  });
});
