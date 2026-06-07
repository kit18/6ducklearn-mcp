# Codex Setup

Use the hosted 6DuckLearn MCP server:

```bash
npx github:kit18/6ducklearn-mcp setup-codex
```

Manual fallback:

```bash
codex mcp add 6ducklearn --url https://6ducklearn.com/mcp
codex mcp login 6ducklearn
```

Check registration:

```bash
codex mcp get 6ducklearn
```

The local Codex server key should be `6ducklearn`. The official MCP Registry name for the hosted server is `com.6ducklearn/mcp`.
