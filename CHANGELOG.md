# Changelog

All notable changes to `@spocapp/mcp-bridge` are recorded here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.3] — 2026-09-20

First release published to both npm and the MCP Registry. This is the effective first public release; 0.1.1 and 0.1.2 were internal preflight versions that failed publish for reasons captured below.

### Added

- Published to npm as [`@spocapp/mcp-bridge`](https://www.npmjs.com/package/@spocapp/mcp-bridge)
- Registered on the [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=SPOC-App) as `io.github.SPOC-App/mcp-bridge`
- `CHANGELOG.md` (this file)

### Changed

- `server.json`: `name` field now uses correct GitHub-org case (`io.github.SPOC-App/mcp-bridge`, not `spoc-app`). The registry ownership check is case-sensitive.
- `package.json`: `mcpName` field aligned to the same mixed case.
- `server.json` and `package.json`: `description` trimmed to 70 characters. The registry rejects descriptions over 100.

## [0.1.2] — 2026-09-20 (npm only, superseded)

Fixed two publish-time issues detected by npm's own normalizer on 0.1.1.

### Fixed

- `package.json`: `bin.spoc-mcp-bridge` now `"dist/cli.js"` instead of `"./dist/cli.js"`. npm 10 silently drops the entire `bin` entry when it sees a leading `./`, which would have shipped the package with no CLI entry point.
- `package.json`: `repository.url` prefixed with `git+` per npm convention.

## [0.1.1] — 2026-09-20 (never landed, publish blocked)

Attempted to publish under scope `@spoc`, then `@spocapp` after `@spoc` was found taken. Publish blocked by the two `bin`/`repository.url` issues fixed in 0.1.2.

### Added

- MCP Registry metadata: `mcpName` in `package.json` and matching `server.json`
- `RELEASING.md` runbook

### Changed

- Package scope: `@spoc` → `@spocapp`. The `@spoc` scope was already registered by a different user on npm.

## [0.1.0] — 2026-09-20 (development only)

Initial implementation of the stdio ↔ HTTP+SSE bridge. Not published.

### Added

- Bridge core (`src/bridge.ts`): pumps JSON-RPC frames between stdin/stdout and the upstream HTTP endpoint
- SSE handler (`src/sse.ts`): subscribes to server-initiated notifications and forwards them to the client
- CLI entry (`src/cli.ts`): loads env, wires the bridge, handles graceful shutdown
- Environment configuration: `SPOC_BEARER`, `SPOC_ENDPOINT`, `SPOC_EVENTS_ENDPOINT`, `SPOC_TIMEOUT_MS`, `SPOC_DISABLE_SSE`, `SPOC_DEBUG`
- Test suite: 33 tests across unit, CLI, and client-integration coverage. Client-integration spawns the bridge as a subprocess and drives it through the same stdio protocol Claude Desktop, Cursor, Zed, and Windsurf use.
- Live-endpoint smoke tests (opt-in via `SPOC_LIVE_TEST=1`) that hit `https://spoc.com/mcp/rpc` directly
- GitHub Actions CI: offline suite on Node 18 / 20 / 22 per push; live suite on `main` only
- Documentation: `README.md`, `LICENSE` (MIT)

### Known behaviours (preserved deliberately, pinned by tests)

- **Notifications write a response frame.** The bridge forwards `notifications/*` to the upstream server AND writes the response back to the client. That's a spec deviation — notifications are meant to be one-way — but the current test suite pins the behaviour with a `<= 1 responses` assertion so future changes need to be intentional.
- **SSE only forwards `event: notification`.** The SSE handler drops plain `data:` events, heartbeats, and comments. Only frames explicitly labelled `event: notification` reach the client.
- **Empty `SPOC_BEARER` becomes undefined.** An empty string in the environment is treated the same as an unset variable. Useful when clients pass through empty env values.
