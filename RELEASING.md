# Releasing

How to cut a new version of `@spocapp/mcp-bridge` and publish it to both npm and the MCP Registry.

## Prerequisites (one-time)

### npm account with publish rights on `@spocapp`

The `@spocapp` scope is owned by npm user `spoc-app`. To publish, be logged in as a member with publish rights.

**Set up an npm access token with 2FA bypass** — required because plain `npm login` gives a session token that fails at publish time with `E403 Two-factor authentication or granular access token with bypass 2fa enabled is required`.

1. Go to [`npmjs.com/settings/spoc-app/tokens`](https://www.npmjs.com/settings/spoc-app/tokens)
2. Generate New Token → **Granular Access Token**
3. Expiration: 90 days
4. Permission: **Read and write (publish and stage)**
5. Packages and scopes: **Only select** → add scope `@spocapp`
6. **Bypass 2FA: ✅ checked** — the critical field, easy to miss
7. Generate, copy the `npm_...` token
8. Write it to `~/.npmrc`:

```bash
cat > ~/.npmrc <<EOF
registry=https://registry.npmjs.org/
//registry.npmjs.org/:_authToken=<paste-token-here>
EOF
```

Verify only one auth line exists:

```bash
grep _authToken ~/.npmrc | wc -l   # should print 1
npm whoami                          # should print spoc-app
```

### `mcp-publisher` CLI

```bash
brew install mcp-publisher
```

Or download a binary from [modelcontextprotocol/registry releases](https://github.com/modelcontextprotocol/registry/releases/latest).

## Cutting a release

### 1. Bump versions across all three files

`package.json`, `package-lock.json`, and `server.json` must all agree. `server.json` also has a `packages[0].version` that must match.

Ship these via a PR that also updates `CHANGELOG.md`.

### 2. Merge to `main`, then re-clone into a fresh working copy

**Always publish from a fresh clone**, not from your development checkout. Local `node_modules`, `dist/`, or unmerged branches can corrupt the tarball.

```bash
cd /tmp
rm -rf spoc-mcp-bridge-release
git clone https://github.com/SPOC-App/spoc-mcp-bridge.git spoc-mcp-bridge-release
cd spoc-mcp-bridge-release
```

### 3. Tag and push

```bash
git tag v$(node -p "require('./package.json').version")
git push --tags
```

### 4. Build and test

```bash
npm ci
npm run build
npm test
```

All 33 tests should pass.

### 5. Publish to npm

```bash
npm publish --access public
```

Watch the output for `npm warn publish` lines. **Any warning that says "was invalid and removed" is destructive** — npm silently drops the affected field from the published manifest. Fix and re-bump before proceeding.

Expected success line:

```
+ @spocapp/mcp-bridge@X.Y.Z
```

Verify:

```bash
npm view @spocapp/mcp-bridge version   # should print X.Y.Z
```

### 6. Publish to the MCP Registry

The `mcp-publisher` JWT is short-lived (about an hour). If you dawdled after step 5, re-login first.

```bash
mcp-publisher login github     # 8-char code → https://github.com/login/device
mcp-publisher publish
```

Expected success line:

```
Successfully published io.github.SPOC-App/mcp-bridge@X.Y.Z
```

Verify:

```bash
curl -sS "https://registry.modelcontextprotocol.io/v0/servers?search=SPOC-App" | jq '.servers[] | .server | {name, version}'
```

## Rules the registry enforces

The registry verifies you own the identifier you're claiming. Two checks that trip up first-time publishers:

1. **`server.json.name` must match `mcpName` in the published npm `package.json` — exactly, case-sensitive.** GitHub org names preserve case (`SPOC-App`), so both fields must use the same case, and both must match your GitHub OAuth identity's org (`io.github.SPOC-App/*`).
2. **The npm package must already exist** on npm before you run `mcp-publisher publish`. Order matters — always npm first, then registry.

## Field constraints

The registry validates `server.json` against a schema on submit. Constraints that have bitten us:

- `description`: **≤ 100 characters** (both `server.json` and, by convention, `package.json`)
- `name`: matches `^[a-zA-Z0-9._-]+/[a-zA-Z0-9._-]+$` — case-preserved
- `packages[].version`: must exactly match `version` at the server level

Full schema: [`https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json`](https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json)

## Known-good release checklist

Before merging the release PR:

- [ ] `version` matches in `package.json`, `package-lock.json`, `server.json` (server-level), and `server.json` `packages[0].version`
- [ ] `description` is ≤ 100 chars in `server.json`
- [ ] `mcpName` in `package.json` matches `name` in `server.json`, case-sensitive
- [ ] `bin` field in `package.json` has no leading `./` (npm strips it silently)
- [ ] `repository.url` starts with `git+https://` (npm normalises otherwise)
- [ ] `npm run build && npm test` passes locally

After publishing:

- [ ] `npm view @spocapp/mcp-bridge version` returns the new version
- [ ] `curl` against the MCP Registry search endpoint shows the new record with `status: active` and `isLatest: true`
- [ ] Smoke test: `npx -y @spocapp/mcp-bridge@X.Y.Z <<< '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'` returns a valid `initialize` result
