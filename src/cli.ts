#!/usr/bin/env node
import { debug, forward, loadConfig, readLines } from "./bridge.js";
import { startSse } from "./sse.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  debug(config, "starting", {
    endpoint: config.endpoint,
    events: config.eventsEndpoint,
    bearer: config.bearer ? "set" : "none",
    sse: config.enableSse,
  });

  const sse = config.enableSse
    ? startSse(config, (payload) => {
        // Write notification to stdout, single line.
        process.stdout.write(`${JSON.stringify(payload)}\n`);
      })
    : null;

  const shutdown = (code: number): void => {
    if (sse) sse.stop();
    process.exit(code);
  };
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  process.on("uncaughtException", (e) => {
    // eslint-disable-next-line no-console
    console.error("[spoc-mcp-bridge] uncaught:", e);
    shutdown(1);
  });

  await readLines(process.stdin, async (line) => {
    const out = await forward(line, config);
    process.stdout.write(`${out}\n`);
  });

  if (sse) sse.stop();
  process.exit(0);
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("[spoc-mcp-bridge] fatal:", e);
  process.exit(1);
});
