# @spoc/mcp-bridge

A ~200-line stdio ↔ HTTP+SSE bridge for the SPOC MCP server.

Claude Desktop, Cursor, Zed, Windsurf and most other MCP clients today only speak the **stdio** transport (JSON-RPC over stdin/stdout). SPOC's MCP server at `https://spoc.com/mcp/rpc` speaks **HTTP+SSE**. This bridge is the shim between the two: install it, point your MCP client at it, and SPOC's tools show up.

## Install

Coming to npm shortly. For now:

```bash
git clone https://github.com/SPOC-App/spoc-mcp-bridge.git
cd spoc-mcp-bridge
npm install
npm run build
npm link
```

Once released:

```bash
npm install -g @spoc/mcp-bridge
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
      "command": "spoc-mcp-bridge",
      "env": {
        "SPOC_BEARER": "spk_live_...",
        "SPOC_ENDPOINT": "https://spoc.com/mcp/rpc"
      }
    }
  }
}
```

Restart Claude Desktop. SPOC's tools should appear in the tool picker.

### Cursor

`~/.cursor/mcp.json` (or Settings → MCP → Edit `mcp.json`):

```json
{
  "mcpServers": {
    "spoc": {
      "command": "spoc-mcp-bridge",
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
        "path": "spoc-mcp-bridge",
        "args": [],
        "env": { "SPOC_BEARER": "spk_live_..." }
      }
    }
  }
}
```

## Environment variables

| Variable | Default | Notes |
|---|---|---|
| `SPOC_ENDPOINT` | `https://spoc.com/mcp/rpc` | HTTP JSON-RPC endpoint |
| `SPOC_EVENTS_ENDPOINT` | `https://spoc.com/mcp/events` | SSE endpoint for server-initiated notifications |
| `SPOC_BEARER` | _(unset)_ | Token to send as `Authorization: Bearer …`. Omit for anonymous access |
| `SPOC_TIMEOUT_MS` | `30000` | HTTP request timeout |
| `SPOC_DEBUG` | _(unset)_ | Set to `1` to log to stderr |
| `SPOC_DISABLE_SSE` | _(unset)_ | Set to `1` to skip the SSE event stream |

## Bearer tokens

Generate one at [`https://spoc.com/settings/api-keys`](https://spoc.com/settings/api-keys). Make sure the **`harness:issue`** scope is checked or SPOC will reject calls that need to issue harnesses.

## Troubleshooting

**Tools don't appear in Claude / Cursor / Zed after restart.**
Run `spoc-mcp-bridge` directly in a terminal and pipe a request in:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | spoc-mcp-bridge
```

You should see a JSON response listing every tool. If you get a JSON-RPC error frame, the `error.data` field will tell you why.

**401 errors.**
The bearer token is missing, wrong, or lacks scope. Verify at [`https://spoc.com/settings/api-keys`](https://spoc.com/settings/api-keys).

**SSE won't connect.**
Notifications are optional. Set `SPOC_DISABLE_SSE=1` and everything except server-initiated notifications will still work. If you want to debug, set `SPOC_DEBUG=1` and watch stderr.

## Writing your own client

If you're implementing SPOC's report-event HMAC signing directly (rather than going through this bridge), one thing to watch out for: SPOC's canonical form matches JavaScript `JSON.stringify` behaviour, which leaves non-ASCII characters as themselves rather than escaping them to `\uXXXX`. Python's default `json.dumps(...)` escapes non-ASCII — you'll get a `bad_signature` 401 the first time you include an em-dash, curly quote, or accented character. Pass `ensure_ascii=False`.

## Links

- [`https://spoc.com`](https://spoc.com) — the underlying service
- [`https://spoc.com/mcp/manifest`](https://spoc.com/mcp/manifest) — the tool catalogue
- [`https://spoc.com/docs/api`](https://spoc.com/docs/api) — the full HTTP API

## License

MIT
