# 6DuckLearn MCP

Official public setup docs and local connector package for the hosted 6DuckLearn MCP server.

The public MCP server name is `6ducklearn` and the hosted endpoint is:

```text
https://6ducklearn.com/mcp
```

This repository is intentionally hosted-first. It does not contain the private 6DuckLearn SaaS backend, Supabase edge functions, service-role database access, billing logic, user memory store, or production deployment scripts.

## Quick Start

### Codex

```bash
codex mcp add 6ducklearn --url https://6ducklearn.com/mcp
codex mcp login 6ducklearn
```

### Claude Code

```bash
claude mcp add --transport http 6ducklearn https://6ducklearn.com/mcp
```

Then open the MCP tool picker in Claude Code and authorize 6DuckLearn when prompted.

## Hosted MCP Identity

- server key: `6ducklearn`
- title: `6DuckLearn MCP`
- MCP URL: `https://6ducklearn.com/mcp`
- OAuth discovery: `https://6ducklearn.com/.well-known/oauth-authorization-server`
- protected resource metadata: `https://6ducklearn.com/.well-known/oauth-protected-resource/mcp`

The hosted server uses OAuth scopes such as `mcp:read`, `mcp:write`, `runtime:connect`, `control:read`, and approval-related scopes. Write-capable and sensitive actions remain controlled by 6DuckLearn policy and user approval.

## Local Connector

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

## What Is Public Here

- hosted MCP setup instructions
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

Validation runs TypeScript build, connector tests, package dry-run, hosted MCP smoke checks, and a public-release secret scan.

## Security

Report security issues privately. See [SECURITY.md](./SECURITY.md).

## License

Code is licensed under Apache-2.0. Documentation examples are licensed under CC BY 4.0. See [TRADEMARK.md](./TRADEMARK.md) for 6DuckLearn brand usage.

