# @spocapp/mcp-bridge

Small stdio bridge that lets Claude Desktop, Cursor, Zed, Windsurf and other stdio-only MCP clients talk to the SPOC MCP server at [`spoc.com/mcp/rpc`](https://spoc.com/mcp/rpc).

- **npm:** [`@spocapp/mcp-bridge`](https://www.npmjs.com/package/@spocapp/mcp-bridge)
- **MCP Registry:** [`io.github.SPOC-App/mcp-bridge`](https://registry.modelcontextprotocol.io/v0/servers?search=SPOC-App)
- **Live server:** [`https://spoc.com/mcp/rpc`](https://spoc.com/mcp/rpc) — reports itself as `spoc / 1.27.0`

## What this is (and isn't)

Most current MCP clients only speak the **stdio** transport — JSON-RPC over a subprocess's stdin/stdout. SPOC's MCP server speaks **HTTP+SSE** so it can serve many clients at once. This bridge is the shim between the two: install it, point your MCP client at it, and SPOC's tools appear in the client's tool picker.

It is not a rewrite of the MCP protocol, and it doesn't cache, batch, or reinterpret requests. Every JSON-RPC frame goes through unchanged. If you need behaviour that differs from what the bridge does today, it's usually easier to fix in SPOC itself than in the shim.

## Install

You don't need to install it — most MCP clients will fetch it on demand with `npx`:

```bash
npx -y @spocapp/mcp-bridge
```

Or install it once and point clients at the binary:

```bash
npm install -g @spocapp/mcp-bridge
which spoc-mcp-bridge
```

## Configure your MCP client

### Claude Desktop

Edit the config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "spoc": {
      "command": "npx",
      "args": ["-y", "@spocapp/mcp-bridge"],
      "env": {
        "SPOC_BEARER": "spk_live_..."
      }
    }
  }
}
```

Restart Claude Desktop. SPOC's tools should appear in the tool picker within a few seconds.

### Cursor

`~/.cursor/mcp.json` (or Settings → MCP → Edit `mcp.json`):

```json
{
  "mcpServers": {
    "spoc": {
      "command": "npx",
      "args": ["-y", "@spocapp/mcp-bridge"],
      "env": { "SPOC_BEARER": "spk_live_..." }
    }
  }
}
```

### Zed

`~/.config/zed/settings.json`:

```json
{
  "context_servers": {
    "spoc": {
      "command": {
        "path": "npx",
        "args": ["-y", "@spocapp/mcp-bridge"],
        "env": { "SPOC_BEARER": "spk_live_..." }
      }
    }
  }
}
```

### Windsurf, Continue, etc.

Any client that speaks the MCP stdio transport works the same way. Set the command to `npx -y @spocapp/mcp-bridge` and pass a bearer via environment.

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `SPOC_BEARER` | _(unset)_ | Token sent as `Authorization: Bearer …`. Omit for anonymous access. Required for tools that need a principal (e.g. `spoc.harness.issue`). |
| `SPOC_ENDPOINT` | `https://spoc.com/mcp/rpc` | HTTP JSON-RPC endpoint. |
| `SPOC_EVENTS_ENDPOINT` | `https://spoc.com/mcp/events` | SSE endpoint for server-initiated notifications. |
| `SPOC_TIMEOUT_MS` | `30000` | HTTP request timeout in milliseconds. |
| `SPOC_DISABLE_SSE` | _(unset)_ | Set to `1` to skip the SSE event stream. Notifications become unavailable; everything else still works. |
| `SPOC_DEBUG` | _(unset)_ | Set to `1` to log to stderr. Useful when your MCP client swallows errors silently. |

## Bearer tokens

Generate one at [`https://spoc.com/settings/api-keys`](https://spoc.com/settings/api-keys). Make sure the **`harness:issue`** scope is checked or SPOC will reject calls that need to issue harnesses.

Anonymous access works for read-only tools that don't need a principal. Bearer is only required for tools that act on behalf of an identity.

## Smoke test

Confirm the bridge and the upstream are both healthy:

```bash
npx -y @spocapp/mcp-bridge <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

You should get a single JSON line back that includes `"name":"spoc"` and `"version":"1.27.0"`. If you see that, MCP-aware clients will work.

## Troubleshooting

**Tools don't appear in the client after restart.** Run the smoke test above in a plain terminal. If it returns an error frame, the `error.data` field will tell you why. If it returns nothing at all, check the client's log for a spawn error — the usual cause is `npx` not being on the client's PATH.

**`ERR_INTERNAL` on tool calls.** Almost always an upstream issue rather than a bridge issue. Set `SPOC_DEBUG=1` and re-run — the bridge will log the raw upstream response.

**401 errors.** The bearer token is missing, wrong, or lacks scope. Verify at [`https://spoc.com/settings/api-keys`](https://spoc.com/settings/api-keys).

**SSE won't connect.** Notifications are optional. Set `SPOC_DISABLE_SSE=1` and everything except server-initiated notifications continues to work.

## Testing

```bash
npm ci
npm run build
npm test        # unit + client-integration suites (offline, no network)
```

The **client-integration** suite spawns `spoc-mcp-bridge` as a real subprocess and drives it through the same stdio protocol that Claude Desktop, Cursor, Zed, and Windsurf use — `initialize`, `notifications/initialized`, `tools/list`, `tools/call`, concurrent in-flight calls, mixed-type ids, SSE notifications, upstream errors, and timeouts. If it passes, MCP clients that speak stdio will work.

To also exercise the real production endpoint:

```bash
SPOC_LIVE_TEST=1 npm test                              # anonymous only
SPOC_LIVE_TEST=1 SPOC_BEARER=spk_live_... npm test     # + tools/call
```

CI runs the offline suite on Node 18 / 20 / 22 for every push and PR; the live suite runs on `main` only.

## Writing your own client

If you're implementing SPOC's report-event HMAC signing directly (rather than going through this bridge), one thing to watch out for: SPOC's canonical form matches JavaScript `JSON.stringify` behaviour, which leaves non-ASCII characters as themselves rather than escaping them to `\uXXXX`. Python's default `json.dumps(...)` escapes non-ASCII — you'll get a `bad_signature` 401 the first time you include an em-dash, curly quote, or accented character. Pass `ensure_ascii=False`.

## Links

- [`https://spoc.com`](https://spoc.com) — the underlying service
- [`https://spoc.com/mcp/manifest`](https://spoc.com/mcp/manifest) — the tool catalogue
- [`https://spoc.com/docs/api`](https://spoc.com/docs/api) — the full HTTP API
- [`CHANGELOG.md`](CHANGELOG.md) — release history and what changed between versions
- [`RELEASING.md`](RELEASING.md) — how to cut a new release

## License

MIT
