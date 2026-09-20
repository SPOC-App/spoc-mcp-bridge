import { request } from "undici";
import type { BridgeConfig } from "./types.js";
import { debug } from "./bridge.js";

/**
 * Minimal SSE subscriber for /mcp/events. Emits parsed `event: notification`
 * payloads (JSON) to `onNotification`. Reconnects with exponential backoff.
 *
 * `stop()` cancels the current connection and prevents further reconnects.
 */
export interface SseHandle {
  stop(): void;
}

export function startSse(
  config: BridgeConfig,
  onNotification: (payload: unknown) => void,
): SseHandle {
  let stopped = false;
  let controller: AbortController | null = null;
  let backoffMs = 1_000;

  const loop = async (): Promise<void> => {
    while (!stopped) {
      controller = new AbortController();
      try {
        const headers: Record<string, string> = { accept: "text/event-stream" };
        if (config.bearer) headers.authorization = `Bearer ${config.bearer}`;

        const res = await request(config.eventsEndpoint, {
          method: "GET",
          headers,
          signal: controller.signal,
        });

        if (res.statusCode < 200 || res.statusCode >= 300) {
          debug(config, `SSE HTTP ${res.statusCode}, backing off`);
          await sleep(backoffMs);
          backoffMs = Math.min(backoffMs * 2, 30_000);
          continue;
        }

        backoffMs = 1_000; // reset on successful connect
        let buf = "";
        let currentEvent = "message";
        const dataLines: string[] = [];

        res.body.setEncoding("utf8");
        for await (const chunk of res.body) {
          if (stopped) break;
          buf += chunk as string;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).replace(/\r$/, "");
            buf = buf.slice(nl + 1);
            if (line === "") {
              // dispatch
              if (dataLines.length > 0 && currentEvent === "notification") {
                const data = dataLines.join("\n");
                try {
                  onNotification(JSON.parse(data));
                } catch (e) {
                  debug(config, "SSE JSON parse failed:", (e as Error).message);
                }
              }
              currentEvent = "message";
              dataLines.length = 0;
              continue;
            }
            if (line.startsWith(":")) continue; // comment / heartbeat
            const idx = line.indexOf(":");
            const field = idx === -1 ? line : line.slice(0, idx);
            const value = idx === -1
              ? ""
              : line.slice(idx + 1).replace(/^ /, "");
            if (field === "event") currentEvent = value;
            else if (field === "data") dataLines.push(value);
          }
        }
        debug(config, "SSE stream ended, reconnecting");
      } catch (e) {
        if (stopped) return;
        debug(config, "SSE error:", (e as Error).message);
      }
      if (stopped) return;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    }
  };

  loop().catch((e) => debug(config, "SSE loop crashed:", (e as Error).message));

  return {
    stop(): void {
      stopped = true;
      if (controller) controller.abort();
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
