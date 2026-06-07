# 6DuckLearn Connector

Local runtime bridge for users connecting a local agent runtime to the hosted 6DuckLearn Agent Console.

Use the hosted MCP server first when your client supports HTTP MCP with OAuth:

```bash
codex mcp add 6ducklearn --url https://6ducklearn.com/mcp
codex mcp login 6ducklearn
```

Use this connector only when you need 6DuckLearn to coordinate a local runtime such as Codex, OpenClaw, or Hermes. For normal hosted MCP setup from GitHub, run:

```bash
npx github:kit18/6ducklearn-mcp setup-codex
```

## Build

```bash
npm install
npm run build
```

## Login

```bash
SIXDUCK_PUBLIC_BASE_URL=https://6ducklearn.com node packages/connector/dist/index.js login
```

The login flow stores a local OAuth session in your home directory. Avoid committing generated session files or copied credentials.

## Run With Codex

```bash
SIXDUCK_RUNTIME_TYPE=codex \
SIXDUCK_CODEX_CWD=/absolute/path/to/your/workspace \
SIXDUCK_CODEX_QUIET_PROFILE=true \
node packages/connector/dist/index.js
```

## Runtime Notes

- Codex uses the Codex app-server bridge.
- OpenClaw support expects either a loopback gateway or an authenticated hosted gateway.
- Hermes support expects a local Hermes API server.

The connector is a client-side bridge only. 6DuckLearn remains the hosted control plane for memory, approvals, runtime health, and user-scoped tool execution.
