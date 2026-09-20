import { request } from "undici";
import type {
  BridgeConfig,
  JsonRpcError,
  JsonRpcId,
  JsonRpcRequest,
} from "./types.js";
import { ERR_AUTH, ERR_INTERNAL, ERR_PARSE } from "./types.js";

/**
 * Forward a single JSON-RPC message to the SPOC HTTP endpoint and return the
 * parsed response text (already JSON, ready to write to stdout).
 *
 * Never throws. HTTP / network / parse errors are converted into a well-formed
 * JSON-RPC error response so the client sees a valid frame.
 */
export async function forward(
  raw: string,
  config: BridgeConfig,
): Promise<string> {
  let parsed: JsonRpcRequest | undefined;
  let id: JsonRpcId = null;
  try {
    parsed = JSON.parse(raw) as JsonRpcRequest;
    if (parsed && typeof parsed === "object" && "id" in parsed) {
      id = parsed.id ?? null;
    }
  } catch (e) {
    return JSON.stringify(
      errorResponse(null, ERR_PARSE, "invalid JSON on stdin", {
        reason: (e as Error).message,
      }),
    );
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (config.bearer) {
    headers.authorization = `Bearer ${config.bearer}`;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const res = await request(config.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(parsed),
      signal: controller.signal,
    });
    const body = await res.body.text();

    if (res.statusCode >= 200 && res.statusCode < 300) {
      // Trust the upstream to be valid JSON-RPC. If it isn't, wrap it.
      return normaliseUpstream(body, id);
    }

    if (res.statusCode === 401 || res.statusCode === 403) {
      return JSON.stringify(
        errorResponse(
          id,
          ERR_AUTH,
          "SPOC rejected the bearer token",
          { status: res.statusCode, body: safeTruncate(body) },
        ),
      );
    }

    return JSON.stringify(
      errorResponse(id, ERR_INTERNAL, `SPOC returned HTTP ${res.statusCode}`, {
        status: res.statusCode,
        body: safeTruncate(body),
      }),
    );
  } catch (e) {
    const err = e as Error & { name?: string };
    const reason = err.name === "AbortError" ? "timeout" : err.message;
    return JSON.stringify(
      errorResponse(id, ERR_INTERNAL, "bridge transport error", { reason }),
    );
  } finally {
    clearTimeout(timer);
  }
}

function normaliseUpstream(body: string, id: JsonRpcId): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return JSON.stringify(
      errorResponse(id, ERR_INTERNAL, "SPOC returned empty body"),
    );
  }
  try {
    // Validate it parses; return the original bytes so we don't reformat.
    JSON.parse(trimmed);
    return trimmed;
  } catch (e) {
    return JSON.stringify(
      errorResponse(id, ERR_INTERNAL, "SPOC returned non-JSON body", {
        reason: (e as Error).message,
        body: safeTruncate(trimmed),
      }),
    );
  }
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcError {
  const err: JsonRpcError = {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
  if (data !== undefined) err.error.data = data;
  return err;
}

function safeTruncate(s: string, n = 512): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Read newline-delimited JSON from a readable stream, invoking `handler` for
 * each non-empty line. Resolves when the stream ends.
 */
export async function readLines(
  input: NodeJS.ReadableStream,
  handler: (line: string) => Promise<void>,
): Promise<void> {
  let buf = "";
  input.setEncoding("utf8");
  for await (const chunk of input) {
    buf += chunk as string;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) await handler(line);
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) await handler(tail);
}

export function loadConfig(env: NodeJS.ProcessEnv): BridgeConfig {
  const parsedTimeout = env.SPOC_TIMEOUT_MS
    ? Number.parseInt(env.SPOC_TIMEOUT_MS, 10)
    : Number.NaN;
  return {
    endpoint: env.SPOC_ENDPOINT ?? "https://spoc.com/mcp/rpc",
    eventsEndpoint: env.SPOC_EVENTS_ENDPOINT ?? "https://spoc.com/mcp/events",
    bearer: env.SPOC_BEARER || undefined,
    timeoutMs: Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : 30_000,
    debug: env.SPOC_DEBUG === "1",
    enableSse: env.SPOC_DISABLE_SSE !== "1",
  };
}

export function debug(config: BridgeConfig, ...args: unknown[]): void {
  if (config.debug) {
    // stderr only — stdout is reserved for the MCP protocol.
    // eslint-disable-next-line no-console
    console.error("[spoc-mcp-bridge]", ...args);
  }
}
