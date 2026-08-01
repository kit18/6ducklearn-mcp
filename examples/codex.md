# Codex Setup

Use the hosted 6DuckLearn MCP server:

```bash
npx github:kit18/6ducklearn-mcp setup-codex
```

Manual fallback:

Do not use `codex mcp add` here because current Codex versions can begin OAuth before explicit scopes are supplied. Inspect first with `codex mcp get 6ducklearn --json`: add the full block below when the entry is missing; for a matching entry, keep its server table and add only the missing `http_headers` table; for a different URL or transport, remove it with `codex mcp remove 6ducklearn` and then add the full block.

```toml
[mcp_servers.6ducklearn]
url = "https://6ducklearn.com/mcp"

[mcp_servers.6ducklearn.http_headers]
User-Agent = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36"
```

Start only the explicitly scoped login:

```bash
codex mcp login 6ducklearn --scopes mcp:read,mcp:write
```

Check registration:

```bash
codex mcp get 6ducklearn
```

The local Codex server key should be `6ducklearn`. The official MCP Registry name for the hosted server is `com.6ducklearn/mcp`.
