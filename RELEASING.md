# Releasing

## Prerequisites (one-time)

1. **npm org `spocapp`** — already created ([`@spocapp` on npm](https://www.npmjs.com/settings/spocapp/packages)). The `@spoc` scope was taken. To publish, be logged in as a member with publish rights on `spocapp`.
2. **`mcp-publisher` CLI.** On macOS:
   ```bash
   brew install mcp-publisher
   ```
   Or download a binary from [modelcontextprotocol/registry releases](https://github.com/modelcontextprotocol/registry/releases/latest).

## Cutting a release

1. Bump `version` in `package.json` and `package-lock.json`. Also bump `version` and `packages[0].version` in `server.json` to match.
2. Merge the release PR to `main`.
3. Tag and push:
   ```bash
   git checkout main && git pull
   git tag v$(node -p "require('./package.json').version")
   git push --tags
   ```
4. Build:
   ```bash
   npm ci
   npm run build
   npm test
   ```
5. Publish to npm:
   ```bash
   npm login    # interactive, one-time per machine
   npm publish --access public
   ```
6. Verify the package is live: `https://www.npmjs.com/package/@spocapp/mcp-bridge`.
7. Publish to the MCP Registry:
   ```bash
   mcp-publisher login github    # opens a device-code page in your browser
   mcp-publisher publish
   ```
   The registry pulls metadata from `server.json` and verifies ownership of the npm package via the `mcpName` field in `package.json`.
8. Verify the server appears at `https://registry.modelcontextprotocol.io/servers/io.github.spoc-app/mcp-bridge`.

## Why the two-step verification

The MCP Registry only stores metadata. It confirms the metadata really belongs to the person publishing by checking that the npm package's `package.json` contains an `mcpName` field pointing at the same registry name (`io.github.spoc-app/mcp-bridge`). If they don't match, the registry rejects the submission. That's why `mcpName` in `package.json` and `name` in `server.json` must stay in sync across releases.
