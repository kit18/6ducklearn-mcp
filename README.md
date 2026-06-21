# 6DuckLearn MCP

Official public setup docs, registry metadata, and local connector package for the hosted 6DuckLearn MCP server.

Use `6ducklearn` as the local client key in Codex or Claude Code. The official MCP Registry name is `com.6ducklearn/mcp`, and the hosted endpoint is:

```text
https://6ducklearn.com/mcp
```

This repository is intentionally hosted-first. It does not contain the private 6DuckLearn SaaS backend, Supabase edge functions, service-role database access, billing logic, user memory store, or production deployment scripts.

## Quick Start

### Codex

From GitHub:

```bash
npx github:kit18/6ducklearn-mcp setup-codex
```

This configures the hosted 6DuckLearn MCP server in local Codex and starts the OAuth login flow.
If a `6ducklearn` entry already exists, the setup command refreshes it first so old local or stdio bridge settings do not linger.

Manual fallback:

```bash
codex mcp remove 6ducklearn # ignore if missing
codex mcp add 6ducklearn --url https://6ducklearn.com/mcp
codex mcp login 6ducklearn
```

### Claude Code

```bash
claude mcp add --transport http 6ducklearn https://6ducklearn.com/mcp
```

Then open the MCP tool picker in Claude Code and authorize 6DuckLearn when prompted.

### npm Package Status

The npm packages `@6ducklearn/mcp` and `@6ducklearn/connector` are not published yet. Until npm publication is available, use the GitHub `npx` command above for copy/paste setup.

## Hosted MCP Identity

- local client key: `6ducklearn`
- MCP Registry name: `com.6ducklearn/mcp`
- title: `6DuckLearn MCP`
- MCP URL: `https://6ducklearn.com/mcp`
- OAuth discovery: `https://6ducklearn.com/.well-known/oauth-authorization-server`
- protected resource metadata: `https://6ducklearn.com/.well-known/oauth-protected-resource/mcp`

The hosted server uses OAuth scopes such as `mcp:read`, `mcp:write`, `runtime:connect`, `control:read`, and approval-related scopes. Write-capable and sensitive actions remain controlled by 6DuckLearn policy and user approval.

## What Agents Can Do

6DuckLearn MCP gives connected agents account-authorized workflows for research, organization, reminders, portfolio review, knowledge retrieval, canvas creation, and Skill Builder discovery.

For the full public catalog, see [MCP tool use cases](./docs/tool-use-cases.md). The catalog describes each tool by practical use case and example prompt without exposing private schemas or backend implementation details.

Finance-related capabilities are for research, organization, summaries, alerts, and user-authorized workflows. 6DuckLearn MCP is not an order-routing service or source of investment recommendations.

## Advanced: Local Runtime Connector

The connector is for users who want a local runtime bridge between 6DuckLearn and local agents such as Codex, OpenClaw, or Hermes. The preferred setup path is OAuth from the 6DuckLearn web app.

```bash
npm install
npm run build
SIXDUCK_PUBLIC_BASE_URL=https://6ducklearn.com node packages/connector/dist/index.js login
```

After login, keep the connector process running when using a local runtime:

```bash
SIXDUCK_RUNTIME_TYPE=codex \
SIXDUCK_CODEX_CWD=/absolute/path/to/your/workspace \
SIXDUCK_CODEX_QUIET_PROFILE=true \
node packages/connector/dist/index.js
```

Most users should start from the hosted 6DuckLearn setup page rather than cloning this repository directly.

## MCP Registry Publication

The official registry manifest lives in [`server.json`](./server.json). It is a hosted-only listing because the canonical 6DuckLearn MCP server runs at `https://6ducklearn.com/mcp`; the local connector is a runtime bridge, not a standalone stdio MCP server package.

Before publishing, validate the manifest and hosted endpoint:

```bash
npm run validate:registry
npm run smoke:hosted
```

Publish with domain-based authentication so the registry name can stay under the 6DuckLearn domain namespace:

```bash
# After generating the proof key and serving /.well-known/mcp-registry-auth:
mcp-publisher login http --domain 6ducklearn.com --algorithm ecdsap384 --private-key "$PRIVATE_KEY"
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=com.6ducklearn/mcp"
```

The required HTTP proof must be served from `https://6ducklearn.com/.well-known/mcp-registry-auth`. After the official MCP Registry lists `com.6ducklearn/mcp`, request GitHub MCP Registry inclusion by emailing `partnerships@github.com` with the registry name, official registry URL, GitHub repository, website, hosted endpoint, and validation evidence. GitHub's MCP Registry is a separate curated surface, so listing there currently requires GitHub review rather than relying on automatic community registry sync.

## What Is Public Here

- hosted MCP setup instructions
- official MCP Registry manifest
- sanitized client examples
- local connector source and tests
- live hosted endpoint smoke checks
- secret scans that prevent private SaaS details from entering this public repo

## What Stays Private

- 6DuckLearn SaaS application source
- production Supabase functions and migrations
- service-role database patterns
- user memory, PKM, billing, approval trails, and runtime health data
- internal release scripts and production deploy credentials

## Development

```bash
npm install
npm run validate
```

Validation runs TypeScript build, connector tests, package dry-run, MCP Registry manifest checks, hosted MCP smoke checks, and a public-release secret scan.

## Security

Report security issues privately. See [SECURITY.md](./SECURITY.md).

## License

Code is licensed under Apache-2.0. Documentation examples are licensed under CC BY 4.0. See [TRADEMARK.md](./TRADEMARK.md) for 6DuckLearn brand usage.
