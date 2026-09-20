import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { existsSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = resolve(__dirname, "..", "dist", "cli.js");

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      // Echo id back with a fake tools/list result.
      const parsed = JSON.parse(body || "{}");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id ?? null,
          result: { tools: [{ name: "spoc.echo" }] },
        }),
      );
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runCli(input: string, env: Record<string, string>): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    if (!existsSync(CLI_PATH)) {
      reject(new Error(`dist/cli.js missing — run \`npm run build\` first`));
      return;
    }
    const child = spawn("node", [CLI_PATH], {
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, code }));
    child.stdin.write(input);
    child.stdin.end();
  });
}

describe("cli", () => {
  it("forwards a request to the mock endpoint and prints the response to stdout", async () => {
    const req = JSON.stringify({
      jsonrpc: "2.0",
      id: 42,
      method: "tools/list",
    });
    const { stdout, stderr, code } = await runCli(`${req}\n`, {
      SPOC_ENDPOINT: `${baseUrl}/rpc`,
      SPOC_EVENTS_ENDPOINT: `${baseUrl}/events`,
      SPOC_DISABLE_SSE: "1",
    });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const lines = stdout.trim().split("\n").filter(Boolean);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.id).toBe(42);
    expect(parsed.result.tools[0].name).toBe("spoc.echo");
  });

  it("emits debug output on stderr when SPOC_DEBUG=1", async () => {
    const req = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const { stderr, code } = await runCli(`${req}\n`, {
      SPOC_ENDPOINT: `${baseUrl}/rpc`,
      SPOC_DISABLE_SSE: "1",
      SPOC_DEBUG: "1",
    });
    expect(code).toBe(0);
    expect(stderr).toContain("[spoc-mcp-bridge]");
  });

  it("exits 0 on EOF with no input", async () => {
    const { stdout, code } = await runCli("", {
      SPOC_ENDPOINT: `${baseUrl}/rpc`,
      SPOC_DISABLE_SSE: "1",
    });
    expect(code).toBe(0);
    expect(stdout).toBe("");
  });
});
